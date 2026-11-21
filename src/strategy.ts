// Two strategies live here:
//   - MA crossover (trend-following) — the original default.
//   - RSI mean-reversion — better suited to the range-bound conditions the
//     replay:raw backtest actually showed for BTCUSDT this week.
// STRATEGY_CONFIG.strategyType picks which one bot.ts / replay.ts use.
// No repainting: every value is computed only from candles that have already closed.

import { Candle, CrossoverEvent, SignalResult, StrategyConfig } from "./types";

// ---------- Shared math ----------

/** Simple moving average, aligned to `values` — null where there isn't enough history yet. */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Wilder's RSI, aligned to `values` — null until there's enough history (index >= period). */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gainSum += diff; else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Average True Range over the last `period` candles, expressed as a FRACTION
 * of the latest price. Used to size stops/targets relative to how much an
 * asset actually moves on a given timeframe — a 1% stop is loose on 5m candles
 * and absurdly tight on daily ones.
 */
export function atrFraction(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const recent = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < recent.length; i++) {
    const c = recent[i], prev = recent[i - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  }
  const atr = sum / period;
  const price = candles[candles.length - 1].close;
  return price > 0 ? atr / price : 0;
}

// ---------- MA crossover (trend-following) ----------

export function detectCrossovers(candles: Candle[], fastLen = 9, slowLen = 21): CrossoverEvent[] {
  const closes = candles.map((c) => c.close);
  const fast = sma(closes, fastLen);
  const slow = sma(closes, slowLen);
  const events: CrossoverEvent[] = [];

  for (let i = 1; i < candles.length; i++) {
    const f0 = fast[i - 1], s0 = slow[i - 1];
    const f1 = fast[i], s1 = slow[i];
    if (f0 === null || s0 === null || f1 === null || s1 === null) continue;

    if (f0 <= s0 && f1 > s1) {
      events.push({ index: i, timestamp: candles[i].closeTime, type: "bullish", price: candles[i].close });
    } else if (f0 >= s0 && f1 < s1) {
      events.push({ index: i, timestamp: candles[i].closeTime, type: "bearish", price: candles[i].close });
    }
  }
  return events;
}

function generateMaCrossoverSignal(candles: Candle[], fastLen: number, slowLen: number): SignalResult {
  if (candles.length < slowLen + 1) {
    throw new Error(`Need at least ${slowLen + 1} candles to evaluate the ${fastLen}/${slowLen} crossover, got ${candles.length}.`);
  }
  const closes = candles.map((c) => c.close);
  const fast = sma(closes, fastLen);
  const slow = sma(closes, slowLen);

  const last = candles.length - 1;
  const f0 = fast[last - 1]!, s0 = slow[last - 1]!;
  const f1 = fast[last]!, s1 = slow[last]!;

  if (f0 <= s0 && f1 > s1) {
    return { signal: "BUY", fastMA: f1, slowMA: s1, reason: `Fast MA (${f1.toFixed(2)}) crossed above slow MA (${s1.toFixed(2)}) — bullish crossover` };
  }
  if (f0 >= s0 && f1 < s1) {
    return { signal: "SELL", fastMA: f1, slowMA: s1, reason: `Fast MA (${f1.toFixed(2)}) crossed below slow MA (${s1.toFixed(2)}) — bearish crossover` };
  }
  return { signal: "HOLD", fastMA: f1, slowMA: s1, reason: `No fresh crossover (fast MA ${f1.toFixed(2)} vs slow MA ${s1.toFixed(2)})` };
}

// ---------- RSI mean-reversion ----------

/** Entry = RSI crosses DOWN through `oversold` (fresh dip into oversold). Exit = RSI crosses UP through `exitLevel` (recovered). */
export function detectRsiEvents(candles: Candle[], period = 14, oversold = 30, exitLevel = 50): CrossoverEvent[] {
  const closes = candles.map((c) => c.close);
  const r = rsi(closes, period);
  const events: CrossoverEvent[] = [];

  for (let i = 1; i < candles.length; i++) {
    const r0 = r[i - 1], r1 = r[i];
    if (r0 === null || r1 === null) continue;

    if (r0 >= oversold && r1 < oversold) {
      events.push({ index: i, timestamp: candles[i].closeTime, type: "bullish", price: candles[i].close });
    } else if (r0 <= exitLevel && r1 > exitLevel) {
      events.push({ index: i, timestamp: candles[i].closeTime, type: "bearish", price: candles[i].close });
    }
  }
  return events;
}

function generateRsiSignal(candles: Candle[], period: number, oversold: number, exitLevel: number): SignalResult {
  if (candles.length < period + 2) {
    throw new Error(`Need at least ${period + 2} candles to evaluate RSI(${period}), got ${candles.length}.`);
  }
  const closes = candles.map((c) => c.close);
  const r = rsi(closes, period);

  const last = candles.length - 1;
  const r0 = r[last - 1]!, r1 = r[last]!;

  if (r0 >= oversold && r1 < oversold) {
    return { signal: "BUY", fastMA: r1, slowMA: oversold, reason: `RSI(${period}) dropped below ${oversold} (now ${r1.toFixed(1)}) — fresh oversold dip` };
  }
  if (r0 <= exitLevel && r1 > exitLevel) {
    return { signal: "SELL", fastMA: r1, slowMA: exitLevel, reason: `RSI(${period}) recovered above ${exitLevel} (now ${r1.toFixed(1)}) — exiting mean-reversion trade` };
  }
  return { signal: "HOLD", fastMA: r1, slowMA: exitLevel, reason: `RSI(${period}) at ${r1.toFixed(1)} — no fresh oversold dip or recovery` };
}

// ---------- Trend following (time-series momentum) ----------
//
// Long while price is above its long-lookback moving average, flat below it.
// This is a regime filter measured in months, not a scalping trigger: on daily
// candles with a 100-200 lookback it produces a handful of trades per year, so
// trading costs become a rounding error instead of the whole game. This is the
// class of strategy with the most published empirical support — which is not
// the same as a promise that it works now, or on this asset.

export function detectTrendEvents(candles: Candle[], lookback = 100): CrossoverEvent[] {
  const closes = candles.map((c) => c.close);
  const ma = sma(closes, lookback);
  const events: CrossoverEvent[] = [];
  let firstValidHandled = false;

  for (let i = 1; i < candles.length; i++) {
    const m0 = ma[i - 1], m1 = ma[i];
    if (m1 === null) continue;
    const c1 = closes[i];

    // Trend following is a STATE ("long while above the MA"), not only an EVENT
    // ("buy on the cross"). At the first bar where the MA exists, adopt the
    // current state — otherwise a bot started mid-uptrend would sit out the
    // whole move waiting for a crossing that already happened.
    if (!firstValidHandled) {
      firstValidHandled = true;
      if (c1 > m1) {
        events.push({ index: i, timestamp: candles[i].closeTime, type: "bullish", price: c1 });
      }
      continue;
    }

    if (m0 === null) continue;
    const c0 = closes[i - 1];

    if (c0 <= m0 && c1 > m1) {
      events.push({ index: i, timestamp: candles[i].closeTime, type: "bullish", price: c1 });
    } else if (c0 >= m0 && c1 < m1) {
      events.push({ index: i, timestamp: candles[i].closeTime, type: "bearish", price: c1 });
    }
  }
  return events;
}

/**
 * STATE-based, not event-based. This distinction is load-bearing.
 *
 * Trend following means "be long while price is above the MA" — not "buy on the
 * crossing". An event-based version leaves a bot that starts up mid-uptrend
 * sitting flat forever, waiting for a crossing that already happened, while the
 * backtest it was validated against was long the whole time. The live bot then
 * cannot reproduce its own backtest.
 *
 * So the signal depends on the CURRENT POSITION: enter whenever we are flat and
 * price is above the MA, exit whenever we are long and price is below it. That
 * matches detectTrendEvents(), which adopts the prevailing state at its first
 * valid bar for exactly the same reason.
 */
function generateTrendSignal(candles: Candle[], lookback: number, inPosition: boolean): SignalResult {
  if (candles.length < lookback + 2) {
    throw new Error(`Need at least ${lookback + 2} candles for a ${lookback}-period trend filter, got ${candles.length}.`);
  }
  const closes = candles.map((c) => c.close);
  const ma = sma(closes, lookback);
  const last = candles.length - 1;
  const m0 = ma[last - 1]!, m1 = ma[last]!;
  const c0 = closes[last - 1], c1 = closes[last];

  const above = c1 > m1;
  const freshCross = above ? c0 <= m0 : c0 >= m0;
  const distancePct = (((c1 - m1) / m1) * 100).toFixed(2);

  if (above && !inPosition) {
    return {
      signal: "BUY",
      fastMA: c1,
      slowMA: m1,
      reason: freshCross
        ? `Price (${c1.toFixed(2)}) crossed above its ${lookback}-period MA (${m1.toFixed(2)}) — uptrend beginning`
        : `Price (${c1.toFixed(2)}) is ${distancePct}% above its ${lookback}-period MA (${m1.toFixed(2)}) — uptrend already underway, entering`,
    };
  }
  if (!above && inPosition) {
    return {
      signal: "SELL",
      fastMA: c1,
      slowMA: m1,
      reason: freshCross
        ? `Price (${c1.toFixed(2)}) crossed below its ${lookback}-period MA (${m1.toFixed(2)}) — uptrend over`
        : `Price (${c1.toFixed(2)}) is ${distancePct}% below its ${lookback}-period MA (${m1.toFixed(2)}) — downtrend, exiting`,
    };
  }
  return {
    signal: "HOLD",
    fastMA: c1,
    slowMA: m1,
    reason: above
      ? `Price ${c1.toFixed(2)} is ${distancePct}% above its ${lookback}-period MA (${m1.toFixed(2)}) — already long, staying in`
      : `Price ${c1.toFixed(2)} is ${distancePct}% below its ${lookback}-period MA (${m1.toFixed(2)}) — flat, waiting for an uptrend`,
  };
}

// ---------- Donchian channel breakout ----------
//
// UNTESTED HYPOTHESIS, added 2026-09-20 to answer one question: does a strategy
// that trades more often than the daily trend filter (~7 trades a year) survive
// costs? Stated before any result was seen, per the project's standing rules:
//
//   Hypothesis: breaking to a new N-period high marks the start of a move large
//   enough to clear 0.22% round-trip costs, and exiting on an M-period low
//   (M < N) gets out sooner than a slow moving average would.
//
// Entry:  close is the highest close of the last `entryLen` candles (a new high).
// Exit:   close is the lowest close of the last `exitLen` candles.
// Like trend following this is a STATE, not just an event — the current
// position decides the correct action, so a bot started mid-trend agrees with
// its own backtest. Both windows exclude the current candle: comparing a close
// against a window that contains it is look-ahead by another name.

function donchianExitLen(entryLen: number, ratio: number): number {
  return Math.max(2, Math.round(entryLen * ratio));
}

function highestClose(closes: number[], end: number, len: number): number {
  let hi = -Infinity;
  for (let i = end - len; i < end; i++) if (closes[i] > hi) hi = closes[i];
  return hi;
}

function lowestClose(closes: number[], end: number, len: number): number {
  let lo = Infinity;
  for (let i = end - len; i < end; i++) if (closes[i] < lo) lo = closes[i];
  return lo;
}

export function detectDonchianEvents(candles: Candle[], entryLen = 20, exitRatio = 0.5): CrossoverEvent[] {
  const exitLen = donchianExitLen(entryLen, exitRatio);
  const closes = candles.map((c) => c.close);
  const events: CrossoverEvent[] = [];
  const start = Math.max(entryLen, exitLen);
  let inPosition = false;

  for (let i = start; i < candles.length; i++) {
    const c = closes[i];
    if (!inPosition && c > highestClose(closes, i, entryLen)) {
      events.push({ index: i, timestamp: candles[i].closeTime, type: "bullish", price: c });
      inPosition = true;
    } else if (inPosition && c < lowestClose(closes, i, exitLen)) {
      events.push({ index: i, timestamp: candles[i].closeTime, type: "bearish", price: c });
      inPosition = false;
    }
  }
  return events;
}

function generateDonchianSignal(
  candles: Candle[],
  entryLen: number,
  exitRatio: number,
  inPosition: boolean
): SignalResult {
  const exitLen = donchianExitLen(entryLen, exitRatio);
  const need = Math.max(entryLen, exitLen) + 1;
  if (candles.length < need) {
    throw new Error(`Need at least ${need} candles for a ${entryLen}/${exitLen} Donchian breakout, got ${candles.length}.`);
  }
  const closes = candles.map((c) => c.close);
  const last = candles.length - 1;
  const c = closes[last];
  const hi = highestClose(closes, last, entryLen);
  const lo = lowestClose(closes, last, exitLen);

  if (!inPosition) {
    if (c > hi) {
      return { signal: "BUY", fastMA: c, slowMA: hi, reason: `Close ${c.toFixed(2)} broke above the ${entryLen}-period high (${hi.toFixed(2)}) — breakout entry` };
    }
    return { signal: "HOLD", fastMA: c, slowMA: hi, reason: `Close ${c.toFixed(2)} is below the ${entryLen}-period high (${hi.toFixed(2)}) — flat, waiting for a breakout` };
  }
  if (c < lo) {
    return { signal: "SELL", fastMA: c, slowMA: lo, reason: `Close ${c.toFixed(2)} broke below the ${exitLen}-period low (${lo.toFixed(2)}) — breakout over, exiting` };
  }
  return { signal: "HOLD", fastMA: c, slowMA: lo, reason: `Close ${c.toFixed(2)} is above the ${exitLen}-period low (${lo.toFixed(2)}) — already long, staying in` };
}

// ---------- Dispatcher: bot.ts / replay.ts call these, not the strategy-specific functions above ----------

/**
 * `inPosition` matters only for state-based strategies (trend following), where
 * the correct action genuinely depends on whether you are already long. Purely
 * event-based strategies (RSI dips, MA crossings) ignore it.
 */
export function computeSignal(candles: Candle[], config: StrategyConfig, inPosition = false): SignalResult {
  if (config.strategyType === "rsi_mean_reversion") {
    return generateRsiSignal(candles, config.rsiPeriod, config.rsiOversold, config.rsiExitLevel);
  }
  if (config.strategyType === "trend_following") {
    return generateTrendSignal(candles, config.trendLookback, inPosition);
  }
  if (config.strategyType === "donchian_breakout") {
    return generateDonchianSignal(candles, config.trendLookback, config.donchianExitRatio, inPosition);
  }
  return generateMaCrossoverSignal(candles, config.fastLen, config.slowLen);
}

/** All entry AND exit events for the whole series (used by both replay styles). */
export function detectAllEvents(candles: Candle[], config: StrategyConfig): CrossoverEvent[] {
  if (config.strategyType === "rsi_mean_reversion") {
    return detectRsiEvents(candles, config.rsiPeriod, config.rsiOversold, config.rsiExitLevel);
  }
  if (config.strategyType === "trend_following") {
    return detectTrendEvents(candles, config.trendLookback);
  }
  if (config.strategyType === "donchian_breakout") {
    return detectDonchianEvents(candles, config.trendLookback, config.donchianExitRatio);
  }
  return detectCrossovers(candles, config.fastLen, config.slowLen);
}

/** Real historical entry setups for replay's forward simulation (only the "bullish"/entry events matter there). */
export function detectEntryEvents(candles: Candle[], config: StrategyConfig): CrossoverEvent[] {
  return detectAllEvents(candles, config);
}
