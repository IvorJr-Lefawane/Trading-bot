// Risk gate: every signal passes through here before anything is "executed".
// The strategy proposes; risk disposes. Every result carries a plain-English reason.
//
// This module is mode-agnostic: the same gate runs for paper scans and testnet
// orders, so its reason strings must never claim which one is happening. The
// caller (bot.ts / brokerLive.ts) reports that.

import { RiskConfig, RiskResult, StrategySignal } from "./types";

export interface RiskContext {
  inPosition: boolean;
  dailyPnLPct: number; // negative = losing day so far
}

export function checkRisk(signal: StrategySignal, config: RiskConfig, ctx: RiskContext): RiskResult {
  // Note: this module is strategy-agnostic on purpose (MA crossover, RSI, or
  // anything else) — the strategy-specific "why" already came from
  // computeSignal()'s own reason string, logged separately. These messages
  // just explain the risk-layer decision on top of that signal.
  if (signal === "HOLD") {
    return { action: "HOLD", approved: false, reason: "No fresh entry/exit signal — nothing to do." };
  }

  if (signal === "BUY") {
    if (ctx.inPosition) {
      return { action: "HOLD", approved: false, reason: "Fresh BUY signal, but already in a position — ignoring duplicate entry." };
    }
    if (config.quantity > config.maxPosition) {
      return { action: "SKIP", approved: false, reason: `Configured quantity (${config.quantity}) exceeds max position (${config.maxPosition}).` };
    }
    if (ctx.dailyPnLPct <= -config.maxDailyLossPct) {
      return {
        action: "SKIP",
        approved: false,
        reason: `Daily loss limit reached (${(ctx.dailyPnLPct * 100).toFixed(2)}% <= -${(config.maxDailyLossPct * 100).toFixed(2)}%). No new positions until the next day.`,
      };
    }
    return { action: "BUY", approved: true, reason: "Fresh entry signal, risk checks passed — opening a position." };
  }

  // signal === "SELL"
  if (!ctx.inPosition) {
    return { action: "HOLD", approved: false, reason: "Fresh SELL/exit signal, but no open position to sell." };
  }
  return { action: "SELL", approved: true, reason: "Exit signal — closing the open position." };
}
