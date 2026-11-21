// Creates data/real-state.json — the live bot's record of what it holds.
//
//   npm run state:init -- --flat                    (holding nothing)
//   npm run state:init -- --qty 0.00031968 --entry 76837.66
//
// Exists because `brokerLiveReal.ts` now REFUSES to run without this file
// (see loadRealStateStrict). A fresh live start has to be an explicit act, not
// an inference drawn from a file that happens to be absent.
//
// It writes only what you state. Nothing is fetched, guessed or reconstructed
// from the ledger: the quantity must come from the exchange — `live:check`
// prints your real free balance — because the wallet is the only ground truth
// about what you own.

import * as fs from "fs";
import * as path from "path";
import { saveState, loadState, todayUTC } from "./liveState";
import { BotState } from "./types";

const REAL_STATE_PATH = path.join(__dirname, "..", "data", "real-state.json");

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function fail(msg: string): never {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

function main(): void {
  const flat = process.argv.includes("--flat");
  const force = process.argv.includes("--force");
  const qtyRaw = argValue("--qty");
  const entryRaw = argValue("--entry");

  if (!flat && qtyRaw === null) {
    fail(
      `Say what the bot holds.\n\n` +
        `  npm run state:init -- --flat\n` +
        `  npm run state:init -- --qty <BTC> --entry <price>\n\n` +
        `Get the quantity from your exchange balance (npm run live:check), not from memory.`
    );
  }
  if (flat && qtyRaw !== null) {
    fail(`--flat and --qty contradict each other. Pick one.`);
  }

  if (fs.existsSync(REAL_STATE_PATH) && !force) {
    const current = fs.readFileSync(REAL_STATE_PATH, "utf-8");
    fail(
      `${REAL_STATE_PATH} already exists. Refusing to overwrite the live position record.\n\n` +
        `Current contents:\n${current}\n` +
        `If you are certain it is wrong, re-run with --force.`
    );
  }

  let state: BotState;

  if (flat) {
    state = { date: todayUTC(), dailyPnLPct: 0, inPosition: false, entryPrice: null, quantity: null, pendingOrder: null };
  } else {
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty <= 0) fail(`--qty must be a positive number, got "${qtyRaw}".`);

    if (entryRaw === null) fail(`--entry <price> is required with --qty: PnL on the exit is measured against it.`);
    const entry = Number(entryRaw);
    if (!Number.isFinite(entry) || entry <= 0) fail(`--entry must be a positive number, got "${entryRaw}".`);

    state = { date: todayUTC(), dailyPnLPct: 0, inPosition: true, entryPrice: entry, quantity: qty, pendingOrder: null };
  }

  saveState(state, REAL_STATE_PATH);

  // Read it back through the same loader the bot uses. A file this tool wrote
  // but the bot would reject is worse than no file at all.
  const verified = loadState(REAL_STATE_PATH);
  if (verified.inPosition !== state.inPosition || verified.quantity !== state.quantity) {
    fail(`Wrote ${REAL_STATE_PATH} but reading it back gave something different. Do not trade; inspect the file.`);
  }

  console.log(`\nWrote ${REAL_STATE_PATH}:\n`);
  console.log(JSON.stringify(verified, null, 2));
  console.log(
    state.inPosition
      ? `\nThe bot now believes it holds ${state.quantity} bought at ${state.entryPrice}.\n` +
          `It will only ever sell what it recorded here, and never more than the wallet holds.\n` +
          `Verify against the exchange before trading:   npm run live:check\n`
      : `\nThe bot now believes it holds nothing, and may open a position when the strategy says so.\n` +
          `Verify against the exchange before trading:   npm run live:check\n`
  );
}

main();
