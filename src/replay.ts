// Honest baseline replay against REAL Binance candles, now reporting results
// BOTH gross and NET of real trading costs. No invented candles, no seeded
// losses, no staged failure. If the strategy only works before fees, this
// says so plainly — that's the whole point.

import { fetchHistoricalCandles } from "./market";
import { detectEntryEvents, atrFraction } from "./strategy";
import { ReplayTrade, RiskConfig } from "./types";
import { STRATEGY_CONFIG, RISK_CONFIG, COST_CONFIG, SETUP_KEY } from "./bot";
import { appendLedgerRow, appendLearning } from "./memory";
import { assertPaperMode } from "./guardrails";
import { runBacktest, significance, checkConfigViability } from "./backtest";

const TOTAL_CANDLES = Number(process.env.REPLAY_CANDLES ?? 2000); // ~7 days of 5m candles
const FORWARD_CANDLES = Number(process.env.REPLAY_FORWARD ?? 12); // ~1 hour forward window

// Scale stop/target to the timeframe's actual volatility instead of a fixed
// 1%/2%. Essential when testing anything other than 5m — a 1% stop is ~27x ATR
// on 5m candles and only 0.4x ATR on daily ones, so fixed percentages compare
// completely different strategies to each other.
const USE_ATR_RISK = (process.env.USE_ATR_RISK ?? "false").toLowerCase() === "true";
const ATR_STOP_MULT = Number(process.env.ATR_STOP_MULT ?? 1.5);
const ATR_TARGET_MULT = Number(process.env.ATR_TARGET_MULT ?? 3);

function pct(v: number): string {
  return (v * 100).toFixed(2) + "%";
}

async function main() {
  assertPaperMode();

  console.log(`[${new Date().toISOString()}] Fetching ${TOTAL_CANDLES} real historical ${STRATEGY_CONFIG.symbol} candles (${STRATEGY_CONFIG.interval}) from Binance...`);
  const candles = await fetchHistoricalCandles(STRATEGY_CONFIG.symbol, STRATEGY_CONFIG.interval, TOTAL_CANDLES);
  console.log(`Loaded ${candles.length} real candles (${new Date(candles[0].openTime).toISOString()} to ${new Date(candles[candles.length - 1].closeTime).toISOString()})`);

  const events = detectEntryEvents(candles, STRATEGY_CONFIG);
  const bullish = events.filter((c) => c.type === "bullish");
  console.log(`Strategy: ${STRATEGY_CONFIG.strategyType}. Detected ${events.length} signal events (${bullish.length} entry setups) — long-only.`);

  const atr = atrFraction(candles, 14);
  const risk: RiskConfig = USE_ATR_RISK
    ? { ...RISK_CONFIG, stopLossPct: atr * ATR_STOP_MULT, takeProfitPct: atr * ATR_TARGET_MULT }
    : RISK_CONFIG;

  if (USE_ATR_RISK) {
    console.log(`ATR-scaled risk: ATR is ${pct(atr)} on this timeframe -> stop ${pct(risk.stopLossPct)}, target ${pct(risk.takeProfitPct)}`);
  } else {
    console.log(`Fixed risk: stop ${pct(risk.stopLossPct)}, target ${pct(risk.takeProfitPct)} (set USE_ATR_RISK=true to scale these to the timeframe)`);
  }

  const viability = checkConfigViability(risk.takeProfitPct, risk.stopLossPct, COST_CONFIG);
  if (viability.warning) {
    console.log(`\n${viability.viable ? "WARNING" : "ERROR"}: ${viability.warning}`);
  }
  if (!viability.viable) {
    console.log(`\nStopping — running this would produce numbers that look like a finding but aren't one.`);
    process.exit(1);
  }

  const { trades, summary } = runBacktest(candles, bullish.map((e) => e.index), FORWARD_CANDLES, risk, COST_CONFIG);

  if (trades.length === 0) {
    console.log("No entry setups with enough forward data were found in this window.");
    console.log("Try increasing REPLAY_CANDLES, or check that the symbol/interval have enough real data.");
    return;
  }

  console.log(`\nCosts applied: ${pct(COST_CONFIG.feePctPerSide)} fee + ${pct(COST_CONFIG.slippagePctPerSide)} slippage per side = ${pct(summary.roundTripCostPct)} per round trip.`);
  console.log("\nTrade-by-trade results:");
  console.log("entryTime".padEnd(24), "entry".padEnd(11), "exit".padEnd(11), "outcome".padEnd(9), "gross".padEnd(9), "net");
  for (const t of trades) {
    console.log(
      new Date(t.entryTime).toISOString().padEnd(24),
      t.entryPrice.toFixed(2).padEnd(11),
      t.exitPrice.toFixed(2).padEnd(11),
      t.outcome.padEnd(9),
      pct(t.pnlPct).padEnd(9),
      pct(t.netPnlPct)
    );
  }

  const sig = significance(trades);

  console.log("\nSummary:");
  console.log(`  Total setups tested: ${summary.totalSetups}${summary.skippedNoForwardData ? ` (${summary.skippedNoForwardData} too recent for a full forward window)` : ""}`);
  console.log(`  GROSS avg per trade (price move only): ${pct(summary.avgGrossPct)}`);
  console.log(`  Round-trip cost per trade:             ${pct(-summary.roundTripCostPct)}`);
  console.log(`  NET avg per trade (what you'd keep):   ${pct(summary.avgNetPct)}`);
  console.log(`  Net wins: ${summary.winsNet}  Net losses: ${summary.lossesNet}  Net win rate: ${(summary.winRateNet * 100).toFixed(1)}%`);
  console.log(`  Best net trade: ${pct(summary.bestNetPct)}   Worst net trade: ${pct(summary.worstNetPct)}`);
  console.log(`  Total net over the window: ${pct(summary.totalNetPct)}`);
  console.log(`  Max drawdown (net, sequential): ${pct(summary.maxDrawdownNetPct)}`);

  console.log("\nIs this result meaningful?");
  console.log(`  ${sig.verdict}`);
  console.log(`  (standard error of mean net return: ±${sig.stdErrPct.toFixed(3)}% per trade over ${trades.length} trades)`);

  console.log("\nVerdict for real-money use:");
  if (summary.avgNetPct <= 0) {
    console.log(`  NOT VIABLE in this window. After costs the strategy loses ${pct(Math.abs(summary.avgNetPct))} per trade on average.`);
    console.log(`  Trading this live would convert the spread between gross and net into fees paid to the exchange.`);
  } else if (Math.abs(sig.tStat) < 2) {
    console.log(`  Net-positive here (${pct(summary.avgNetPct)}/trade) but NOT statistically distinguishable from luck at this sample size.`);
    console.log(`  Run replay:windows to see whether it survives other periods before trusting it.`);
  } else {
    console.log(`  Net-positive (${pct(summary.avgNetPct)}/trade) and statistically meaningful IN THIS WINDOW.`);
    console.log(`  Next: confirm it holds across other windows (replay:windows) and regimes before risking money.`);
  }

  // Feed the real results into memory.
  for (const t of trades) {
    appendLedgerRow({
      timestamp: new Date(t.exitTime).toISOString(),
      symbol: STRATEGY_CONFIG.symbol,
      action: "SELL",
      price: t.exitPrice.toFixed(2),
      quantity: String(risk.quantity),
      reason: `Replay: entry ${t.entryPrice.toFixed(2)} -> exit ${t.exitPrice.toFixed(2)} (${t.outcome}, net ${pct(t.netPnlPct)}) [${SETUP_KEY}]`,
      mode: "replay",
      outcome: t.netPnlPct >= 0 ? "win" : "loss",
      pnl: (t.netPnlPct * 100).toFixed(4),
    });
  }
  console.log(`\nAppended ${trades.length} real replay outcomes to data/ledger.csv (recorded NET of costs).`);

  const netLosses = trades.filter((t: ReplayTrade) => t.netPnlPct < 0);
  if (netLosses.length > 0) {
    appendLearning(
      `Backtest (${new Date().toISOString().slice(0, 10)}): ${netLosses.length} of ${trades.length} ${SETUP_KEY} setups on ${STRATEGY_CONFIG.symbol} lost money NET of ${pct(summary.roundTripCostPct)} costs (worst ${pct(summary.worstNetPct)}); net average ${pct(summary.avgNetPct)} per trade.`
    );
    console.log("Wrote a real-loss lesson to data/learnings.md.");
  } else {
    console.log("No net-losing setups this run — nothing written to data/learnings.md (nothing is ever seeded).");
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
