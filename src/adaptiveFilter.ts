// Decides whether a fresh BUY signal should be SKIPped because the same
// setup has a real, recent losing pattern in the ledger. Deliberately never
// blocks a SELL — exiting an open position shouldn't be held hostage by memory.
// The rule is intentionally simple and explainable: skip only when the last
// TWO real closed trades for this exact setup+symbol were both losses. That's
// "repeating a known bad trade," not "ever lost once."

import { LedgerRow } from "./memory";

export interface MemoryCheck {
  skip: boolean;
  reason: string;
  closedCount: number;
}

/** A row counts as real, closed, learnable history — not an open position or a memory-skip. */
function isClosed(row: LedgerRow): boolean {
  return row.mode !== "memory" && (row.outcome === "win" || row.outcome === "loss" || row.outcome === "timeout") && row.pnl !== "";
}

export function checkMemory(symbol: string, setupKey: string, ledger: LedgerRow[]): MemoryCheck {
  const relevant = ledger
    .filter((r) => r.symbol === symbol && r.reason.includes(setupKey) && isClosed(r))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (relevant.length < 2) {
    return {
      skip: false,
      closedCount: relevant.length,
      reason:
        relevant.length === 0
          ? `No closed trades yet for "${setupKey}" on ${symbol} — run replay:raw first to build up real memory.`
          : `Only ${relevant.length} closed trade on record for "${setupKey}" on ${symbol} — not enough real history yet to judge a pattern.`,
    };
  }

  const lastTwo = relevant.slice(-2);
  const bothLosses = lastTwo.every((r) => Number(r.pnl) < 0);

  if (bothLosses) {
    return {
      skip: true,
      closedCount: relevant.length,
      reason: `Last 2 closed trades for "${setupKey}" on ${symbol} were both losses (${lastTwo
        .map((r) => `${r.timestamp}: ${r.pnl}%`)
        .join(", ")}) — skipping to avoid repeating a known bad pattern.`,
    };
  }

  return {
    skip: false,
    closedCount: relevant.length,
    reason: `${relevant.length} closed trades on record for "${setupKey}" on ${symbol}; most recent 2 don't show a repeated loss.`,
  };
}
