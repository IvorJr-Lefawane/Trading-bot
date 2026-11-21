// Demonstrates what memory WOULD do on the most recent real entry candidate.
// This command never places a paper order itself — it only ever ends in
// SKIP (memory blocks it, based on real closed trades) or HOLD (no fresh
// candidate, or not enough real memory yet to judge a pattern). Live trading
// that actually acts on memory happens in `npm run scan`, which now also
// consults the same ledger/learnings before opening a position.

import { fetchCandles } from "./market";
import { detectEntryEvents } from "./strategy";
import { checkRisk } from "./risk";
import { readLedger, readLearnings } from "./memory";
import { checkMemory } from "./adaptiveFilter";
import { STRATEGY_CONFIG, RISK_CONFIG, SETUP_KEY } from "./bot";
import { assertPaperMode } from "./guardrails";

const LOOKBACK = Number(process.env.REPLAY_MEMORY_LOOKBACK ?? 500); // recent real candles to search for a candidate

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  assertPaperMode(); // refuses to run if credentials or a non-paper mode are present

  log(`Scanner started for ${STRATEGY_CONFIG.symbol} on ${STRATEGY_CONFIG.interval} (memory-aware mode)`);

  const candles = await fetchCandles(STRATEGY_CONFIG.symbol, STRATEGY_CONFIG.interval, LOOKBACK);
  log(`Loaded ${candles.length} real candles from Binance public API`);

  const events = detectEntryEvents(candles, STRATEGY_CONFIG);
  const bullish = events.filter((e) => e.type === "bullish");
  if (bullish.length === 0) {
    log(`No entry setup found in the last ${LOOKBACK} real candles. Decision: HOLD. No paper order was sent.`);
    return;
  }
  const candidate = bullish[bullish.length - 1];
  log(`Detected a ${STRATEGY_CONFIG.strategyType} entry candidate at ${new Date(candidate.timestamp).toISOString()}, price ${candidate.price}`);

  const risk = checkRisk("BUY", RISK_CONFIG, { inPosition: false, dailyPnLPct: 0 });
  log(`Risk check: ${risk.action} (approved=${risk.approved}) — ${risk.reason}`);
  if (!risk.approved) {
    log("Decision: HOLD. No paper order was sent.");
    return;
  }

  const ledger = readLedger();
  log(`Loaded data/ledger.csv (${ledger.length} rows)`);
  const learningsText = readLearnings();
  const lessonCount = learningsText.split("\n").filter((l) => l.startsWith("- ")).length;
  log(`Loaded data/learnings.md (${lessonCount} lesson${lessonCount === 1 ? "" : "s"} on record)`);

  const mem = checkMemory(STRATEGY_CONFIG.symbol, SETUP_KEY, ledger);
  log(`Memory check: ${mem.reason}`);

  if (mem.skip) {
    log(`Decision: SKIP — memory blocks this setup based on real closed trades. No paper order was sent.`);
  } else if (mem.closedCount < 2) {
    log(`Decision: HOLD — not enough real closed memory yet for this setup. Run npm run replay:raw first, or keep paper testing with npm run scan. No paper order was sent.`);
  } else {
    log(`Decision: HOLD — no repeated real loss found for this setup. This command never executes a trade itself; run npm run scan to actually act on live signals (it checks the same memory). No paper order was sent.`);
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
