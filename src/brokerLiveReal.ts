// REAL MONEY. One decision cycle against api.binance.com, with a typed
// confirmation before the order leaves.
//
//   npm run live:trade
//
// Design notes, because this is the file where a mistake costs money:
//
//   - It runs ONE cycle and exits. There is no live timer loop on mainnet in
//     this project. An unattended bot placing real orders is a different kind
//     of thing from a bot you watch, and it is not what was built here.
//   - Every order requires you to type the exact quantity and symbol. Not "y",
//     not Enter. If you can't be bothered to type it, you shouldn't be placing
//     it half-asleep either.
//   - The notional cap always wins over the strategy's configured size.
//   - The same client, signal, risk, memory and recovery code as testnet. The
//     only difference is the mode. Nothing here is a special live-only path
//     that testnet never exercised.

import * as readline from "readline";
import { assertLiveMode, assertNotHalted } from "./guardrails";
import {
  BinanceSpotClient,
  BinanceUnknownOutcomeError,
  checkOrderSizing,
  netBaseReceived,
  newClientOrderId,
  roundToStepSize,
  sellableQuantity,
} from "./binanceClient";
import { runPreflight, capQuantityToNotional } from "./livePreflight";
import { fetchCandles } from "./market";
import { computeSignal } from "./strategy";
import { checkRisk } from "./risk";
import { readLedger, appendLedgerRow, appendLearning } from "./memory";
import { checkMemory } from "./adaptiveFilter";
import { STRATEGY_CONFIG, RISK_CONFIG, SETUP_KEY } from "./bot";
import { loadState, loadRealStateStrict, saveState, todayUTC, LIVE_STATE_PATH } from "./liveState";
import { BotState } from "./types";
import * as path from "path";

// Live trading keeps its own state file. Sharing one with testnet would let a
// testnet position be "closed" against a real account, or worse.
const REAL_STATE_PATH = path.join(__dirname, "..", "data", "real-state.json");

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

/**
 * Typed confirmation. The phrase includes the quantity and symbol so that
 * confirming is an act of reading what is about to happen, not muscle memory.
 */
async function confirmOrder(side: string, qty: number, symbol: string, notional: number, quote: string): Promise<boolean> {
  const phrase = `${side} ${qty} ${symbol}`;
  console.log(`\n${"!".repeat(72)}`);
  console.log(`REAL MONEY ORDER — about to spend real funds on your live Binance account.`);
  console.log(`${"!".repeat(72)}`);
  console.log(`\n    ${side}  ${qty} ${symbol}   (~${notional.toFixed(2)} ${quote})\n`);
  console.log(`To place it, type exactly:   ${phrase}`);
  console.log(`Anything else cancels.\n`);

  const answer = (await ask("> ")).trim();
  if (answer !== phrase) {
    console.log(`\nCancelled — you typed "${answer}", which does not match. No order was sent.`);
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  const cfg = assertLiveMode();
  const client = new BinanceSpotClient(cfg.credentials, "live");
  const symbol = STRATEGY_CONFIG.symbol;

  console.log("\nLIVE TRADING — REAL MONEY ON BINANCE MAINNET");
  console.log(`Strategy: ${STRATEGY_CONFIG.strategyType} on ${symbol} ${STRATEGY_CONFIG.interval}`);
  console.log(`Mode:     single cycle, then exit. No unattended loop exists for live mode.\n`);

  const pre = await runPreflight(client, cfg, symbol);

  // ---- state, recovery, reconciliation ----
  // Strict: a missing file refuses the run rather than assuming flat. See liveState.ts.
  let state: BotState = loadRealStateStrict(REAL_STATE_PATH);

  if (state.pendingOrder) {
    log(`RECOVERY: an order was in flight when this last ran — ${state.pendingOrder.side} ${state.pendingOrder.quantity} ${state.pendingOrder.symbol}.`);
    const found = await client.findOrderByClientId(
      state.pendingOrder.symbol,
      state.pendingOrder.clientOrderId,
      state.pendingOrder.side,
      state.pendingOrder.quantity
    );
    if (found === null) {
      log(`RECOVERY: the exchange has no such order. It never arrived.`);
      state.pendingOrder = null;
    } else if (found.executedQty > 0) {
      log(`RECOVERY: it DID fill — ${found.executedQty} @ ${found.avgFillPrice.toFixed(2)}. Adopting it.`);
      appendLedgerRow({
        timestamp: new Date(found.transactTime).toISOString(),
        symbol: found.symbol,
        action: state.pendingOrder.side,
        price: String(found.avgFillPrice),
        quantity: String(found.executedQty),
        reason: `Recovered after interrupted live cycle [${SETUP_KEY}]`,
        mode: "live",
        outcome: state.pendingOrder.side === "BUY" ? "open" : "recovered-close",
        pnl: "",
      });
      if (state.pendingOrder.side === "BUY") {
        state = { ...state, inPosition: true, entryPrice: found.avgFillPrice, quantity: found.executedQty };
      } else {
        state = { ...state, inPosition: false, entryPrice: null, quantity: null };
      }
      state.pendingOrder = null;
    } else {
      log(`RECOVERY: the order exists but nothing filled. Treating as no trade.`);
      state.pendingOrder = null;
    }
    saveState(state, REAL_STATE_PATH);
  }

  // Never adopt coins the bot did not buy. On a real account you almost
  // certainly hold BTC this bot has nothing to do with.
  if (state.inPosition && pre.baseFree < (state.quantity ?? 0) * 0.9) {
    log(`RECONCILE: bot believed it held ${state.quantity}, exchange reports ${pre.baseFree}. Correcting to FLAT.`);
    state = { ...state, inPosition: false, entryPrice: null, quantity: null };
  } else if (!state.inPosition && pre.baseFree * pre.price > pre.filters.minNotional) {
    log(`RECONCILE: your account holds ${pre.baseFree} ${pre.filters.baseAsset} that this bot did not buy.`);
    log(`RECONCILE: NOT adopting it. The bot only ever sells what it bought itself.`);
  }

  // ---- signal ----
  const lookback =
    STRATEGY_CONFIG.strategyType === "trend_following" || STRATEGY_CONFIG.strategyType === "donchian_breakout"
      ? STRATEGY_CONFIG.trendLookback + 5
      : STRATEGY_CONFIG.strategyType === "rsi_mean_reversion"
      ? STRATEGY_CONFIG.rsiPeriod + 5
      : STRATEGY_CONFIG.slowLen + 5;

  const candles = await fetchCandles(symbol, STRATEGY_CONFIG.interval, lookback);
  const signal = computeSignal(candles, STRATEGY_CONFIG, state.inPosition);
  log(`Signal: ${signal.signal} — ${signal.reason}`);

  let risk = checkRisk(signal.signal, RISK_CONFIG, {
    inPosition: state.inPosition,
    dailyPnLPct: state.dailyPnLPct,
  });
  log(`Risk:   ${risk.action} — ${risk.reason}`);

  if (risk.action === "BUY") {
    const mem = checkMemory(symbol, SETUP_KEY, readLedger());
    log(`Memory: ${mem.reason}`);
    if (mem.skip) risk = { action: "SKIP", approved: false, reason: mem.reason };
  }

  if (risk.action !== "BUY" && risk.action !== "SELL") {
    log(`Decision: ${risk.action}. No order. Nothing was spent.`);
    saveState(state, REAL_STATE_PATH);
    return;
  }

  // ---- sizing, capped ----
  let intendedQty = RISK_CONFIG.quantity;
  if (risk.action === "SELL") {
    // Sell what the wallet can actually deliver. The recorded size may be larger
    // than the balance because the BUY fee was taken out of the BTC received
    // (and state saved before this fix recorded the gross amount).
    const recorded = state.quantity ?? 0;
    intendedQty = sellableQuantity(recorded, pre.baseFree, pre.filters.stepSize);
    if (intendedQty < recorded) {
      log(`SELL SIZE: bot recorded ${recorded} ${pre.filters.baseAsset}, wallet holds ${pre.baseFree}.`);
      log(`SELL SIZE: selling ${intendedQty} (the most the wallet can deliver, rounded down to step ${pre.filters.stepSize}).`);
    }
  }

  // A SELL closes what we actually hold and is never capped — capping an exit
  // would strand part of a position the bot opened.
  let qty = intendedQty;
  if (risk.action === "BUY") {
    const { qty: capped, capped: wasCapped } = capQuantityToNotional(intendedQty, pre.price, cfg.maxOrderNotional);
    if (wasCapped) {
      log(`SIZE CAP: strategy wanted ${intendedQty} ${pre.filters.baseAsset} (~${(intendedQty * pre.price).toFixed(2)} ${pre.filters.quoteAsset}),`);
      log(`SIZE CAP: reduced to the ${cfg.maxOrderNotional} ${pre.filters.quoteAsset} cap.`);
    }
    qty = capped;
  }

  qty = roundToStepSize(qty, pre.filters.stepSize);
  const sizing = checkOrderSizing(qty, pre.price, pre.filters);
  for (const p of sizing.problems) log(`   ${p}`);

  if (!sizing.ok) {
    log(`ORDER BLOCKED — the exchange would reject it. Nothing was sent.`);
    saveState(state, REAL_STATE_PATH);
    return;
  }

  if (risk.action === "BUY" && sizing.notional > pre.quoteFree) {
    log(`ORDER BLOCKED — needs ${sizing.notional.toFixed(2)} ${pre.filters.quoteAsset}, you have ${pre.quoteFree.toFixed(2)}.`);
    saveState(state, REAL_STATE_PATH);
    return;
  }

  // Belt and braces: the cap is re-checked here against the FINAL rounded
  // quantity, after every adjustment, immediately before asking to confirm.
  if (risk.action === "BUY" && sizing.notional > cfg.maxOrderNotional) {
    log(`ORDER BLOCKED — final size ${sizing.notional.toFixed(2)} exceeds the ${cfg.maxOrderNotional} cap.`);
    saveState(state, REAL_STATE_PATH);
    return;
  }

  assertNotHalted();

  const confirmed = await confirmOrder(
    risk.action,
    sizing.adjustedQty,
    symbol,
    sizing.notional,
    pre.filters.quoteAsset
  );
  if (!confirmed) {
    saveState(state, REAL_STATE_PATH);
    return;
  }

  // ---- send ----
  const clientOrderId = newClientOrderId("live");
  state.pendingOrder = {
    clientOrderId,
    side: risk.action,
    quantity: sizing.adjustedQty,
    symbol,
    sentAt: new Date().toISOString(),
  };
  saveState(state, REAL_STATE_PATH);

  log(`Placing MARKET ${risk.action} ${sizing.adjustedQty} ${symbol}...`);

  let order;
  try {
    order = await client.placeMarketOrder(symbol, risk.action, sizing.adjustedQty, clientOrderId);
  } catch (err) {
    if (err instanceof BinanceUnknownOutcomeError) {
      log(`ORDER OUTCOME UNKNOWN: ${err.message}`);
      log(`Asking the exchange directly whether it exists...`);
      const found = await client.findOrderByClientId(symbol, clientOrderId, risk.action, sizing.adjustedQty);
      if (found === null) {
        log(`It never arrived. Nothing was spent.`);
        state.pendingOrder = null;
      } else {
        log(`It DID execute: ${found.executedQty} @ ${found.avgFillPrice.toFixed(2)}.`);
        if (risk.action === "BUY") {
          state = { ...state, inPosition: true, entryPrice: found.avgFillPrice, quantity: found.executedQty };
        } else {
          state = { ...state, inPosition: false, entryPrice: null, quantity: null };
        }
        state.pendingOrder = null;
      }
      saveState(state, REAL_STATE_PATH);
      return;
    }
    log(`ORDER REJECTED: ${(err as Error).message}`);
    log(`The exchange answered, so no order exists. Nothing was spent.`);
    state.pendingOrder = null;
    saveState(state, REAL_STATE_PATH);
    return;
  }

  state.pendingOrder = null;

  const totalFees = order.fills.reduce((s, f) => s + f.commission, 0);
  console.log(`\n  FILLED  order ${order.orderId}, ${order.status}`);
  console.log(`    ${order.executedQty} @ avg ${order.avgFillPrice.toFixed(2)}`);
  console.log(`    Value: ${order.cummulativeQuoteQty.toFixed(2)} ${pre.filters.quoteAsset}`);
  console.log(`    Fees:  ${totalFees} ${order.fills[0]?.commissionAsset ?? ""}`);
  if (order.executedQty < order.requestedQty) {
    console.log(`    PARTIAL FILL — got ${order.executedQty} of ${order.requestedQty}.`);
  }

  const taggedReason = `${signal.reason} [${SETUP_KEY}]`;

  if (risk.action === "BUY") {
    // Record what landed in the wallet, not the gross fill — see netBaseReceived.
    const received = netBaseReceived(order, pre.filters.baseAsset);
    if (received < order.executedQty) {
      console.log(`    Received: ${received} ${pre.filters.baseAsset} after the fee was deducted`);
    }
    state.inPosition = true;
    state.entryPrice = order.avgFillPrice;
    state.quantity = received;
    appendLedgerRow({
      timestamp: new Date(order.transactTime).toISOString(),
      symbol,
      action: "BUY",
      price: String(order.avgFillPrice),
      quantity: String(order.executedQty),
      reason: taggedReason,
      mode: "live",
      outcome: "open",
      pnl: "",
    });
  } else {
    const entry = state.entryPrice;
    const pnlPct = entry ? (order.avgFillPrice - entry) / entry : 0;
    if (entry) {
      state.dailyPnLPct += pnlPct;
      console.log(`    Trade PnL: ${(pnlPct * 100).toFixed(3)}% (before fees)`);
    }
    const outcome = !entry ? "timeout" : pnlPct >= 0 ? "win" : "loss";
    appendLedgerRow({
      timestamp: new Date(order.transactTime).toISOString(),
      symbol,
      action: "SELL",
      price: String(order.avgFillPrice),
      quantity: String(order.executedQty),
      reason: taggedReason,
      mode: "live",
      outcome,
      pnl: entry ? (pnlPct * 100).toFixed(4) : "",
    });
    if (outcome === "loss") {
      appendLearning(
        `${symbol} ${STRATEGY_CONFIG.strategyType} REAL-MONEY trade closed at a loss (${(pnlPct * 100).toFixed(2)}%) on ${todayUTC()}.`
      );
    }
    state.inPosition = false;
    state.entryPrice = null;
    state.quantity = null;
  }

  saveState(state, REAL_STATE_PATH);
  console.log(`\n  State saved to data/real-state.json. Run this again to evaluate the next cycle.`);
}

main().catch((err) => {
  console.error(`\n[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  console.error(`If an order may have been in flight, check data/real-state.json for a pendingOrder`);
  console.error(`entry and your Binance order history before running anything again.`);
  process.exit(1);
});
