// Pure backtest logic, shared by replay:raw and replay:windows.
// Every trade is reported BOTH gross (price move only) and NET (after real
// trading costs). Net is the only number that matters for a real account —
// gross expectancy that doesn't survive fees is not an edge, it's a fee
// generator.

import { Candle, CostConfig, ReplayTrade, RiskConfig } from "./types";

export interface BacktestSummary {
  totalSetups: number;
  skippedNoForwardData: number;
  winsNet: number;
  lossesNet: number;
  winRateNet: number;
  avgGrossPct: number;
  avgNetPct: number;
  bestNetPct: number;
  worstNetPct: number;
  totalNetPct: number;
  maxDrawdownNetPct: number;
  roundTripCostPct: number;
}

/** Total cost of opening AND closing one position, as a fraction (e.g. 0.0022 = 0.22%). */
export function roundTripCost(costs: CostConfig): number {
  return 2 * (costs.feePctPerSide + costs.slippagePctPerSide);
}

/**
 * Catches a degenerate test configuration: if the take-profit target is
 * smaller than the round-trip cost, then even a PERFECT winning trade loses
 * money, and the backtest is measuring the fee schedule rather than the
 * strategy. Any result from such a config is meaningless, so say so loudly
 * instead of reporting an impressive-looking 0% win rate.
 */
export function checkConfigViability(
  takeProfitPct: number,
  stopLossPct: number,
  costs: CostConfig
): { viable: boolean; warning: string | null } {
  const cost = roundTripCost(costs);

  if (takeProfitPct <= cost) {
    return {
      viable: false,
      warning:
        `DEGENERATE CONFIGURATION — RESULTS ARE MEANINGLESS.\n` +
        `  Take-profit target: ${(takeProfitPct * 100).toFixed(3)}%\n` +
        `  Round-trip cost:    ${(cost * 100).toFixed(3)}%\n` +
        `  The target is smaller than the cost of trading, so even a perfect winning trade nets\n` +
        `  ${((takeProfitPct - cost) * 100).toFixed(3)}%. A 0% win rate here proves nothing about the strategy — it is\n` +
        `  arithmetic. Use a longer timeframe, a wider target, or lower fees before testing.`,
    };
  }

  if (takeProfitPct < cost * 2) {
    return {
      viable: true,
      warning:
        `Thin configuration: target ${(takeProfitPct * 100).toFixed(3)}% is less than 2x the ${(cost * 100).toFixed(3)}% round-trip cost.\n` +
        `  Winners barely clear costs while losers pay them in full. Treat any positive result with suspicion.`,
    };
  }

  // A stop tighter than the cost means noise alone triggers unprofitable exits.
  if (stopLossPct < cost / 2) {
    return {
      viable: true,
      warning:
        `Very tight stop: ${(stopLossPct * 100).toFixed(3)}% is under half the ${(cost * 100).toFixed(3)}% round-trip cost.\n` +
        `  Ordinary market noise will stop you out repeatedly, each time paying full costs.`,
    };
  }

  return { viable: true, warning: null };
}

export function simulateForwardTrade(
  candles: Candle[],
  entryIndex: number,
  forwardCandles: number,
  risk: RiskConfig,
  costs: CostConfig
): ReplayTrade | null {
  const entry = candles[entryIndex];
  const endIndex = entryIndex + forwardCandles;
  if (endIndex >= candles.length) return null; // not enough real forward data yet

  const entryPrice = entry.close;
  const stopPrice = entryPrice * (1 - risk.stopLossPct);
  const targetPrice = entryPrice * (1 + risk.takeProfitPct);
  const cost = roundTripCost(costs);

  const finish = (exitTime: number, exitPrice: number, outcome: ReplayTrade["outcome"], grossPct: number): ReplayTrade => ({
    entryTime: entry.closeTime,
    entryPrice,
    exitTime,
    exitPrice,
    outcome,
    pnlPct: grossPct,
    netPnlPct: grossPct - cost,
  });

  for (let i = entryIndex + 1; i <= endIndex; i++) {
    const c = candles[i];
    // Conservative: if both thresholds sit inside the same candle's range,
    // assume the stop was hit first (worst case, not optimistic).
    if (c.low <= stopPrice) return finish(c.closeTime, stopPrice, "loss", -risk.stopLossPct);
    if (c.high >= targetPrice) return finish(c.closeTime, targetPrice, "win", risk.takeProfitPct);
  }

  const last = candles[endIndex];
  return finish(last.closeTime, last.close, "timeout", (last.close - entryPrice) / entryPrice);
}

function maxDrawdown(values: number[]): number {
  let cumulative = 0, peak = 0, maxDD = 0;
  for (const v of values) {
    cumulative += v;
    peak = Math.max(peak, cumulative);
    maxDD = Math.min(maxDD, cumulative - peak);
  }
  return maxDD;
}

export function summarize(trades: ReplayTrade[], skippedNoForwardData: number, costs: CostConfig): BacktestSummary {
  const winsNet = trades.filter((t) => t.netPnlPct > 0).length;
  const lossesNet = trades.length - winsNet;
  const netSeries = trades.map((t) => t.netPnlPct);

  return {
    totalSetups: trades.length,
    skippedNoForwardData,
    winsNet,
    lossesNet,
    winRateNet: trades.length ? winsNet / trades.length : 0,
    avgGrossPct: trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0,
    avgNetPct: trades.length ? netSeries.reduce((s, v) => s + v, 0) / trades.length : 0,
    bestNetPct: trades.length ? Math.max(...netSeries) : 0,
    worstNetPct: trades.length ? Math.min(...netSeries) : 0,
    totalNetPct: netSeries.reduce((s, v) => s + v, 0),
    maxDrawdownNetPct: maxDrawdown(netSeries),
    roundTripCostPct: roundTripCost(costs),
  };
}

export function runBacktest(
  candles: Candle[],
  entryIndexes: number[],
  forwardCandles: number,
  risk: RiskConfig,
  costs: CostConfig
): { trades: ReplayTrade[]; summary: BacktestSummary } {
  const trades: ReplayTrade[] = [];
  let skipped = 0;
  for (const idx of entryIndexes) {
    const t = simulateForwardTrade(candles, idx, forwardCandles, risk, costs);
    if (t) trades.push(t);
    else skipped++;
  }
  return { trades, summary: summarize(trades, skipped, costs) };
}

/**
 * Rough, honest read on whether a result means anything at all.
 * With small samples, an apparent edge is usually noise. This computes the
 * standard error of the mean net return and reports how many standard errors
 * the result sits from zero — under ~2, treat it as indistinguishable from luck.
 */
export function significance(trades: ReplayTrade[]): { stdErrPct: number; tStat: number; verdict: string } {
  const n = trades.length;
  if (n < 2) return { stdErrPct: 0, tStat: 0, verdict: "Not enough trades to say anything." };

  const mean = trades.reduce((s, t) => s + t.netPnlPct, 0) / n;
  const variance = trades.reduce((s, t) => s + Math.pow(t.netPnlPct - mean, 2), 0) / (n - 1);
  const stdErr = Math.sqrt(variance / n);
  const tStat = stdErr === 0 ? 0 : mean / stdErr;

  let verdict: string;
  if (Math.abs(tStat) < 2) {
    verdict = `Statistically indistinguishable from random (|t| = ${Math.abs(tStat).toFixed(2)}, needs > 2). This result is noise, in either direction.`;
  } else if (tStat >= 2) {
    verdict = `Positive and statistically distinguishable from zero (t = ${tStat.toFixed(2)}) in THIS window. Still needs to hold across other windows and regimes.`;
  } else {
    verdict = `Negative and statistically distinguishable from zero (t = ${tStat.toFixed(2)}). This strategy lost money here in a way that isn't just luck.`;
  }
  return { stdErrPct: stdErr * 100, tStat, verdict };
}
