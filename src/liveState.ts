// Persistence for the live/testnet bot's execution state.
//
// Split out of brokerLive.ts so it can be tested directly: state handling is
// where a crash does its real damage, and code that can only be tested by
// running the whole bot against an exchange does not get tested.
//
// Two rules govern this file:
//   1. A write is atomic. The file is always a complete old version or a
//      complete new one, never half of either.
//   2. An unreadable file is an error, never an assumption. "I cannot read my
//      notes" must never be silently converted into "I hold nothing".

import * as fs from "fs";
import * as path from "path";
import { BotState } from "./types";

export const LIVE_STATE_PATH = path.join(__dirname, "..", "data", "live-state.json");

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export function freshState(): BotState {
  return {
    date: todayUTC(),
    dailyPnLPct: 0,
    inPosition: false,
    entryPrice: null,
    quantity: null,
    pendingOrder: null,
  };
}

/**
 * Loads state, or throws.
 *
 * A missing file is genuinely a fresh start. A corrupt one is an emergency:
 * falling back to a flat position there would mean buying on top of a position
 * the bot already holds. Refusing to trade is the only safe response.
 */
export function loadState(statePath: string = LIVE_STATE_PATH): BotState {
  if (!fs.existsSync(statePath)) return freshState();

  let raw: BotState;
  try {
    raw = JSON.parse(fs.readFileSync(statePath, "utf-8")) as BotState;
  } catch (err) {
    throw new Error(
      `State file at ${statePath} is unreadable (${(err as Error).message}). ` +
        `REFUSING TO TRADE — a corrupt state file is not the same as a flat position. ` +
        `Check your real balances with "npm run broker:check", then either repair the file, ` +
        `or delete it if you are certain the bot holds nothing.`
    );
  }

  if (raw === null || typeof raw !== "object" || typeof raw.inPosition !== "boolean") {
    throw new Error(
      `State file at ${statePath} parsed but is not a valid bot state. REFUSING TO TRADE. ` +
        `Check your real balances with "npm run broker:check" before continuing.`
    );
  }

  // New UTC day resets the daily-loss counter; position state carries over.
  if (raw.date !== todayUTC()) return { ...raw, date: todayUTC(), dailyPnLPct: 0 };
  return raw;
}

/**
 * Live-money variant: a MISSING state file is refused, not treated as flat.
 *
 * Added 2026-10-26 after real-state.json went missing (the bot had traded from
 * a different machine, and that copy was lost). loadState() treating "no file"
 * as "no position" is correct for paper and testnet, where the worst case is a
 * wasted simulated order. With real money it is the most expensive assumption
 * in the project: the bot would have opened a SECOND live position on top of
 * one it still held, and with no record of the first it could never close it.
 *
 * A genuinely fresh live start is still possible — it just has to be stated on
 * purpose, by creating the file with `npm run state:init`, rather than inferred
 * from a file that isn't there.
 */
export function loadRealStateStrict(statePath: string): BotState {
  if (!fs.existsSync(statePath)) {
    throw new Error(
      `No live state file at ${statePath}.\n\n` +
        `REFUSING TO TRADE. A missing state file is not proof of a flat position — it is the\n` +
        `absence of information. If the bot already holds coins and this run assumed flat, it\n` +
        `would buy a second time and never be able to sell the first.\n\n` +
        `Check what you actually hold first:   npm run live:check\n\n` +
        `Then state it deliberately:\n` +
        `  holding nothing:        npm run state:init -- --flat\n` +
        `  holding a position:     npm run state:init -- --qty <BTC> --entry <price>`
    );
  }
  return loadState(statePath);
}

/**
 * Atomic write: temp file, fsync, rename. Without the fsync a power cut can
 * reorder the write and the rename, leaving an empty file under the real name —
 * which is exactly the corrupt-state case above, self-inflicted.
 */
export function saveState(state: BotState, statePath: string = LIVE_STATE_PATH): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, statePath);
}
