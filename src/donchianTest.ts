// Checks for the Donchian breakout strategy. No network, no keys.
//
//   npm run donchian:test
//
// Two things matter here and nothing else can prove them:
//   1. No look-ahead. The breakout test must compare a close against a window
//      of EARLIER closes only. A window that includes the current bar makes
//      every backtest a fantasy.
//   2. The live signal and the backtest event list must agree. If they don't,
//      the bot cannot reproduce its own backtest — the exact bug the testnet
//      run caught in the trend strategy.

import { detectDonchianEvents, computeSignal } from "./strategy";
import { STRATEGY_CONFIG } from "./bot";
import { Candle, StrategyConfig } from "./types";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function candles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    openTime: i * 60000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
    closeTime: i * 60000 + 59999,
  }));
}

const cfg = (over: Partial<StrategyConfig>): StrategyConfig => ({
  ...STRATEGY_CONFIG,
  strategyType: "donchian_breakout",
  trendLookback: 5,
  donchianExitRatio: 0.4, // exit window = round(5 * 0.4) = 2
  ...over,
});

function main(): void {
  console.log("DONCHIAN BREAKOUT CHECKS — synthetic candles, no network\n");

  // Flat at 100, then a single new high, then a decline through the 2-period low.
  const series = [100, 100, 100, 100, 100, 100, 101, 102, 103, 99, 98, 97];
  const c = candles(series);
  const events = detectDonchianEvents(c, 5, 0.4);

  check("a new 5-period high opens a position", events.length > 0 && events[0].type === "bullish");
  check("the entry is the first bar above the prior high (index 6)", events[0]?.index === 6, `got ${events[0]?.index}`);
  const exits = events.filter((e) => e.type === "bearish");
  check("a drop below the 2-period low closes it", exits.length === 1, `got ${exits.length}`);
  check("the exit comes after the entry", (exits[0]?.index ?? 0) > events[0].index);
  check("entries and exits strictly alternate", events.every((e, i) => e.type === (i % 2 === 0 ? "bullish" : "bearish")));

  // Look-ahead: a flat series where the LAST bar spikes. If the entry window
  // included the current bar, the spike could never count as a breakout.
  const spike = candles([100, 100, 100, 100, 100, 100, 100, 140]);
  const spikeEvents = detectDonchianEvents(spike, 5, 0.4);
  check("a breakout on the final bar is detected (window excludes the current bar)", spikeEvents.some((e) => e.index === 7));

  // A series that never exceeds its prior high must never trade.
  const flat = candles(new Array(40).fill(100));
  check("a perfectly flat market produces no trades", detectDonchianEvents(flat, 5, 0.4).length === 0);

  const falling = candles(Array.from({ length: 40 }, (_, i) => 100 - i));
  check("a falling market produces no entries", detectDonchianEvents(falling, 5, 0.4).length === 0);

  // Live signal vs backtest events: replay the series bar by bar the way the
  // live bot sees it (history up to now + its own position) and confirm the
  // decisions land on exactly the same bars.
  const live: { index: number; type: "bullish" | "bearish" }[] = [];
  let inPosition = false;
  for (let i = 5; i < series.length; i++) {
    const history = c.slice(0, i + 1);
    const s = computeSignal(history, cfg({}), inPosition);
    if (s.signal === "BUY") {
      live.push({ index: i, type: "bullish" });
      inPosition = true;
    } else if (s.signal === "SELL") {
      live.push({ index: i, type: "bearish" });
      inPosition = false;
    }
  }
  check(
    "the live signal fires on the same bars as the backtest",
    JSON.stringify(live) === JSON.stringify(events.map((e) => ({ index: e.index, type: e.type }))),
    `live ${JSON.stringify(live)} vs backtest ${JSON.stringify(events.map((e) => ({ index: e.index, type: e.type })))}`
  );

  // A faster exit window must never trade less than a slower one on the same data.
  const noisy = candles(Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.05));
  const fastExit = detectDonchianEvents(noisy, 20, 0.25).length;
  const slowExit = detectDonchianEvents(noisy, 20, 1.0).length;
  check("a faster exit trades at least as often as a slower one", fastExit >= slowExit, `${fastExit} vs ${slowExit}`);

  // Exit window is floored at 2 — a zero-length window would compare against nothing.
  check("a tiny exit ratio still leaves a usable window", detectDonchianEvents(noisy, 20, 0.001).length > 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("\nDonchian logic is sound: no look-ahead, live and backtest agree.");
}

main();
