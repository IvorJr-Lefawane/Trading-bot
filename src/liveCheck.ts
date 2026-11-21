// Read-only connection check against your REAL Binance account.
//
// Places nothing, cancels nothing, changes nothing. Run this first — before
// live:trade — to confirm the key works, the permissions are right, and the
// numbers look like your actual account.
//
//   npm run live:check

import { assertLiveMode, maskSecret, LIVE_KEY_VAR } from "./guardrails";
import { BinanceSpotClient } from "./binanceClient";
import { runPreflight, capQuantityToNotional } from "./livePreflight";
import { STRATEGY_CONFIG, RISK_CONFIG } from "./bot";
import { computeSignal } from "./strategy";
import { fetchCandles } from "./market";
import { checkOrderSizing, roundToStepSize } from "./binanceClient";

async function main(): Promise<void> {
  const cfg = assertLiveMode();

  console.log("\nLIVE ACCOUNT CHECK — read-only. No order is placed by this command.\n");
  console.log(`  Key loaded from ${LIVE_KEY_VAR}: ${maskSecret(cfg.credentials.apiKey)}\n`);

  const client = new BinanceSpotClient(cfg.credentials, "live");
  const pre = await runPreflight(client, cfg, STRATEGY_CONFIG.symbol);

  // Show exactly what a BUY would look like today, without sending it.
  const lookback =
    STRATEGY_CONFIG.strategyType === "trend_following" || STRATEGY_CONFIG.strategyType === "donchian_breakout"
      ? STRATEGY_CONFIG.trendLookback + 5
      : STRATEGY_CONFIG.slowLen + 5;
  const candles = await fetchCandles(STRATEGY_CONFIG.symbol, STRATEGY_CONFIG.interval, lookback);
  const signal = computeSignal(candles, STRATEGY_CONFIG, false);

  const { qty, capped } = capQuantityToNotional(RISK_CONFIG.quantity, pre.price, cfg.maxOrderNotional);
  const rounded = roundToStepSize(qty, pre.filters.stepSize);
  const sizing = checkOrderSizing(rounded, pre.price, pre.filters);

  console.log(`  Signal right now (evaluated as if flat): ${signal.signal}`);
  console.log(`    ${signal.reason}\n`);
  console.log(`  A BUY today would be:`);
  console.log(`    Strategy size:  ${RISK_CONFIG.quantity} ${pre.filters.baseAsset} (~${(RISK_CONFIG.quantity * pre.price).toFixed(2)} ${pre.filters.quoteAsset})`);
  if (capped) {
    console.log(`    After the cap:  ${sizing.adjustedQty} ${pre.filters.baseAsset} (~${sizing.notional.toFixed(2)} ${pre.filters.quoteAsset})`);
  }
  console.log(`    Valid size:     ${sizing.ok ? "yes" : "NO"}   (exchange rules only — funding is checked separately below)`);
  for (const p of sizing.problems) console.log(`      - ${p}`);

  // Sizing validity and affordability are different questions. An order can be
  // perfectly well-formed and still impossible because the account is empty,
  // and saying "valid: yes" without this would be quietly misleading.
  const canAfford = pre.quoteFree >= sizing.notional;
  const holdsBase = pre.baseFree * pre.price > pre.filters.minNotional;

  console.log(`\n  Funding:`);
  console.log(`    Needs:          ${sizing.notional.toFixed(2)} ${pre.filters.quoteAsset}`);
  console.log(`    Available:      ${pre.quoteFree.toFixed(2)} ${pre.filters.quoteAsset}`);

  if (!canAfford) {
    const shortfall = sizing.notional - pre.quoteFree;
    console.log(`\n  NOT ENOUGH ${pre.filters.quoteAsset} TO TRADE.`);
    console.log(`  Short by ${shortfall.toFixed(2)} ${pre.filters.quoteAsset}. Running live:trade now would compute the order`);
    console.log(`  and then block on funding — nothing would be bought and nothing would break.`);
    console.log(`\n  To fund it: deposit or buy ${pre.filters.quoteAsset} on Binance and make sure it lands in your`);
    console.log(`  SPOT wallet (not Funding, Earn or Futures — the bot only reads Spot).`);
    console.log(`  Around ${Math.ceil(sizing.notional * 1.2)} ${pre.filters.quoteAsset} gives room for the order plus fees.`);
    console.log(`\n  Nothing was sent.\n`);
    return;
  }

  if (!holdsBase) {
    console.log(`    Status:         funded — this order could be placed.`);
  }

  console.log(`\n  Nothing was sent. When you are ready: npm run live:trade\n`);
}

main().catch((err) => {
  console.error(`\n[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
