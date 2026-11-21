// Tests the strategy across SEVERAL separate historical windows instead of one.
//
// Why this exists: a single week of data with ~30 trades cannot tell you
// whether an edge is real. Markets trend, chop, crash and rally, and a
// strategy that works in one regime routinely fails in another. If an edge
// only appears in one window, it was noise. Run with: npm run replay:windows

import { fetchHistoricalCandles } from "./market";
import { detectEntryEvents, atrFraction } from "./strategy";
import { STRATEGY_CONFIG, RISK_CONFIG, COST_CONFIG } from "./bot";
import { assertPaperMode } from "./guardrails";
import { runBacktest, significance, BacktestSummary } from "./backtest";
import { ReplayTrade, RiskConfig } from "./types";

const WINDOW_COUNT = Number(process.env.WINDOW_COUNT ?? 6);
const WINDOW_CANDLES = Number(process.env.WINDOW_CANDLES ?? 2000); // ~1 week of 5m candles each
const FORWARD_CANDLES = Number(process.env.REPLAY_FORWARD ?? 12);
const USE_ATR_RISK = (process.env.USE_ATR_RISK ?? "false").toLowerCase() === "true";
const ATR_STOP_MULT = Number(process.env.ATR_STOP_MULT ?? 1.5);
const ATR_TARGET_MULT = Number(process.env.ATR_TARGET_MULT ?? 3);

function pct(v: number): string {
  return (v * 100).toFixed(2) + "%";
}

interface WindowResult {
  label: string;
  from: string;
  to: string;
  summary: BacktestSummary;
  trades: ReplayTrade[];
}

async function main() {
  assertPaperMode();

  console.log(`Testing ${STRATEGY_CONFIG.strategyType} on ${STRATEGY_CONFIG.symbol} across ${WINDOW_COUNT} separate windows of ${WINDOW_CANDLES} candles each.`);
  console.log(`Costs: ${pct(COST_CONFIG.feePctPerSide)} fee + ${pct(COST_CONFIG.slippagePctPerSide)} slippage per side = ${pct(2 * (COST_CONFIG.feePctPerSide + COST_CONFIG.slippagePctPerSide))} round trip.\n`);

  const results: WindowResult[] = [];
  let endingAt: number | undefined = undefined;

  for (let w = 0; w < WINDOW_COUNT; w++) {
    const candles = await fetchHistoricalCandles(STRATEGY_CONFIG.symbol, STRATEGY_CONFIG.interval, WINDOW_CANDLES, endingAt);
    if (candles.length < WINDOW_CANDLES * 0.5) {
      console.log(`Window ${w + 1}: only ${candles.length} candles available — history exhausted, stopping here.`);
      break;
    }

    const atr = atrFraction(candles, 14);
    const risk: RiskConfig = USE_ATR_RISK
      ? { ...RISK_CONFIG, stopLossPct: atr * ATR_STOP_MULT, takeProfitPct: atr * ATR_TARGET_MULT }
      : RISK_CONFIG;

    const entries = detectEntryEvents(candles, STRATEGY_CONFIG).filter((e) => e.type === "bullish");
    const { trades, summary } = runBacktest(candles, entries.map((e) => e.index), FORWARD_CANDLES, risk, COST_CONFIG);

    results.push({
      label: `Window ${w + 1}`,
      from: new Date(candles[0].openTime).toISOString().slice(0, 10),
      to: new Date(candles[candles.length - 1].closeTime).toISOString().slice(0, 10),
      summary,
      trades,
    });

    console.log(`Window ${w + 1} (${results[results.length - 1].from} to ${results[results.length - 1].to}): ${summary.totalSetups} trades, gross ${pct(summary.avgGrossPct)}/trade, NET ${pct(summary.avgNetPct)}/trade, total net ${pct(summary.totalNetPct)}`);

    endingAt = candles[0].openTime - 1; // step further back in time
    await new Promise((r) => setTimeout(r, 400));
  }

  if (results.length === 0) {
    console.log("No windows could be tested.");
    return;
  }

  const allTrades = results.flatMap((r) => r.trades);
  const profitableWindows = results.filter((r) => r.summary.avgNetPct > 0).length;
  const overallAvgNet = allTrades.reduce((s, t) => s + t.netPnlPct, 0) / allTrades.length;
  const overallAvgGross = allTrades.reduce((s, t) => s + t.pnlPct, 0) / allTrades.length;
  const totalNet = allTrades.reduce((s, t) => s + t.netPnlPct, 0);
  const sig = significance(allTrades);

  console.log("\n" + "=".repeat(70));
  console.log("COMBINED RESULT ACROSS ALL WINDOWS");
  console.log("=".repeat(70));
  console.log(`  Windows tested: ${results.length}   Net-profitable windows: ${profitableWindows}/${results.length}`);
  console.log(`  Total trades: ${allTrades.length}`);
  console.log(`  GROSS avg per trade: ${pct(overallAvgGross)}`);
  console.log(`  NET avg per trade:   ${pct(overallAvgNet)}`);
  console.log(`  Total net across all windows: ${pct(totalNet)}`);
  console.log(`\n  ${sig.verdict}`);

  console.log("\nREAL-MONEY READINESS:");
  const consistent = profitableWindows >= Math.ceil(results.length * 0.75);
  const meaningful = sig.tStat >= 2;
  const enoughData = allTrades.length >= 200;

  console.log(`  [${overallAvgNet > 0 ? "PASS" : "FAIL"}] Net-positive after costs: ${pct(overallAvgNet)} per trade`);
  console.log(`  [${consistent ? "PASS" : "FAIL"}] Consistent across windows: ${profitableWindows}/${results.length} profitable (want 75%+)`);
  console.log(`  [${enoughData ? "PASS" : "FAIL"}] Enough trades to judge: ${allTrades.length} (want 200+)`);
  console.log(`  [${meaningful ? "PASS" : "FAIL"}] Distinguishable from luck: t = ${sig.tStat.toFixed(2)} (want > 2)`);

  const passed = overallAvgNet > 0 && consistent && enoughData && meaningful;
  console.log(
    passed
      ? `\n  All four checks passed. That is the minimum bar — not a guarantee. Forward-test on\n  Binance Spot Testnet before any real capital.`
      : `\n  Not ready for real money. Failing checks above mean the edge is either absent,\n  inconsistent, or indistinguishable from randomness. Trading this live would be\n  paying fees for the privilege of a coin flip.`
  );
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
