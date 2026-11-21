// Signal-exit backtesting with a buy-and-hold benchmark.
//
// Two things this fixes that the fixed-window replay could not:
//
// 1. EXITS ON THE STRATEGY'S OWN SIGNAL. The old replay closed every trade
//    after N candles regardless of what the strategy thought, which makes any
//    hold-until-the-trend-breaks strategy untestable and never matched what the
//    live bot actually does.
//
// 2. COMPARES AGAINST DOING NOTHING. A strategy that returns 20% while the
//    asset returned 60% destroyed value. Without the benchmark you cannot tell
//    skill from simply having been exposed to a rising market — and almost
//    every retail backtest omits it, which is why so many losing strategies
//    look like winners.

import { Candle, CostConfig, RiskConfig, SignalTrade, StrategyConfig } from "./types";
import { detectAllEvents } from "./strategy";
import { roundTripCost } from "./backtest";

export interface Benchmark {
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
}

export interface SignalBacktestResult {
  trades: SignalTrade[];
  strategy: Benchmark & { exposurePct: number; tradesPerYear: number; winRatePct: number; avgNetPct: number };
  buyHold: Benchmark;
  years: number;
  roundTripCostPct: number;
}

function maxDrawdownOfSeries(values: number[]): number {
  let peak = values[0] ?? 1;
  let maxDD = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) maxDD = Math.min(maxDD, v / peak - 1);
  }
  return maxDD;
}

function cagr(totalMultiple: number, years: number): number {
  if (years <= 0 || totalMultiple <= 0) return 0;
  return Math.pow(totalMultiple, 1 / years) - 1;
}

/**
 * Walks the candle series once. Enters on a bullish event, exits on a bearish
 * event, a stop, or a target — whichever comes first. Equity compounds across
 * trades, so the result is what an account would actually have done.
 */
export function runSignalBacktest(
  candles: Candle[],
  config: StrategyConfig,
  risk: RiskConfig,
  costs: CostConfig,
  useStops: boolean
): SignalBacktestResult {
  const cost = roundTripCost(costs);
  const events = detectAllEvents(candles, config);

  // index -> event type, for a single O(n) pass
  const eventAt = new Map<number, "bullish" | "bearish">();
  for (const e of events) eventAt.set(e.index, e.type);

  const trades: SignalTrade[] = [];
  let inPosition = false;
  let entryIdx = 0;
  let entryPrice = 0;
  let barsInMarket = 0;

  const closeTrade = (i: number, price: number, reason: SignalTrade["exitReason"]) => {
    const grossPct = (price - entryPrice) / entryPrice;
    trades.push({
      entryTime: candles[entryIdx].closeTime,
      entryPrice,
      exitTime: candles[i].closeTime,
      exitPrice: price,
      exitReason: reason,
      grossPct,
      netPct: grossPct - cost,
      barsHeld: i - entryIdx,
    });
    barsInMarket += i - entryIdx;
    inPosition = false;
  };

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];

    if (inPosition) {
      if (useStops) {
        const stopPrice = entryPrice * (1 - risk.stopLossPct);
        const targetPrice = entryPrice * (1 + risk.takeProfitPct);
        // Conservative: stop checked first when both sit inside one candle.
        if (c.low <= stopPrice) { closeTrade(i, stopPrice, "stop"); continue; }
        if (c.high >= targetPrice) { closeTrade(i, targetPrice, "target"); continue; }
      }
      if (eventAt.get(i) === "bearish") { closeTrade(i, c.close, "signal"); continue; }
    } else if (eventAt.get(i) === "bullish") {
      inPosition = true;
      entryIdx = i;
      entryPrice = c.close;
    }
  }

  // Close any open position at the last available price, flagged honestly.
  if (inPosition) closeTrade(candles.length - 1, candles[candles.length - 1].close, "end-of-data");

  const spanMs = candles[candles.length - 1].closeTime - candles[0].openTime;
  const years = spanMs / (365.25 * 24 * 3600 * 1000);

  // Strategy equity: compound each trade's net return.
  let equity = 1;
  const equityCurve: number[] = [1];
  for (const t of trades) {
    equity *= 1 + t.netPct;
    equityCurve.push(equity);
  }

  // Buy and hold over the identical window, including the cost of the one
  // round trip you'd pay to get in and out.
  const bhMultiple = (candles[candles.length - 1].close / candles[0].close) * (1 - cost);
  const bhCurve = candles.map((c) => c.close / candles[0].close);

  const wins = trades.filter((t) => t.netPct > 0).length;

  return {
    trades,
    strategy: {
      totalReturnPct: equity - 1,
      cagrPct: cagr(equity, years),
      maxDrawdownPct: maxDrawdownOfSeries(equityCurve),
      exposurePct: candles.length ? barsInMarket / candles.length : 0,
      tradesPerYear: years > 0 ? trades.length / years : 0,
      winRatePct: trades.length ? wins / trades.length : 0,
      avgNetPct: trades.length ? trades.reduce((s, t) => s + t.netPct, 0) / trades.length : 0,
    },
    buyHold: {
      totalReturnPct: bhMultiple - 1,
      cagrPct: cagr(bhMultiple, years),
      maxDrawdownPct: maxDrawdownOfSeries(bhCurve),
    },
    years,
    roundTripCostPct: cost,
  };
}

/**
 * The verdict that matters. Beating zero is not the bar — beating the asset you
 * were trading is, because holding it required no work and no risk of bugs.
 */
export function verdict(r: SignalBacktestResult): string[] {
  const lines: string[] = [];
  const s = r.strategy, b = r.buyHold;

  if (r.trades.length < 20) {
    lines.push(`INCONCLUSIVE — only ${r.trades.length} trades. Too few to judge, whatever the return says.`);
    lines.push(`  Use a longer history before drawing any conclusion from this.`);
    return lines;
  }

  const beatsBuyHold = s.cagrPct > b.cagrPct;
  const betterDrawdown = s.maxDrawdownPct > b.maxDrawdownPct; // both negative; closer to 0 is better

  if (!beatsBuyHold && !betterDrawdown) {
    lines.push(`FAILS BOTH TESTS. Lower return than holding (${(s.cagrPct * 100).toFixed(1)}%/yr vs ${(b.cagrPct * 100).toFixed(1)}%/yr)`);
    lines.push(`  and a worse drawdown (${(s.maxDrawdownPct * 100).toFixed(1)}% vs ${(b.maxDrawdownPct * 100).toFixed(1)}%).`);
    lines.push(`  Holding the asset beat the strategy on both counts. There is nothing to salvage here.`);
  } else if (!beatsBuyHold && betterDrawdown) {
    lines.push(`LOWER RETURN, SMOOTHER RIDE. ${(s.cagrPct * 100).toFixed(1)}%/yr vs ${(b.cagrPct * 100).toFixed(1)}%/yr holding,`);
    lines.push(`  but max drawdown ${(s.maxDrawdownPct * 100).toFixed(1)}% vs ${(b.maxDrawdownPct * 100).toFixed(1)}%.`);
    lines.push(`  This is the classic trend-following trade-off: you give up upside for a shallower hole.`);
    lines.push(`  Whether that is worth it is a judgement about risk tolerance, not a fact the data settles.`);
  } else if (beatsBuyHold && !betterDrawdown) {
    lines.push(`HIGHER RETURN, DEEPER DRAWDOWN. ${(s.cagrPct * 100).toFixed(1)}%/yr vs ${(b.cagrPct * 100).toFixed(1)}%/yr,`);
    lines.push(`  but it fell ${(s.maxDrawdownPct * 100).toFixed(1)}% at worst against ${(b.maxDrawdownPct * 100).toFixed(1)}% for holding.`);
    lines.push(`  Check whether the extra return is just leverage-like risk-taking rather than skill.`);
  } else {
    lines.push(`BEATS BUY-AND-HOLD ON BOTH. ${(s.cagrPct * 100).toFixed(1)}%/yr vs ${(b.cagrPct * 100).toFixed(1)}%/yr,`);
    lines.push(`  drawdown ${(s.maxDrawdownPct * 100).toFixed(1)}% vs ${(b.maxDrawdownPct * 100).toFixed(1)}%.`);
    lines.push(`  Promising — and exactly the moment to be most suspicious of yourself. This is ONE window`);
    lines.push(`  on data you have now looked at. Confirm on a period you have never tested before it means anything.`);
  }

  if (s.exposurePct < 0.35) {
    lines.push(`\n  Note: in the market only ${(s.exposurePct * 100).toFixed(0)}% of the time. Lower exposure means less`);
    lines.push(`  risk taken, so compare returns per unit of time invested, not just headline totals.`);
  }
  return lines;
}
