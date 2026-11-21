// Shared types for the trading bot.
// This first phase has no memory system (no ledger.csv, no learnings.md) —
// that's added in a later phase. Everything here is paper/local only.

export interface Candle {
  openTime: number;   // ms epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;  // ms epoch
}

export type StrategySignal = "BUY" | "SELL" | "HOLD";
export type DecisionAction = "BUY" | "SELL" | "HOLD" | "SKIP";

export type StrategyType = "ma_crossover" | "rsi_mean_reversion" | "trend_following" | "donchian_breakout";

export interface StrategyConfig {
  symbol: string;
  interval: string; // Binance interval string, e.g. "5m"
  strategyType: StrategyType;
  // MA crossover params (used when strategyType === "ma_crossover")
  fastLen: number;
  slowLen: number;
  // RSI mean-reversion params (used when strategyType === "rsi_mean_reversion")
  rsiPeriod: number;
  rsiOversold: number;
  rsiExitLevel: number;
  // Trend-following params (used when strategyType === "trend_following")
  // Long while price is above its `trendLookback`-period moving average, flat below.
  // On daily candles a lookback of 100-200 is the classic time-series-momentum range.
  trendLookback: number;
  // Donchian breakout params (used when strategyType === "donchian_breakout").
  // Entry window = trendLookback (so every existing sweep/era tool varies it).
  // Exit window = round(trendLookback * donchianExitRatio), floored at 2 —
  // a faster exit than entry is what makes the strategy trade more often than
  // a moving-average filter does.
  donchianExitRatio: number;
}

/** One completed trade in a signal-exit backtest (held until the strategy says exit). */
export interface SignalTrade {
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "signal" | "stop" | "target" | "end-of-data";
  grossPct: number;
  netPct: number;
  barsHeld: number;
}

export interface RiskConfig {
  quantity: number;        // paper quantity per trade, e.g. BTC amount
  maxPosition: number;     // max quantity allowed open at once
  stopLossPct: number;     // e.g. 0.01 = 1%
  takeProfitPct: number;   // e.g. 0.02 = 2%
  maxDailyLossPct: number; // e.g. 0.03 = 3%, as a fraction of paper "equity" (tracked via cumulative % PnL)
}

export interface BotState {
  date: string;            // YYYY-MM-DD (UTC), for daily-loss reset
  dailyPnLPct: number;     // cumulative simulated PnL % for the current date
  inPosition: boolean;
  entryPrice: number | null;
  quantity: number | null;
  /**
   * An order we are ABOUT to send, written to disk before it leaves. If the
   * process dies between sending and recording the fill, this is the only
   * evidence the order ever existed — and the client ID is what lets the next
   * run ask the exchange what became of it. Cleared once the outcome is known.
   */
  pendingOrder?: PendingOrder | null;
}

export interface PendingOrder {
  clientOrderId: string;
  side: "BUY" | "SELL";
  quantity: number;
  symbol: string;
  sentAt: string;          // ISO timestamp
}

export interface CrossoverEvent {
  index: number;
  timestamp: number;
  type: "bullish" | "bearish";
  price: number;
}

export interface SignalResult {
  signal: StrategySignal;
  fastMA: number;
  slowMA: number;
  reason: string;
}

export interface RiskResult {
  action: DecisionAction;
  approved: boolean;
  reason: string;
}

/** Real trading costs. Gross expectancy that doesn't survive these is not an edge. */
export interface CostConfig {
  feePctPerSide: number;      // Binance spot standard is 0.001 (0.10%) per side; 0.00075 with BNB discount
  slippagePctPerSide: number; // realistic for a small BTCUSDT market order; raise for thinner pairs
}

export interface ReplayTrade {
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  outcome: "win" | "loss" | "timeout";
  pnlPct: number;    // gross — price move only
  netPnlPct: number; // after fees and slippage — the number that matters for a real account
}
