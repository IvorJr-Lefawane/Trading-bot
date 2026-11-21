// Runs a signal-exit backtest against a buy-and-hold benchmark.
//
//   npm run backtest
//
// Useful env overrides:
//   STRATEGY=trend_following   (or rsi_mean_reversion, ma_crossover)
//   INTERVAL=1d                TREND_LOOKBACK=100
//   SYMBOL=BTCUSDT             BACKTEST_CANDLES=1500
//   USE_STOPS=false            (trend following normally runs without stops —
//                               the exit signal IS the risk control)

import { fetchHistoricalCandles } from "./market";
import { STRATEGY_CONFIG, RISK_CONFIG, COST_CONFIG } from "./bot";
import { assertPaperMode } from "./guardrails";
import { runSignalBacktest, verdict } from "./signalBacktest";
import { StrategyConfig, StrategyType } from "./types";

const CANDLES = Number(process.env.BACKTEST_CANDLES ?? 1500);
const USE_STOPS = (process.env.USE_STOPS ?? "false").toLowerCase() === "true";

function pct(v: number): string {
  return (v * 100).toFixed(2) + "%";
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

async function main() {
  assertPaperMode();

  const config: StrategyConfig = {
    ...STRATEGY_CONFIG,
    strategyType: (process.env.STRATEGY as StrategyType) ?? STRATEGY_CONFIG.strategyType,
    trendLookback: Number(process.env.TREND_LOOKBACK ?? STRATEGY_CONFIG.trendLookback),
  };

  console.log(`Signal-exit backtest — ${config.strategyType} on ${config.symbol} ${config.interval}`);
  if (config.strategyType === "trend_following") {
    console.log(`Trend filter: ${config.trendLookback}-period moving average.`);
  }
  console.log(`Exits: strategy signal${USE_STOPS ? ` + ${pct(RISK_CONFIG.stopLossPct)} stop / ${pct(RISK_CONFIG.takeProfitPct)} target` : " only (no stops — the exit signal is the risk control)"}`);
  console.log(`Round-trip cost: ${pct(COST_CONFIG.feePctPerSide * 2 + COST_CONFIG.slippagePctPerSide * 2)}\n`);

  const candles = await fetchHistoricalCandles(config.symbol, config.interval, CANDLES);
  if (candles.length < 50) {
    console.log(`Only ${candles.length} candles available — not enough to test.`);
    return;
  }
  console.log(`Loaded ${candles.length} real candles: ${new Date(candles[0].openTime).toISOString().slice(0, 10)} to ${new Date(candles[candles.length - 1].closeTime).toISOString().slice(0, 10)}\n`);

  const r = runSignalBacktest(candles, config, RISK_CONFIG, COST_CONFIG, USE_STOPS);

  if (r.trades.length === 0) {
    console.log("No trades were generated. The signal never fired over this window.");
    return;
  }

  console.log("Last 10 trades:");
  console.log(pad("entry", 13), pad("exit", 13), pad("bars", 7), pad("why", 12), pad("gross", 10), "net");
  for (const t of r.trades.slice(-10)) {
    console.log(
      pad(new Date(t.entryTime).toISOString().slice(0, 10), 13),
      pad(new Date(t.exitTime).toISOString().slice(0, 10), 13),
      pad(String(t.barsHeld), 7),
      pad(t.exitReason, 12),
      pad(pct(t.grossPct), 10),
      pct(t.netPct)
    );
  }

  const s = r.strategy, b = r.buyHold;
  console.log("\n" + "=".repeat(78));
  console.log(pad("", 26) + pad("STRATEGY", 26) + "BUY & HOLD");
  console.log("=".repeat(78));
  console.log(pad("  Total return", 26) + pad(pct(s.totalReturnPct), 26) + pct(b.totalReturnPct));
  console.log(pad("  Annualised (CAGR)", 26) + pad(pct(s.cagrPct), 26) + pct(b.cagrPct));
  console.log(pad("  Max drawdown", 26) + pad(pct(s.maxDrawdownPct), 26) + pct(b.maxDrawdownPct));
  console.log(pad("  Time period", 26) + pad(r.years.toFixed(2) + " years", 26) + r.years.toFixed(2) + " years");
  console.log("");
  console.log(pad("  Trades", 26) + String(r.trades.length));
  console.log(pad("  Trades per year", 26) + s.tradesPerYear.toFixed(1));
  console.log(pad("  Win rate (net)", 26) + pct(s.winRatePct));
  console.log(pad("  Avg net per trade", 26) + pct(s.avgNetPct));
  console.log(pad("  Time in market", 26) + pct(s.exposurePct));
  console.log(pad("  Annual cost drag", 26) + pct(s.tradesPerYear * r.roundTripCostPct));

  console.log("\n" + "=".repeat(78));
  console.log("VERDICT");
  console.log("=".repeat(78));
  for (const line of verdict(r)) console.log("  " + line);

  console.log("\n  Reminder: this is in-sample. You chose this strategy and these settings knowing");
  console.log("  roughly what the market did. The only test that counts is a period you have not looked at.");
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
