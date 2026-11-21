// Attacks a promising result to find out whether it is real or curve-fitted.
//
// A single good backtest proves nothing — you picked the strategy, the
// parameter and the window while already knowing roughly what the market did.
// Two tests separate a genuine effect from a lucky coincidence:
//
//   1. PARAMETER ROBUSTNESS. A real effect degrades gracefully as you change
//      the parameter. A curve-fit spikes at one magic value and collapses on
//      either side. If a 100-day lookback works but 80 and 130 don't, you
//      found noise, not a strategy.
//
//   2. CROSS-ASSET GENERALISATION. A structural effect shows up in other
//      assets too. If it only ever works on the one symbol you developed it
//      on, that is a strong hint you fitted that symbol's particular history.
//
// Run with: npm run robustness

import { fetchHistoricalCandles } from "./market";
import { STRATEGY_CONFIG, RISK_CONFIG, COST_CONFIG } from "./bot";
import { assertPaperMode } from "./guardrails";
import { runSignalBacktest } from "./signalBacktest";
import { Candle, StrategyConfig, StrategyType } from "./types";

const CANDLES = Number(process.env.ROBUST_CANDLES ?? 1500);
const INTERVAL = process.env.INTERVAL ?? "1d";
const STRATEGY = (process.env.STRATEGY as StrategyType) ?? "trend_following";
const LOOKBACKS = (process.env.ROBUST_LOOKBACKS ?? "20,30,50,80,100,130,160,200,250").split(",").map(Number);
const SYMBOLS = (process.env.ROBUST_SYMBOLS ?? "BTCUSDT,ETHUSDT,BNBUSDT,LTCUSDT,ADAUSDT").split(",").map((s) => s.trim());

function pct(v: number): string {
  return (v * 100).toFixed(1) + "%";
}
function pad(s: string, n: number): string {
  return s.padEnd(n);
}

function cfg(overrides: Partial<StrategyConfig>): StrategyConfig {
  return { ...STRATEGY_CONFIG, strategyType: STRATEGY, interval: INTERVAL, ...overrides };
}

interface Row {
  label: string;
  trades: number;
  cagr: number;
  maxDD: number;
  bhCagr: number;
  bhMaxDD: number;
  exposure: number;
}

function printTable(rows: Row[], firstCol: string) {
  console.log(
    pad(firstCol, 12), pad("trades", 8), pad("CAGR", 10), pad("maxDD", 10),
    pad("B&H CAGR", 11), pad("B&H maxDD", 11), pad("exposure", 10), "DD better?"
  );
  for (const r of rows) {
    console.log(
      pad(r.label, 12),
      pad(String(r.trades), 8),
      pad(pct(r.cagr), 10),
      pad(pct(r.maxDD), 10),
      pad(pct(r.bhCagr), 11),
      pad(pct(r.bhMaxDD), 11),
      pad(pct(r.exposure), 10),
      r.maxDD > r.bhMaxDD ? "yes" : "no"
    );
  }
}

async function main() {
  assertPaperMode();

  console.log(`Robustness check — ${STRATEGY} on ${INTERVAL} candles, ${CANDLES} candles per test`);
  console.log(`Round-trip cost: ${pct(2 * (COST_CONFIG.feePctPerSide + COST_CONFIG.slippagePctPerSide))}\n`);

  // ---------- Test 1: parameter sensitivity (one fetch, many lookbacks) ----------
  console.log("=".repeat(92));
  console.log(`TEST 1 — PARAMETER SENSITIVITY on ${STRATEGY_CONFIG.symbol}`);
  console.log("Does the result survive changing the lookback, or does it only work at one magic number?");
  console.log("=".repeat(92));

  const baseCandles: Candle[] = await fetchHistoricalCandles(STRATEGY_CONFIG.symbol, INTERVAL, CANDLES);
  console.log(`${baseCandles.length} candles: ${new Date(baseCandles[0].openTime).toISOString().slice(0, 10)} to ${new Date(baseCandles[baseCandles.length - 1].closeTime).toISOString().slice(0, 10)}\n`);

  const paramRows: Row[] = [];
  for (const lb of LOOKBACKS) {
    if (baseCandles.length < lb + 10) continue;
    const r = runSignalBacktest(baseCandles, cfg({ trendLookback: lb }), RISK_CONFIG, COST_CONFIG, false);
    paramRows.push({
      label: String(lb),
      trades: r.trades.length,
      cagr: r.strategy.cagrPct,
      maxDD: r.strategy.maxDrawdownPct,
      bhCagr: r.buyHold.cagrPct,
      bhMaxDD: r.buyHold.maxDrawdownPct,
      exposure: r.strategy.exposurePct,
    });
  }
  printTable(paramRows, "lookback");

  const cagrs = paramRows.map((r) => r.cagr);
  const meanCagr = cagrs.reduce((s, v) => s + v, 0) / cagrs.length;
  const spread = Math.max(...cagrs) - Math.min(...cagrs);
  const ddBetterCount = paramRows.filter((r) => r.maxDD > r.bhMaxDD).length;

  console.log(`\n  Mean CAGR across lookbacks: ${pct(meanCagr)}   Spread (best-worst): ${pct(spread)}`);
  console.log(`  Shallower drawdown than buy-and-hold in ${ddBetterCount}/${paramRows.length} settings`);
  if (spread > Math.abs(meanCagr) * 2) {
    console.log(`  WARNING: results swing wildly with the parameter. That is the signature of curve-fitting,`);
    console.log(`  not a robust effect. Be very sceptical of whichever setting looked best.`);
  } else {
    console.log(`  Results are reasonably stable across parameters — consistent with a real effect`);
    console.log(`  rather than one lucky setting. Not proof, but it survives the first attack.`);
  }

  // ---------- Test 2: does it generalise to other assets? ----------
  console.log("\n" + "=".repeat(92));
  console.log(`TEST 2 — CROSS-ASSET GENERALISATION (lookback ${STRATEGY_CONFIG.trendLookback})`);
  console.log("A structural effect appears in other assets. One that only works on the symbol you");
  console.log("developed on is usually fitted to that symbol's particular history.");
  console.log("=".repeat(92));

  const assetRows: Row[] = [];
  for (const symbol of SYMBOLS) {
    process.stdout.write(`  fetching ${symbol}... `);
    let candles: Candle[];
    try {
      candles = await fetchHistoricalCandles(symbol, INTERVAL, CANDLES);
    } catch (err) {
      console.log(`failed (${(err as Error).message.slice(0, 60)})`);
      continue;
    }
    if (candles.length < STRATEGY_CONFIG.trendLookback + 30) {
      console.log(`only ${candles.length} candles — not enough history, skipping.`);
      continue;
    }
    const r = runSignalBacktest(candles, cfg({ symbol }), RISK_CONFIG, COST_CONFIG, false);
    assetRows.push({
      label: symbol.replace("USDT", ""),
      trades: r.trades.length,
      cagr: r.strategy.cagrPct,
      maxDD: r.strategy.maxDrawdownPct,
      bhCagr: r.buyHold.cagrPct,
      bhMaxDD: r.buyHold.maxDrawdownPct,
      exposure: r.strategy.exposurePct,
    });
    console.log(`${r.trades.length} trades, CAGR ${pct(r.strategy.cagrPct)} vs B&H ${pct(r.buyHold.cagrPct)}`);
    await new Promise((res) => setTimeout(res, 400));
  }

  if (assetRows.length > 0) {
    console.log("");
    printTable(assetRows, "asset");
    const assetDDBetter = assetRows.filter((r) => r.maxDD > r.bhMaxDD).length;
    const assetCagrBetter = assetRows.filter((r) => r.cagr > r.bhCagr).length;
    console.log(`\n  Shallower drawdown than holding: ${assetDDBetter}/${assetRows.length} assets`);
    console.log(`  Higher return than holding:      ${assetCagrBetter}/${assetRows.length} assets`);
  }

  // ---------- Honest summary ----------
  console.log("\n" + "=".repeat(92));
  console.log("WHAT THIS DOES AND DOESN'T TELL YOU");
  console.log("=".repeat(92));
  console.log(`  Surviving both tests means the effect is not obviously a fluke of one parameter or one`);
  console.log(`  asset. It does NOT mean it will work in future, and it does not make the returns reliable.`);
  console.log(`  Every asset here shares the same crypto market cycle, so they are far from independent`);
  console.log(`  samples — a single market-wide bull run can lift all of them at once.`);
  console.log(`\n  Reducing drawdown is a structural property of being out of the market during downtrends,`);
  console.log(`  and is the part most likely to persist. Outperforming on RETURN is the part most likely`);
  console.log(`  to be luck. Weight your conclusions accordingly.`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
