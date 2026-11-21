// Sweeps the strategy across multiple TIMEFRAMES to find one where the
// average move is actually large enough to clear trading costs.
//
// The core problem this exists to answer: on 5m candles BTC typically moves
// 0.1-0.5%, while a round trip costs ~0.22%. You cannot scalp moves the same
// size as your costs. On higher timeframes moves are measured in whole
// percent, so costs become noise instead of the whole game.
//
// Stops and targets are scaled by ATR per timeframe, so each one is tested on
// its own terms rather than with a 1% stop that's loose on 5m and absurd on 1d.
//
// Run with: npm run sweep

import { fetchHistoricalCandles } from "./market";
import { detectEntryEvents, atrFraction } from "./strategy";
import { STRATEGY_CONFIG, RISK_CONFIG, COST_CONFIG } from "./bot";
import { assertPaperMode } from "./guardrails";
import { runBacktest, significance, roundTripCost, checkConfigViability } from "./backtest";
import { RiskConfig, StrategyConfig } from "./types";

const TIMEFRAMES = (process.env.SWEEP_INTERVALS ?? "5m,15m,1h,4h,1d").split(",").map((s) => s.trim());
const CANDLES_PER_TF = Number(process.env.SWEEP_CANDLES ?? 1500);
const FORWARD_CANDLES = Number(process.env.SWEEP_FORWARD ?? 12);
const ATR_STOP_MULT = Number(process.env.SWEEP_ATR_STOP ?? 1.5);   // stop = 1.5x ATR
const ATR_TARGET_MULT = Number(process.env.SWEEP_ATR_TARGET ?? 3); // target = 3x ATR (1:2 risk/reward)

function pct(v: number): string {
  return (v * 100).toFixed(3) + "%";
}

interface Row {
  interval: string;
  trades: number;
  atrPct: number;
  stopPct: number;
  targetPct: number;
  avgGross: number;
  avgNet: number;
  totalNet: number;
  tStat: number;
  spanDays: number;
}

async function main() {
  assertPaperMode();

  const cost = roundTripCost(COST_CONFIG);
  console.log(`Timeframe sweep for ${STRATEGY_CONFIG.strategyType} on ${STRATEGY_CONFIG.symbol}`);
  console.log(`Round-trip cost: ${pct(cost)} — every timeframe below must beat this per trade to be worth anything.`);
  console.log(`Stops scaled to ${ATR_STOP_MULT}x ATR, targets ${ATR_TARGET_MULT}x ATR, ${FORWARD_CANDLES}-candle forward window.\n`);

  const rows: Row[] = [];

  for (const interval of TIMEFRAMES) {
    process.stdout.write(`Testing ${interval.padEnd(4)}... `);

    let candles;
    try {
      candles = await fetchHistoricalCandles(STRATEGY_CONFIG.symbol, interval, CANDLES_PER_TF);
    } catch (err) {
      console.log(`failed: ${(err as Error).message}`);
      continue;
    }

    if (candles.length < 100) {
      console.log(`only ${candles.length} candles available — skipping.`);
      continue;
    }

    const atr = atrFraction(candles, 14);
    const tfRisk: RiskConfig = {
      ...RISK_CONFIG,
      stopLossPct: atr * ATR_STOP_MULT,
      takeProfitPct: atr * ATR_TARGET_MULT,
    };

    const viability = checkConfigViability(tfRisk.takeProfitPct, tfRisk.stopLossPct, COST_CONFIG);
    if (!viability.viable) {
      console.log(`UNTESTABLE — target ${pct(tfRisk.takeProfitPct)} is below the ${pct(cost)} round-trip cost.`);
      console.log(`         ${STRATEGY_CONFIG.symbol} simply does not move enough on ${interval} to pay for trading it.`);
      continue;
    }

    const tfConfig: StrategyConfig = { ...STRATEGY_CONFIG, interval };
    const entries = detectEntryEvents(candles, tfConfig).filter((e) => e.type === "bullish");
    const { trades, summary } = runBacktest(candles, entries.map((e) => e.index), FORWARD_CANDLES, tfRisk, COST_CONFIG);

    if (trades.length === 0) {
      console.log("no setups with enough forward data.");
      continue;
    }

    const sig = significance(trades);
    const spanDays = (candles[candles.length - 1].closeTime - candles[0].openTime) / 86400000;

    rows.push({
      interval,
      trades: trades.length,
      atrPct: atr,
      stopPct: tfRisk.stopLossPct,
      targetPct: tfRisk.takeProfitPct,
      avgGross: summary.avgGrossPct,
      avgNet: summary.avgNetPct,
      totalNet: summary.totalNetPct,
      tStat: sig.tStat,
      spanDays,
    });

    console.log(`${trades.length} trades over ${spanDays.toFixed(0)} days — net ${pct(summary.avgNetPct)}/trade`);
    await new Promise((r) => setTimeout(r, 400));
  }

  if (rows.length === 0) {
    console.log("\nNo timeframe produced testable results.");
    return;
  }

  console.log("\n" + "=".repeat(96));
  console.log("RESULTS BY TIMEFRAME");
  console.log("=".repeat(96));
  console.log(
    "tf".padEnd(6), "trades".padEnd(8), "days".padEnd(7), "avg move(ATR)".padEnd(15),
    "gross/trade".padEnd(13), "net/trade".padEnd(13), "total net".padEnd(12), "t-stat"
  );
  for (const r of rows) {
    console.log(
      r.interval.padEnd(6),
      String(r.trades).padEnd(8),
      r.spanDays.toFixed(0).padEnd(7),
      pct(r.atrPct).padEnd(15),
      pct(r.avgGross).padEnd(13),
      pct(r.avgNet).padEnd(13),
      pct(r.totalNet).padEnd(12),
      r.tStat.toFixed(2)
    );
  }

  console.log("\n" + "=".repeat(96));
  console.log("READING THIS TABLE");
  console.log("=".repeat(96));
  console.log(`  'avg move(ATR)' is how much ${STRATEGY_CONFIG.symbol} typically moves per candle on that timeframe.`);
  console.log(`  Compare it to the ${pct(cost)} round-trip cost. If ATR is smaller than or close to the cost,`);
  console.log(`  that timeframe cannot work — you'd be paying more to trade than the asset moves.\n`);

  const viable = rows.filter((r) => r.avgNet > 0);
  const strong = rows.filter((r) => r.avgNet > 0 && r.tStat >= 2 && r.trades >= 100);

  if (viable.length === 0) {
    console.log("  No timeframe was net-positive after costs. That is a real answer, not a failure of the test —");
    console.log("  this strategy as written does not have an edge on this symbol. Options: try a different");
    console.log("  strategy, a different symbol, or accept the finding and move on.");
  } else {
    console.log(`  Net-positive after costs: ${viable.map((r) => r.interval).join(", ")}`);
    if (strong.length > 0) {
      console.log(`  Of those, statistically meaningful with enough trades: ${strong.map((r) => r.interval).join(", ")}`);
      console.log(`\n  Next step: run replay:windows on the best one to confirm it holds across separate periods.`);
      console.log(`  Change 'interval' in STRATEGY_CONFIG (src/bot.ts), run memory:reset, then replay:windows.`);
    } else {
      console.log(`  None of them are statistically meaningful yet (need t > 2 and 100+ trades).`);
      console.log(`  Positive-but-noisy is not an edge. Increase SWEEP_CANDLES for more history before believing it.`);
    }
  }

  console.log("\n  WARNING — you just tested " + rows.length + " timeframes at once. If you test enough variations,");
  console.log("  one will look good by pure chance (this is data mining / p-hacking). A winner here is a");
  console.log("  HYPOTHESIS, not a result. It only counts if it also holds on data you haven't looked at yet:");
  console.log("  confirm with replay:windows, then forward-test on testnet before believing it.");
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
