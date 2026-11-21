// Orchestrates one scan cycle: real market data -> signal -> risk -> memory -> paper execution.
// A small local state file (data/state.json) tracks only what's needed to run
// correctly across runs: whether we're currently "in" a paper position, and
// today's cumulative simulated PnL for the daily-loss check. That's execution
// state, separate from the ledger/learnings memory system below.
//
// Memory: before a fresh BUY is actually opened, we check data/ledger.csv for
// this exact setup+symbol. If the last 2 real closed trades for it were both
// losses, the BUY is downgraded to SKIP and logged as such. SELL (closing an
// existing position) is never blocked by memory. Every real BUY/SELL/SKIP
// this bot takes is appended to data/ledger.csv; real closed losses get a
// plain-English line in data/learnings.md.

import * as fs from "fs";
import * as path from "path";
import { fetchCandles } from "./market";
import { computeSignal } from "./strategy";
import { checkRisk } from "./risk";
import { simulatePaperOrder } from "./execution";
import { appendLedgerRow, appendLearning, readLedger } from "./memory";
import { checkMemory } from "./adaptiveFilter";
import { BotState, CostConfig, RiskConfig, StrategyConfig } from "./types";

const STATE_PATH = path.join(__dirname, "..", "data", "state.json");

// DEFAULTS REFLECT WHAT SURVIVED TESTING.
//
// Two strategies were tested to conclusion and rejected:
//   - 9/21 MA crossover on 5m: no edge.
//   - RSI(14) mean-reversion: gross edge 0.00% over 343 trades across 2.6 years,
//     standard error 0.034%. The data actively EXCLUDES an edge big enough to
//     clear costs. It is kept in the codebase for comparison only.
//
// Trend following survived: drawdown reduction held in 28/28 parameter-era
// combinations over 9 years. Its return advantage remains unproven (18/28,
// p=0.092), so this is a risk-reduction tool, not a money printer — but it is
// the only configuration here supported by evidence, so it is the default.
//
// Override per-run with env vars: STRATEGY, INTERVAL, TREND_LOOKBACK, SYMBOL.
export const STRATEGY_CONFIG: StrategyConfig = {
  symbol: process.env.SYMBOL ?? "BTCUSDT",
  interval: process.env.INTERVAL ?? "1d",
  strategyType: (process.env.STRATEGY as StrategyConfig["strategyType"]) ?? "trend_following",
  fastLen: 9,
  slowLen: 21,
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiExitLevel: 50,
  trendLookback: Number(process.env.TREND_LOOKBACK ?? 100),
  donchianExitRatio: Number(process.env.DONCHIAN_EXIT_RATIO ?? 0.5),
};

export const RISK_CONFIG: RiskConfig = {
  quantity: 0.01,
  maxPosition: 0.01,
  stopLossPct: 0.01,
  takeProfitPct: 0.02,
  maxDailyLossPct: 0.03,
};

// Real Binance spot costs. Override via .env if your fee tier differs.
// Round trip = 2 x (fee + slippage). At these defaults that's 0.22% — which any
// strategy must clear per trade before it makes a single cent.
export const COST_CONFIG: CostConfig = {
  feePctPerSide: Number(process.env.FEE_PCT_PER_SIDE ?? 0.001),
  slippagePctPerSide: Number(process.env.SLIPPAGE_PCT_PER_SIDE ?? 0.0001),
};

export const SETUP_KEY = `setup:${STRATEGY_CONFIG.strategyType}`;

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadState(): BotState {
  if (!fs.existsSync(STATE_PATH)) {
    return { date: todayUTC(), dailyPnLPct: 0, inPosition: false, entryPrice: null, quantity: null };
  }
  const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as BotState;
  if (raw.date !== todayUTC()) {
    // New UTC day — reset the daily loss counter. Position state carries over.
    return { ...raw, date: todayUTC(), dailyPnLPct: 0 };
  }
  return raw;
}

function saveState(state: BotState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export async function runScan(): Promise<void> {
  log(`Scanning ${STRATEGY_CONFIG.symbol} on ${STRATEGY_CONFIG.interval}...`);

  const lookback = STRATEGY_CONFIG.strategyType === "rsi_mean_reversion" ? STRATEGY_CONFIG.rsiPeriod + 5 : STRATEGY_CONFIG.slowLen + 5;
  const candles = await fetchCandles(STRATEGY_CONFIG.symbol, STRATEGY_CONFIG.interval, lookback);
  log(`Loaded ${candles.length} real candles from Binance public API. Latest close: ${candles[candles.length - 1].close}`);

  // State must be loaded BEFORE computing the signal: state-based strategies
  // (trend following) give a different answer depending on whether we're long.
  const state = loadState();

  const signalResult = computeSignal(candles, STRATEGY_CONFIG, state.inPosition);
  log(`Signal: ${signalResult.signal} — ${signalResult.reason}`);

  let risk = checkRisk(signalResult.signal, RISK_CONFIG, {
    inPosition: state.inPosition,
    dailyPnLPct: state.dailyPnLPct,
  });
  log(`Risk check: ${risk.action} (approved=${risk.approved}) — ${risk.reason}`);

  const latestClose = candles[candles.length - 1].close;
  const taggedReason = `${signalResult.reason} [${SETUP_KEY}]`;

  // Memory gate: only for a fresh BUY. Never blocks a SELL.
  if (risk.action === "BUY") {
    const ledger = readLedger();
    const mem = checkMemory(STRATEGY_CONFIG.symbol, SETUP_KEY, ledger);
    log(`Memory check: ${mem.reason}`);
    if (mem.skip) {
      log(`Memory overrides risk approval — downgrading BUY to SKIP.`);
      risk = { action: "SKIP", approved: false, reason: mem.reason };
    }
  }

  if (risk.action === "BUY") {
    const fill = simulatePaperOrder("BUY", latestClose, RISK_CONFIG.quantity);
    state.inPosition = true;
    state.entryPrice = fill.price;
    state.quantity = fill.quantity;
    log(`PAPER ORDER: BUY ${fill.quantity} ${STRATEGY_CONFIG.symbol} @ ${fill.price} (simulated, no real order sent)`);
    appendLedgerRow({
      timestamp: new Date(fill.timestamp).toISOString(),
      symbol: STRATEGY_CONFIG.symbol,
      action: "BUY",
      price: String(fill.price),
      quantity: String(fill.quantity),
      reason: taggedReason,
      mode: "live",
      outcome: "open",
      pnl: "",
    });
  } else if (risk.action === "SELL" && state.entryPrice !== null && state.quantity !== null) {
    const fill = simulatePaperOrder("SELL", latestClose, state.quantity);
    const pnlPct = (fill.price - state.entryPrice) / state.entryPrice;
    state.dailyPnLPct += pnlPct;
    log(
      `PAPER ORDER: SELL ${fill.quantity} ${STRATEGY_CONFIG.symbol} @ ${fill.price} (simulated). Trade PnL: ${(pnlPct * 100).toFixed(2)}%. Daily PnL: ${(state.dailyPnLPct * 100).toFixed(2)}%`
    );
    const outcome = pnlPct >= 0 ? "win" : "loss";
    appendLedgerRow({
      timestamp: new Date(fill.timestamp).toISOString(),
      symbol: STRATEGY_CONFIG.symbol,
      action: "SELL",
      price: String(fill.price),
      quantity: String(fill.quantity),
      reason: taggedReason,
      mode: "live",
      outcome,
      pnl: (pnlPct * 100).toFixed(4),
    });
    if (outcome === "loss") {
      appendLearning(
        `${STRATEGY_CONFIG.symbol} ${STRATEGY_CONFIG.strategyType} trade closed at a real loss (${(pnlPct * 100).toFixed(2)}%) on ${todayUTC()} — watch for repeats of this setup.`
      );
    }
    state.inPosition = false;
    state.entryPrice = null;
    state.quantity = null;
  } else {
    log(`Final decision: ${risk.action}. No paper order was sent.`);
    if (risk.action === "SKIP") {
      appendLedgerRow({
        timestamp: new Date().toISOString(),
        symbol: STRATEGY_CONFIG.symbol,
        action: "SKIP",
        price: String(latestClose),
        quantity: "",
        reason: risk.reason.includes(SETUP_KEY) ? risk.reason : `${risk.reason} [${SETUP_KEY}]`,
        mode: "live",
        outcome: "skipped",
        pnl: "",
      });
    }
  }

  saveState(state);
}
