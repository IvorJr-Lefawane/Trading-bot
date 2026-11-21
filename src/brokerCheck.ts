// Read-only connection check against Binance Spot Testnet.
// Places NO orders, previews no orders, cancels nothing. Verifies that the
// connection, credentials, clock and symbol rules are all sane before any
// order-placing command is run.
//
//   npm run broker:check

import { assertTestnetMode, maskSecret, TESTNET_KEY_VAR, TESTNET_BASE_URL } from "./guardrails";
import { BinanceTestnetClient } from "./binanceClient";
import { STRATEGY_CONFIG, RISK_CONFIG } from "./bot";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const creds = assertTestnetMode();

  console.log("Binance Spot Testnet — connection check (read-only, no orders)\n");
  console.log(`  Host:    ${TESTNET_BASE_URL}`);
  console.log(`  API key: ${maskSecret(creds.apiKey)}   (from ${TESTNET_KEY_VAR})`);
  console.log(`  Secret:  ${maskSecret(creds.apiSecret)}\n`);

  const client = new BinanceTestnetClient(creds);
  let failures = 0;

  // 1. Clock — signed requests fail if this drifts too far.
  try {
    const offset = await client.syncTime();
    const ok = Math.abs(offset) < 1000;
    log(`Clock sync: offset ${offset.toFixed(0)}ms vs exchange ${ok ? "— fine" : "— LARGE, signed requests may be rejected"}`);
    if (!ok) failures++;
  } catch (err) {
    failures++;
    log(`Clock sync FAILED: ${(err as Error).message}`);
    console.log("\nCannot reach the testnet at all. Check your internet connection and try again.");
    process.exit(1);
  }

  // 2. Credentials + account state.
  try {
    const account = await client.getAccount();
    log(`Account type: ${account.accountType}   canTrade: ${account.canTrade}`);
    if (!account.canTrade) {
      failures++;
      log(`WARNING: this account cannot trade. Check the key's permissions on testnet.binance.vision.`);
    }
    if (account.balances.length === 0) {
      log(`Balances: none. Testnet accounts are usually pre-funded — if empty, regenerate your key.`);
    } else {
      log(`Balances:`);
      for (const b of account.balances.slice(0, 10)) {
        console.log(`    ${b.asset.padEnd(8)} free ${b.free}   locked ${b.locked}`);
      }
    }
  } catch (err) {
    failures++;
    log(`Account read FAILED: ${(err as Error).message}`);
    console.log(`\nIf this says "Invalid API-key", the key is wrong, or it is a MAINNET key.`);
    console.log(`Testnet keys come from https://testnet.binance.vision and work only there.`);
  }

  // 3. Open orders — should normally be empty on a fresh account.
  try {
    const open = await client.getOpenOrders(STRATEGY_CONFIG.symbol);
    log(`Open orders for ${STRATEGY_CONFIG.symbol}: ${open.length}`);
    for (const o of open) {
      console.log(`    #${o.orderId} ${o.side} ${o.origQty} @ ${o.price} (${o.status})`);
    }
  } catch (err) {
    failures++;
    log(`Open orders read FAILED: ${(err as Error).message}`);
  }

  // 4. Market data + the symbol's trading rules.
  try {
    const price = await client.getPrice(STRATEGY_CONFIG.symbol);
    const f = await client.getSymbolFilters(STRATEGY_CONFIG.symbol);
    log(`${STRATEGY_CONFIG.symbol} price on testnet: ${price}`);
    console.log(`    status ${f.status}   step size ${f.stepSize}   min qty ${f.minQty}   min notional ${f.minNotional} ${f.quoteAsset}`);

    const intended = RISK_CONFIG.quantity;
    const notional = intended * price;
    console.log(`\n  Your configured order size: ${intended} ${f.baseAsset} = ${notional.toFixed(2)} ${f.quoteAsset}`);
    if (f.minNotional > 0 && notional < f.minNotional) {
      failures++;
      console.log(`  PROBLEM: that is below the ${f.minNotional} ${f.quoteAsset} minimum — orders would be rejected.`);
      console.log(`  Minimum workable size here is about ${(f.minNotional / price).toFixed(8)} ${f.baseAsset}.`);
    } else {
      console.log(`  That clears the exchange minimum.`);
    }
  } catch (err) {
    failures++;
    log(`Market data / filters FAILED: ${(err as Error).message}`);
  }

  console.log("\n" + "=".repeat(70));
  if (failures === 0) {
    console.log("CONNECTION REPORT: all checks passed.");
    console.log("  Venue: Binance Spot Testnet (fake money)");
    console.log("  Credentials: loaded from environment, never written to the codebase");
    console.log("  Next step: npm run broker:preview — shows what would be ordered, sends nothing.");
  } else {
    console.log(`CONNECTION REPORT: ${failures} check(s) failed — see above. Fix before placing any order.`);
  }
  console.log("=".repeat(70));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
