// Live trading loop against Binance Spot Testnet.
//
// Signal -> risk -> memory -> real testnet order, on a timer. Everything the
// paper bot does, except the fill comes from an exchange instead of a
// simulation.
//
// Reconciliation runs before every decision: what the bot BELIEVES it holds is
// checked against what the exchange actually reports. Silent divergence between
// those two is how automated trading goes wrong in ways backtests never show —
// a missed fill, a manual trade, a crash mid-order — so it is checked every
// cycle rather than assumed.
//
//   npm run broker:live
//
// Env:
//   LIVE_INTERVAL_SECONDS  how often to check (default 300 = 5 min)
//   LIVE_MAX_CYCLES        stop after N cycles (default 0 = run until stopped)

import { assertTestnetMode } from "./guardrails";
import {
  BinanceTestnetClient,
  BinanceUnknownOutcomeError,
  checkOrderSizing,
  netBaseReceived,
  newClientOrderId,
  sellableQuantity,
  SymbolFilters,
} from "./binanceClient";
import { fetchCandles } from "./market";
import { computeSignal } from "./strategy";
import { checkRisk } from "./risk";
import { readLedger, appendLedgerRow, appendLearning } from "./memory";
import { checkMemory } from "./adaptiveFilter";
import { STRATEGY_CONFIG, RISK_CONFIG, SETUP_KEY } from "./bot";
import { BotState } from "./types";
import { loadState, saveState, todayUTC } from "./liveState";

const INTERVAL_SECONDS = Number(process.env.LIVE_INTERVAL_SECONDS ?? 300);
// `--once` (used by npm run broker:trade) runs a single decision cycle and exits,
// rather than looping. Same code path as the live loop — no separate order logic.
const RUN_ONCE = process.argv.includes("--once");
const MAX_CYCLES = RUN_ONCE ? 1 : Number(process.env.LIVE_MAX_CYCLES ?? 0);

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// State persistence lives in ./liveState so it can be tested without an exchange.

/**
 * Compares the bot's belief against the exchange's reality. Returns the
 * corrected state. Never silently overwrites without saying what changed.
 */
async function reconcile(
  client: BinanceTestnetClient,
  state: BotState,
  filters: SymbolFilters
): Promise<BotState> {
  const account = await client.getAccount();
  const baseBal = account.balances.find((b) => b.asset === filters.baseAsset);
  const actualQty = baseBal?.free ?? 0;

  // Correct ONLY in the safe direction: the bot thinks it holds something the
  // exchange says is gone. Trying to sell what you don't have is a guaranteed
  // rejected order, so this correction prevents a real failure.
  if (state.inPosition) {
    const expected = state.quantity ?? 0;
    if (actualQty < expected * 0.9) {
      log(`RECONCILE: bot believed it held ${expected} ${filters.baseAsset}, exchange reports ${actualQty}.`);
      log(`RECONCILE: correcting to FLAT — the position is gone (closed elsewhere, or a fill never happened).`);
      return { ...state, inPosition: false, entryPrice: null, quantity: null };
    }
    return state;
  }

  // The unsafe direction: the bot thinks it is flat but a balance exists.
  // DO NOT auto-adopt it. An exchange balance is not evidence of a bot position —
  // testnet accounts arrive pre-funded (this one holds 1 BTC that the bot never
  // bought), and a real account may hold coins bought by hand. Adopting those
  // would make the bot "sell" funds it never opened a position with.
  // Warn clearly and stay flat; the operator decides.
  const price = await client.getPrice(filters.symbol);
  if (actualQty * price > filters.minNotional) {
    log(`RECONCILE: exchange holds ${actualQty} ${filters.baseAsset} (~${(actualQty * price).toFixed(2)} ${filters.quoteAsset}) but the bot has no record of buying it.`);
    log(`RECONCILE: NOT adopting it as a position — pre-funded or manually-bought coins are not the bot's to sell.`);
    log(`RECONCILE: staying flat. The bot will only ever sell what it bought itself.`);
  }
  return state;
}

/**
 * Resolves an order that was in flight when we last stopped.
 *
 * This is the failure that matters most. If the process dies — or the network
 * drops — between sending an order and recording its fill, the exchange may
 * hold a position the bot knows nothing about. Left unresolved, the next BUY
 * signal would open a SECOND position on top of the invisible first one.
 *
 * Because the client order ID was written to disk before the order was sent,
 * the exchange can be asked a direct question with a definite answer.
 */
async function resolvePendingOrder(client: BinanceTestnetClient, state: BotState): Promise<BotState> {
  const pending = state.pendingOrder;
  if (!pending) return state;

  log(`RECOVERY: an order was in flight when this bot last stopped (${pending.side} ${pending.quantity} ${pending.symbol}, sent ${pending.sentAt}).`);
  log(`RECOVERY: asking the exchange what became of client order ${pending.clientOrderId}...`);

  const order = await client.findOrderByClientId(pending.symbol, pending.clientOrderId, pending.side, pending.quantity);

  if (order === null) {
    log(`RECOVERY: the exchange has no such order — it never arrived. Nothing was traded.`);
    return { ...state, pendingOrder: null };
  }

  log(`RECOVERY: the order DID exist — ${order.status}, ${order.executedQty} executed @ avg ${order.avgFillPrice.toFixed(2)}.`);

  if (order.executedQty <= 0) {
    log(`RECOVERY: nothing filled. Treating as no trade.`);
    return { ...state, pendingOrder: null };
  }

  // It filled. Record it now, as it should have been recorded then.
  appendLedgerRow({
    timestamp: new Date(order.transactTime).toISOString(),
    symbol: order.symbol,
    action: pending.side,
    price: String(order.avgFillPrice),
    quantity: String(order.executedQty),
    reason: `Recovered after interrupted cycle [${SETUP_KEY}]`,
    mode: "testnet",
    outcome: pending.side === "BUY" ? "open" : "recovered-close",
    pnl: "",
  });

  if (pending.side === "BUY") {
    log(`RECOVERY: adopting it as the open position — this bot did buy it, the confirmation was just lost.`);
    return { ...state, inPosition: true, entryPrice: order.avgFillPrice, quantity: order.executedQty, pendingOrder: null };
  }

  log(`RECOVERY: the close went through. Marking flat.`);
  return { ...state, inPosition: false, entryPrice: null, quantity: null, pendingOrder: null };
}

async function runCycle(client: BinanceTestnetClient, filters: SymbolFilters, cycle: number): Promise<void> {
  console.log("\n" + "-".repeat(72));
  log(`Cycle ${cycle} — ${STRATEGY_CONFIG.symbol} ${STRATEGY_CONFIG.interval} (${STRATEGY_CONFIG.strategyType})`);

  let state = loadState();
  // Order of these two matters: an unresolved in-flight order must be settled
  // before reconciliation, or reconcile would see its coins as "unexplained".
  state = await resolvePendingOrder(client, state);
  state = await reconcile(client, state, filters);

  const lookback =
    STRATEGY_CONFIG.strategyType === "trend_following" || STRATEGY_CONFIG.strategyType === "donchian_breakout"
      ? STRATEGY_CONFIG.trendLookback + 5
      : STRATEGY_CONFIG.strategyType === "rsi_mean_reversion"
      ? STRATEGY_CONFIG.rsiPeriod + 5
      : STRATEGY_CONFIG.slowLen + 5;

  const candles = await fetchCandles(STRATEGY_CONFIG.symbol, STRATEGY_CONFIG.interval, lookback);
  // Position-aware: state-based strategies answer differently when already long.
  const signal = computeSignal(candles, STRATEGY_CONFIG, state.inPosition);
  log(`Signal: ${signal.signal} — ${signal.reason}`);

  let risk = checkRisk(signal.signal, RISK_CONFIG, {
    inPosition: state.inPosition,
    dailyPnLPct: state.dailyPnLPct,
  });
  log(`Risk: ${risk.action} — ${risk.reason}`);

  if (risk.action === "BUY") {
    const mem = checkMemory(STRATEGY_CONFIG.symbol, SETUP_KEY, readLedger());
    log(`Memory: ${mem.reason}`);
    if (mem.skip) {
      log(`Memory overrides risk — downgrading BUY to SKIP.`);
      risk = { action: "SKIP", approved: false, reason: mem.reason };
    }
  }

  if (risk.action !== "BUY" && risk.action !== "SELL") {
    log(`Decision: ${risk.action}. No order placed.`);
    if (risk.action === "SKIP") {
      appendLedgerRow({
        timestamp: new Date().toISOString(),
        symbol: STRATEGY_CONFIG.symbol,
        action: "SKIP",
        price: String(candles[candles.length - 1].close),
        quantity: "",
        reason: risk.reason.includes(SETUP_KEY) ? risk.reason : `${risk.reason} [${SETUP_KEY}]`,
        mode: "testnet",
        outcome: "skipped",
        pnl: "",
      });
    }
    saveState(state);
    return;
  }

  // An order is warranted.
  const price = await client.getPrice(STRATEGY_CONFIG.symbol);
  let intendedQty = RISK_CONFIG.quantity;
  if (risk.action === "SELL") {
    // Same rule as live mode: never ask to sell more than the wallet holds.
    const account = await client.getAccount();
    const walletFree = account.balances.find((b) => b.asset === filters.baseAsset)?.free ?? 0;
    const recorded = state.quantity ?? 0;
    intendedQty = sellableQuantity(recorded, walletFree, filters.stepSize);
    if (intendedQty < recorded) {
      log(`SELL SIZE: bot recorded ${recorded} ${filters.baseAsset}, wallet holds ${walletFree} — selling ${intendedQty}.`);
    }
  }
  const sizing = checkOrderSizing(intendedQty, price, filters);

  if (!sizing.ok) {
    log(`ORDER BLOCKED — would be rejected by the exchange:`);
    for (const p of sizing.problems) log(`   ${p}`);
    saveState(state);
    return;
  }
  for (const p of sizing.problems) log(`   ${p}`);

  log(`Placing MARKET ${risk.action} ${sizing.adjustedQty} ${filters.baseAsset} (~${sizing.notional.toFixed(2)} ${filters.quoteAsset})...`);

  // Write the intent to disk BEFORE sending. If the process dies in the next
  // few milliseconds, this record plus the client ID is what makes the order
  // recoverable instead of invisible.
  const clientOrderId = newClientOrderId();
  state.pendingOrder = {
    clientOrderId,
    side: risk.action,
    quantity: sizing.adjustedQty,
    symbol: STRATEGY_CONFIG.symbol,
    sentAt: new Date().toISOString(),
  };
  saveState(state);

  let order;
  try {
    order = await client.placeMarketOrder(STRATEGY_CONFIG.symbol, risk.action, sizing.adjustedQty, clientOrderId);
  } catch (err) {
    if (err instanceof BinanceUnknownOutcomeError) {
      // The request never came back. The order may well be live. Do NOT assume
      // it failed — ask, using the ID we saved a moment ago.
      log(`ORDER OUTCOME UNKNOWN: ${err.message}`);
      log(`The order may or may not have reached the exchange. Asking directly...`);
      try {
        state = await resolvePendingOrder(client, state);
        saveState(state);
        return;
      } catch (queryErr) {
        // Worst case: we cannot reach the exchange at all. Keep the pending
        // record so the NEXT cycle retries the question. Never clear it.
        log(`RECOVERY FAILED: ${(queryErr as Error).message}`);
        log(`Keeping the pending-order record — the next cycle will ask again.`);
        log(`Until it resolves, this bot will not place another order.`);
        saveState(state);
        return;
      }
    }

    // A definite rejection (bad size, insufficient balance, etc). The exchange
    // answered, so we know no order exists — safe to clear the pending record.
    log(`ORDER REJECTED: ${(err as Error).message}`);
    log(`The exchange answered, so no order exists. State left unchanged.`);
    state.pendingOrder = null;
    saveState(state);
    return;
  }

  state.pendingOrder = null;

  log(`FILLED: ${order.executedQty} @ avg ${order.avgFillPrice.toFixed(2)} (order ${order.orderId}, ${order.status})`);
  if (order.executedQty < order.requestedQty) {
    log(`PARTIAL FILL — got ${order.executedQty} of ${order.requestedQty}. State reflects what actually filled.`);
  }

  const taggedReason = `${signal.reason} [${SETUP_KEY}]`;

  if (risk.action === "BUY") {
    state.inPosition = true;
    state.entryPrice = order.avgFillPrice;
    // What landed in the wallet after any fee taken in the base asset.
    state.quantity = netBaseReceived(order, filters.baseAsset);
    appendLedgerRow({
      timestamp: new Date(order.transactTime).toISOString(),
      symbol: STRATEGY_CONFIG.symbol,
      action: "BUY",
      price: String(order.avgFillPrice),
      quantity: String(order.executedQty),
      reason: taggedReason,
      mode: "testnet",
      outcome: "open",
      pnl: "",
    });
  } else {
    const entry = state.entryPrice;
    const pnlPct = entry ? (order.avgFillPrice - entry) / entry : 0;
    if (entry) {
      state.dailyPnLPct += pnlPct;
      log(`Trade PnL: ${(pnlPct * 100).toFixed(3)}%   Daily: ${(state.dailyPnLPct * 100).toFixed(3)}%`);
    } else {
      log(`Closed a position with no known entry price — PnL not computed for it.`);
    }
    const outcome = !entry ? "timeout" : pnlPct >= 0 ? "win" : "loss";
    appendLedgerRow({
      timestamp: new Date(order.transactTime).toISOString(),
      symbol: STRATEGY_CONFIG.symbol,
      action: "SELL",
      price: String(order.avgFillPrice),
      quantity: String(order.executedQty),
      reason: taggedReason,
      mode: "testnet",
      outcome,
      pnl: entry ? (pnlPct * 100).toFixed(4) : "",
    });
    if (outcome === "loss") {
      appendLearning(
        `${STRATEGY_CONFIG.symbol} ${STRATEGY_CONFIG.strategyType} testnet trade closed at a real loss (${(pnlPct * 100).toFixed(2)}%) on ${todayUTC()}.`
      );
    }
    state.inPosition = false;
    state.entryPrice = null;
    state.quantity = null;
  }

  saveState(state);
}

async function main() {
  const creds = assertTestnetMode();
  const client = new BinanceTestnetClient(creds);

  console.log(RUN_ONCE ? "SINGLE TRADE CYCLE — Binance Spot Testnet (fake money)\n" : "LIVE LOOP — Binance Spot Testnet (fake money)\n");
  console.log(`  Strategy:  ${STRATEGY_CONFIG.strategyType} on ${STRATEGY_CONFIG.symbol} ${STRATEGY_CONFIG.interval}`);
  if (!RUN_ONCE) console.log(`  Interval:  every ${INTERVAL_SECONDS}s`);
  console.log(`  Cycles:    ${RUN_ONCE ? "1 (single shot)" : MAX_CYCLES === 0 ? "until you stop it (Ctrl+C)" : MAX_CYCLES}`);
  console.log(`  Size:      ${RISK_CONFIG.quantity} per trade`);
  console.log(`\n  Expect long stretches of HOLD — this strategy trades a handful of times a year.\n`);

  await client.syncTime();
  const filters = await client.getSymbolFilters(STRATEGY_CONFIG.symbol);

  let cycle = 0;
  let stopping = false;

  // Ctrl+C must NOT kill the process where it stands. If it lands between
  // placing an order and recording the fill, the exchange has a position the
  // bot never wrote down. So the first Ctrl+C only raises a flag and the
  // current cycle finishes; a second one is an explicit override.
  let forceQuitArmed = false;
  process.on("SIGINT", () => {
    if (forceQuitArmed) {
      console.log("\nForce quit. WARNING: if an order was in flight it may not be recorded —");
      console.log("run 'npm run broker:check' and compare against data/live-state.json.");
      process.exit(1);
    }
    forceQuitArmed = true;
    stopping = true;
    console.log("\n\nStop requested. Finishing the current cycle first so no order goes unrecorded.");
    console.log("Any open position is LEFT OPEN on the exchange — this loop does not liquidate on exit.");
    console.log("Press Ctrl+C again to quit immediately (not recommended mid-order).");
  });

  while (true) {
    cycle++;
    try {
      await runCycle(client, filters, cycle);
    } catch (err) {
      // A bad cycle must never kill the loop — log it and carry on.
      log(`CYCLE ERROR: ${(err as Error).message}`);
      log(`Continuing — the next cycle will reconcile against the exchange.`);
    }

    if (stopping) {
      log(`Stopped cleanly after cycle ${cycle}.`);
      break;
    }
    if (MAX_CYCLES > 0 && cycle >= MAX_CYCLES) {
      log(`\nReached ${MAX_CYCLES} cycles. Stopping.`);
      break;
    }

    // Sleep in short slices so a stop request is noticed promptly rather than
    // after a full interval — without ever interrupting a cycle mid-flight.
    const wakeAt = Date.now() + INTERVAL_SECONDS * 1000;
    while (Date.now() < wakeAt && !stopping) {
      await new Promise((r) => setTimeout(r, Math.min(500, wakeAt - Date.now())));
    }
    if (stopping) {
      log(`Stopped cleanly while idle after cycle ${cycle}.`);
      break;
    }
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
