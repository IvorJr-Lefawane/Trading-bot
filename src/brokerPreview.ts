// Dry run. Computes the CURRENT live signal, works out exactly what order would
// be placed, validates it against the exchange's own rules — and sends nothing.
//
// The final validation uses Binance's /order/test endpoint, so the exchange
// itself confirms the order would be accepted without any order existing.
//
//   npm run broker:preview

import { assertTestnetMode } from "./guardrails";
import { BinanceTestnetClient, checkOrderSizing } from "./binanceClient";
import { fetchCandles } from "./market";
import { computeSignal } from "./strategy";
import { checkRisk } from "./risk";
import { readLedger } from "./memory";
import { checkMemory } from "./adaptiveFilter";
import { STRATEGY_CONFIG, RISK_CONFIG, SETUP_KEY } from "./bot";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const creds = assertTestnetMode();
  const client = new BinanceTestnetClient(creds);

  console.log("ORDER PREVIEW — nothing will be sent to the exchange.\n");

  // Signal comes from mainnet public data (deeper history); orders would go to testnet.
  const lookback =
    STRATEGY_CONFIG.strategyType === "trend_following" || STRATEGY_CONFIG.strategyType === "donchian_breakout"
      ? STRATEGY_CONFIG.trendLookback + 5
      : STRATEGY_CONFIG.strategyType === "rsi_mean_reversion"
      ? STRATEGY_CONFIG.rsiPeriod + 5
      : STRATEGY_CONFIG.slowLen + 5;

  const candles = await fetchCandles(STRATEGY_CONFIG.symbol, STRATEGY_CONFIG.interval, lookback);
  log(`Loaded ${candles.length} real ${STRATEGY_CONFIG.interval} candles for ${STRATEGY_CONFIG.symbol}`);

  // Preview answers "what would the bot do if it started fresh right now", so it
  // evaluates from a flat position. For a state-based strategy that is the
  // meaningful question — would it enter today?
  const signal = computeSignal(candles, STRATEGY_CONFIG, false);
  log(`Strategy (${STRATEGY_CONFIG.strategyType}), evaluated as if flat: ${signal.signal} — ${signal.reason}`);

  const risk = checkRisk(signal.signal, RISK_CONFIG, { inPosition: false, dailyPnLPct: 0 });
  log(`Risk check: ${risk.action} — ${risk.reason}`);

  if (risk.action === "BUY") {
    const mem = checkMemory(STRATEGY_CONFIG.symbol, SETUP_KEY, readLedger());
    log(`Memory check: ${mem.reason}`);
    if (mem.skip) {
      console.log(`\nFinal decision: SKIP (memory). No order would be placed.`);
      return;
    }
  }

  if (risk.action !== "BUY" && risk.action !== "SELL") {
    console.log(`\nFinal decision: ${risk.action}. No order would be placed right now.`);
    console.log(`This is expected most of the time — ${STRATEGY_CONFIG.strategyType} on ${STRATEGY_CONFIG.interval} candles trades rarely.`);
    console.log(`\nTo exercise the order plumbing anyway, use: npm run broker:testorder`);
    return;
  }

  // An order would happen. Show exactly what, and let the exchange validate it.
  const price = await client.getPrice(STRATEGY_CONFIG.symbol);
  const filters = await client.getSymbolFilters(STRATEGY_CONFIG.symbol);
  const sizing = checkOrderSizing(RISK_CONFIG.quantity, price, filters);

  console.log(`\n--- ORDER THAT WOULD BE PLACED ---`);
  console.log(`  Symbol:     ${STRATEGY_CONFIG.symbol}`);
  console.log(`  Side:       ${risk.action}`);
  console.log(`  Type:       MARKET`);
  console.log(`  Quantity:   ${sizing.adjustedQty} ${filters.baseAsset}`);
  console.log(`  Est. value: ${sizing.notional.toFixed(2)} ${filters.quoteAsset} @ ${price}`);
  console.log(`  Venue:      Binance Spot TESTNET (fake money)`);

  if (sizing.problems.length > 0) {
    console.log(`\n  Sizing notes:`);
    for (const p of sizing.problems) console.log(`    - ${p}`);
  }

  if (!sizing.ok) {
    console.log(`\nThis order would be REJECTED by the exchange. Fix the sizing before going further.`);
    process.exit(1);
  }

  // Binance's own validator — same checks as a real order, but nothing is created.
  try {
    await client.testOrder(STRATEGY_CONFIG.symbol, risk.action, sizing.adjustedQty);
    console.log(`\n  Binance validated this order (via /order/test). It would be accepted.`);
  } catch (err) {
    console.log(`\n  Binance REJECTED this order in validation: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`\nNothing was sent. To actually place it on testnet: npm run broker:trade`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
