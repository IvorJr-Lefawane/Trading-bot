// Preflight checks that run before ANY live order, every time.
//
// These are not a one-off setup wizard. Every live command calls this at
// startup, because the things it checks can change between runs: a key's
// permissions can be edited on the website, a balance can move, a HALT file
// can appear.

import { assertNotHalted, LiveConfig } from "./guardrails";
import { ApiRestrictions, BinanceSpotClient, SymbolFilters } from "./binanceClient";

export interface PreflightResult {
  restrictions: ApiRestrictions;
  filters: SymbolFilters;
  price: number;
  quoteFree: number;
  baseFree: number;
  clockOffsetMs: number;
}

function line(msg: string): void {
  console.log(`  ${msg}`);
}

function stop(message: string): never {
  console.error("\n=== PREFLIGHT FAILED — NO ORDER WILL BE PLACED ===");
  console.error(message);
  console.error("==================================================\n");
  process.exit(1);
}

/**
 * The withdrawal check is the one that matters most.
 *
 * A trading bot never needs withdrawal permission. A key that holds it turns
 * any leak — a committed .env, a screenshot, a compromised laptop — from
 * "someone can make bad trades with my money" into "someone can take my
 * money". Refusing to run is the only sane response, and it is not overridable
 * from the environment on purpose.
 */
export function assertKeyCannotWithdraw(r: ApiRestrictions): void {
  if (r.enableWithdrawals) {
    stop(
      `This API key has WITHDRAWALS ENABLED. Refusing to trade with it.\n\n` +
        `Fix it at Binance > Account > API Management > (your key) > Edit restrictions:\n` +
        `  - Turn OFF "Enable Withdrawals"\n` +
        `  - Keep ON  "Enable Spot & Margin Trading"\n\n` +
        `A bot only ever needs to trade. If this key leaks, withdrawal permission is the\n` +
        `difference between losing some trades and losing the account.`
    );
  }
  if (r.enableInternalTransfer) {
    stop(
      `This API key has INTERNAL TRANSFER enabled. Refusing to trade with it.\n` +
        `Turn it off in the key's restrictions — it can move funds between your accounts.`
    );
  }
  if (!r.enableSpotAndMarginTrading) {
    stop(
      `This API key cannot place spot trades. Enable "Enable Spot & Margin Trading" on the key,\n` +
        `or the bot can read your account but never act.`
    );
  }
}

export async function runPreflight(
  client: BinanceSpotClient,
  cfg: LiveConfig,
  symbol: string
): Promise<PreflightResult> {
  console.log("PREFLIGHT — checks that run before every live order\n");

  assertNotHalted();
  line(`Kill switch:      not present (create data/HALT to stop everything)`);

  const clockOffsetMs = await client.syncTime();
  if (Math.abs(clockOffsetMs) > 2000) {
    stop(
      `Your clock is ${clockOffsetMs.toFixed(0)}ms away from Binance's, which is close to the ${5000}ms\n` +
        `recvWindow. Sync your system clock before trading — Windows: Settings > Time & language >\n` +
        `Date & time > "Sync now".`
    );
  }
  line(`Clock offset:     ${clockOffsetMs.toFixed(0)}ms vs the exchange`);

  const restrictions = await client.getApiRestrictions();
  assertKeyCannotWithdraw(restrictions);
  line(`Key permissions:  spot trading ON, withdrawals OFF, transfers OFF`);
  if (!restrictions.ipRestrict) {
    line(`Key IP limit:     NOT SET — consider restricting the key to this machine's IP.`);
  } else {
    line(`Key IP limit:     restricted`);
  }

  const account = await client.getAccount();
  if (!account.canTrade) {
    stop(`The exchange reports this account cannot trade. Check for restrictions on your Binance account.`);
  }

  const filters = await client.getSymbolFilters(symbol);
  const price = await client.getPrice(symbol);
  const quoteFree = account.balances.find((b) => b.asset === filters.quoteAsset)?.free ?? 0;
  const baseFree = account.balances.find((b) => b.asset === filters.baseAsset)?.free ?? 0;

  line(`Account:          ${account.accountType}, trading enabled`);
  line(`Balances:         ${baseFree} ${filters.baseAsset}   ${quoteFree.toFixed(2)} ${filters.quoteAsset}`);
  line(`${symbol}:        ${price}   step ${filters.stepSize}   min notional ${filters.minNotional} ${filters.quoteAsset}`);
  line(`Order cap:        ${cfg.maxOrderNotional} ${filters.quoteAsset} per order`);

  if (cfg.maxOrderNotional < filters.minNotional) {
    stop(
      `Your order cap (${cfg.maxOrderNotional}) is below the exchange minimum for ${symbol} ` +
        `(${filters.minNotional} ${filters.quoteAsset}).\n` +
        `No valid order can be placed. Raise MAX_ORDER_NOTIONAL above ${filters.minNotional}.`
    );
  }

  console.log("\n  All preflight checks passed.\n");
  return { restrictions, filters, price, quoteFree, baseFree, clockOffsetMs };
}

/**
 * Caps an intended quantity to the configured notional limit.
 *
 * The strategy's configured size (0.01 BTC) is far above the small-money cap,
 * so this will usually reduce it. That is the intended behaviour: the cap wins,
 * always, and the reduction is reported rather than applied quietly.
 */
export function capQuantityToNotional(
  intendedQty: number,
  price: number,
  maxNotional: number
): { qty: number; capped: boolean } {
  const intendedNotional = intendedQty * price;
  if (intendedNotional <= maxNotional) return { qty: intendedQty, capped: false };
  return { qty: maxNotional / price, capped: true };
}
