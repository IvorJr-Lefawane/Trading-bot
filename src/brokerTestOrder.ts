// Places a real round-trip order pair on Binance Spot Testnet and reports
// exactly what happened: fill prices, commission, slippage, and the REAL
// round-trip cost measured against what our backtests assume.
//
// This exists because the trend-following strategy trades ~7 times a year, so
// waiting for a live signal to observe the plumbing is impractical. This
// exercises every code path — signing, sizing, placement, fills, errors — on
// demand, with fake money.
//
// It also does something the backtests cannot: measures your ACTUAL trading
// cost instead of assuming one.
//
//   npm run broker:testorder
//
// Note: a real-money version of this command would require an explicit typed
// confirmation before each order. On testnet the funds are fake, and the
// guardrails make it impossible to point this at a real account.

import { assertTestnetMode } from "./guardrails";
import { BinanceTestnetClient, checkOrderSizing, OrderResult, roundToStepSize } from "./binanceClient";
import { STRATEGY_CONFIG, COST_CONFIG } from "./bot";

const HOLD_SECONDS = Number(process.env.TESTORDER_HOLD_SECONDS ?? 5);
const SIZE_MULTIPLIER = Number(process.env.TESTORDER_SIZE_MULT ?? 1.5); // headroom above the exchange minimum

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function describeFill(label: string, order: OrderResult, expectedPrice: number): void {
  console.log(`\n  ${label}`);
  console.log(`    Order ID:      ${order.orderId}`);
  console.log(`    Status:        ${order.status}`);
  console.log(`    Requested:     ${order.requestedQty}`);
  console.log(`    Executed:      ${order.executedQty}${order.executedQty !== order.requestedQty ? "   <-- PARTIAL FILL" : ""}`);
  console.log(`    Avg fill:      ${order.avgFillPrice.toFixed(2)}`);
  console.log(`    Expected:      ${expectedPrice.toFixed(2)}`);

  const slipPct = expectedPrice > 0 ? ((order.avgFillPrice - expectedPrice) / expectedPrice) * 100 : 0;
  const against = order.side === "BUY" ? slipPct : -slipPct; // buying higher / selling lower both hurt
  console.log(`    Slippage:      ${slipPct >= 0 ? "+" : ""}${slipPct.toFixed(4)}%  (${against > 0 ? "against you" : "in your favour"})`);
  console.log(`    Value:         ${order.cummulativeQuoteQty.toFixed(2)}`);

  if (order.fills.length > 0) {
    console.log(`    Filled in ${order.fills.length} piece(s):`);
    for (const f of order.fills) {
      console.log(`      ${f.qty} @ ${f.price}   fee ${f.commission} ${f.commissionAsset}`);
    }
  }
}

async function main() {
  const creds = assertTestnetMode();
  const client = new BinanceTestnetClient(creds);
  const symbol = STRATEGY_CONFIG.symbol;

  console.log("ROUND-TRIP TEST ORDER on Binance Spot Testnet (fake money)\n");

  const offset = await client.syncTime();
  log(`Clock offset vs exchange: ${offset.toFixed(0)}ms`);

  const filters = await client.getSymbolFilters(symbol);
  const price = await client.getPrice(symbol);
  log(`${symbol} @ ${price}   step ${filters.stepSize}   min notional ${filters.minNotional} ${filters.quoteAsset}`);

  // Deliberately small: just above the exchange minimum, not the strategy's size.
  const targetNotional = Math.max(filters.minNotional, 10) * SIZE_MULTIPLIER;
  const rawQty = targetNotional / price;
  const qty = roundToStepSize(rawQty, filters.stepSize);
  const sizing = checkOrderSizing(qty, price, filters);

  console.log(`\nOrder size chosen: ${sizing.adjustedQty} ${filters.baseAsset} (~${sizing.notional.toFixed(2)} ${filters.quoteAsset})`);
  for (const p of sizing.problems) console.log(`  - ${p}`);
  if (!sizing.ok) {
    console.log(`\nCannot place a valid order at this size. Check the balance on your testnet account.`);
    process.exit(1);
  }

  const account = await client.getAccount();
  const quoteBal = account.balances.find((b) => b.asset === filters.quoteAsset);
  const baseBal = account.balances.find((b) => b.asset === filters.baseAsset);
  console.log(`\nBalances before:  ${filters.baseAsset} ${baseBal?.free ?? 0}   ${filters.quoteAsset} ${quoteBal?.free ?? 0}`);

  if ((quoteBal?.free ?? 0) < sizing.notional) {
    console.log(`\nNot enough ${filters.quoteAsset} on the testnet account to buy. Regenerate your testnet key to get a fresh funded account.`);
    process.exit(1);
  }

  // ---- BUY ----
  log(`\nPlacing MARKET BUY...`);
  const buyPrice = await client.getPrice(symbol);
  const buy = await client.placeMarketOrder(symbol, "BUY", sizing.adjustedQty);
  describeFill("BUY FILLED", buy, buyPrice);

  // ---- hold ----
  if (HOLD_SECONDS > 0) {
    log(`\nHolding ${HOLD_SECONDS}s before closing...`);
    await new Promise((r) => setTimeout(r, HOLD_SECONDS * 1000));
  }

  // ---- SELL back ----
  // Sell exactly what filled, rounded down to step size — you cannot sell fee-deducted dust.
  const sellQty = roundToStepSize(buy.executedQty, filters.stepSize);
  log(`\nPlacing MARKET SELL to close...`);
  const sellPrice = await client.getPrice(symbol);
  const sell = await client.placeMarketOrder(symbol, "SELL", sellQty);
  describeFill("SELL FILLED", sell, sellPrice);

  // ---- the measurement that matters ----
  const grossPct = (sell.avgFillPrice - buy.avgFillPrice) / buy.avgFillPrice;
  const spent = buy.cummulativeQuoteQty;
  const received = sell.cummulativeQuoteQty;
  const netQuote = received - spent;
  const netPct = spent > 0 ? netQuote / spent : 0;
  const realCostPct = grossPct - netPct; // what the round trip actually cost
  const modelledCostPct = 2 * (COST_CONFIG.feePctPerSide + COST_CONFIG.slippagePctPerSide);

  console.log("\n" + "=".repeat(72));
  console.log("REAL ROUND-TRIP COST — measured, not assumed");
  console.log("=".repeat(72));
  console.log(`  Bought:            ${spent.toFixed(4)} ${filters.quoteAsset}`);
  console.log(`  Sold:              ${received.toFixed(4)} ${filters.quoteAsset}`);
  console.log(`  Net:               ${netQuote >= 0 ? "+" : ""}${netQuote.toFixed(4)} ${filters.quoteAsset}  (${(netPct * 100).toFixed(4)}%)`);
  console.log(`  Price move while held: ${(grossPct * 100).toFixed(4)}%`);
  console.log(`\n  MEASURED round-trip cost: ${(realCostPct * 100).toFixed(4)}%`);
  console.log(`  MODELLED in backtests:    ${(modelledCostPct * 100).toFixed(4)}%`);

  // Was any commission actually charged? Binance Spot Testnet frequently runs at
  // a zero-fee schedule. If it did, the measured cost is NOT a measurement of
  // your real trading cost — it is a measurement of an exchange that does not
  // charge fees, and it must not be read as validating the backtest assumption.
  const allFills = [...buy.fills, ...sell.fills];
  const totalCommission = allFills.reduce((sum, f) => sum + Number(f.commission), 0);
  const feesWereCharged = allFills.length > 0 && totalCommission > 0;

  if (!feesWereCharged) {
    console.log(`\n  MEASUREMENT VOID — NO COMMISSION WAS CHARGED.`);
    console.log(`  Every fill above reports a fee of 0. This testnet account is on a zero-fee`);
    console.log(`  schedule, so the ${(realCostPct * 100).toFixed(4)}% above measures an exchange that does not charge,`);
    console.log(`  not your real cost. It does NOT confirm the ${(modelledCostPct * 100).toFixed(2)}% modelled figure, and it is`);
    console.log(`  NOT evidence that the backtests were conservative.`);
    console.log(`\n  Real Binance spot charges 0.1% per side at the base tier (0.075% paying in BNB),`);
    console.log(`  so ${(modelledCostPct * 100).toFixed(2)}% round trip remains the number to plan against. Verify your own tier at`);
    console.log(`  Binance > Account > Fees before risking real funds. What this run DID validate is`);
    console.log(`  the mechanics: signing, sizing, placement, fills and reconciliation.`);
  } else {
    const diff = realCostPct - modelledCostPct;
    if (Math.abs(diff) < 0.0005) {
      console.log(`  Close match — the backtest cost assumption is realistic.`);
    } else if (diff > 0) {
      console.log(`  REAL COST IS ${(diff * 100).toFixed(4)}% HIGHER than modelled. Every backtest in this project is`);
      console.log(`  therefore optimistic. Raise FEE_PCT_PER_SIDE / SLIPPAGE_PCT_PER_SIDE and re-run them.`);
    } else {
      console.log(`  Real cost is lower than modelled on THIS venue. Testnet fee schedules do not`);
      console.log(`  necessarily match mainnet — confirm your real fee tier before relaxing the model.`);
    }
    console.log(`\n  Commission charged across both legs: ${totalCommission}`);
  }

  console.log(`\n  Caveat: testnet liquidity is not real liquidity, and its fee schedule is not`);
  console.log(`  necessarily the one your real account pays. Treat this as a sanity check on the`);
  console.log(`  mechanics, not as a true measurement of live cost or slippage.`);

  const after = await client.getAccount();
  const quoteAfter = after.balances.find((b) => b.asset === filters.quoteAsset);
  const baseAfter = after.balances.find((b) => b.asset === filters.baseAsset);
  console.log(`\nBalances after:   ${filters.baseAsset} ${baseAfter?.free ?? 0}   ${filters.quoteAsset} ${quoteAfter?.free ?? 0}`);
  if (feesWereCharged) {
    console.log(`\nNote: a little ${filters.baseAsset} dust may remain — commission is deducted from the`);
    console.log(`asset you bought, so you can never sell back exactly what you purchased.`);
  } else {
    console.log(`\nNote: no dust remained because no commission was charged. On a real account it`);
    console.log(`would, and the sell-back quantity is rounded down to step size to handle that.`);
  }
}

main().catch((err) => {
  console.error(`\n[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
