// Failure-injection tests.
//
// Everything so far has been tested against an exchange that behaved perfectly.
// That proves nothing about the cases that actually lose money: a dropped
// connection, a rate limit, a rejected order, a crash between sending an order
// and writing it down.
//
// These tests simulate those failures deliberately. No network is used — fetch
// is replaced with a fake that fails on command — so the suite is fast,
// repeatable, and runnable without keys.
//
//   npm run failure:test

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BinanceHttpError,
  BinanceTestnetClient,
  BinanceUnknownOutcomeError,
  netBaseReceived,
  newClientOrderId,
  OrderResult,
  sellableQuantity,
} from "./binanceClient";
import { loadState, loadRealStateStrict, saveState, freshState, todayUTC } from "./liveState";
import { BotState } from "./types";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function expectThrow(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
}

// ---------- fake exchange ----------

interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  networkError?: string; // if set, fetch rejects instead of responding
}

let scripted: FakeResponse[] = [];
let requestLog: string[] = [];

const realFetch = global.fetch;

function installFakeExchange(responses: FakeResponse[]): void {
  scripted = [...responses];
  requestLog = [];
  global.fetch = (async (url: string) => {
    requestLog.push(String(url));
    const next = scripted.shift() ?? { status: 200, body: {} };
    if (next.networkError) throw new Error(next.networkError);
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      headers: { get: (h: string) => next.headers?.[h.toLowerCase()] ?? null },
      text: async () => JSON.stringify(next.body ?? {}),
    };
  }) as unknown as typeof fetch;
}

function restoreFetch(): void {
  global.fetch = realFetch;
}

function makeClient(): BinanceTestnetClient {
  return new BinanceTestnetClient({ apiKey: "test-key", apiSecret: "test-secret" });
}

const timeOk: FakeResponse = { status: 200, body: { serverTime: Date.now() } };

// ---------- tests ----------

async function testReadRetries(): Promise<void> {
  console.log("\n1. Reads retry transient failures, and give up on permanent ones");

  // A read that fails twice then succeeds must still return the price.
  installFakeExchange([
    { networkError: "ECONNRESET" },
    { status: 503, body: { msg: "Service Unavailable" } },
    { status: 200, body: { price: "76500.00" } },
  ]);
  let client = makeClient();
  const price = await client.getPrice("BTCUSDT");
  check("network drop then 503 then success -> retried and returned the price", price === 76500, `got ${price}`);
  check("it took exactly 3 attempts", requestLog.length === 3, `${requestLog.length} requests`);
  restoreFetch();

  // 429 must be retried, honouring Retry-After.
  installFakeExchange([
    { status: 429, body: { msg: "Too many requests" }, headers: { "retry-after": "0" } },
    { status: 200, body: { price: "100" } },
  ]);
  client = makeClient();
  const rateLimited = await client.getPrice("BTCUSDT");
  check("429 rate limit is retried", rateLimited === 100, `got ${rateLimited}`);
  restoreFetch();

  // 418 (IP banned) must NOT be retried — more requests deepen the ban.
  installFakeExchange([{ status: 418, body: { msg: "IP banned" } }, { status: 200, body: { price: "1" } }]);
  client = makeClient();
  const banErr = await expectThrow(() => client.getPrice("BTCUSDT"));
  check("418 IP ban is NOT retried", banErr !== null && requestLog.length === 1, `${requestLog.length} requests`);
  restoreFetch();

  // A deterministic 400 must not be retried either — it would fail identically.
  installFakeExchange([{ status: 400, body: { code: -1121, msg: "Invalid symbol" } }]);
  client = makeClient();
  const badSymbol = await expectThrow(() => client.getPrice("NOTACOIN"));
  check("deterministic 400 is not retried", badSymbol !== null && requestLog.length === 1, `${requestLog.length} requests`);
  check("the Binance error code is preserved", badSymbol instanceof BinanceHttpError && badSymbol.binanceCode === -1121);
  restoreFetch();

  // Retries are finite — a permanently down exchange must eventually give up.
  installFakeExchange(Array(20).fill({ networkError: "ENETDOWN" }));
  client = makeClient();
  const downErr = await expectThrow(() => client.getPrice("BTCUSDT"));
  check("a permanently down exchange gives up rather than looping forever", downErr !== null);
  check("retries are bounded", requestLog.length <= 6, `${requestLog.length} attempts`);
  restoreFetch();
}

async function testClockDriftRecovery(): Promise<void> {
  console.log("\n2. Clock drift mid-session is resynced, not just retried");

  installFakeExchange([
    timeOk, // initial ensureTimeSynced
    { status: 400, body: { code: -1021, msg: "Timestamp for this request is outside of the recvWindow." } },
    timeOk, // the resync triggered by -1021
    { status: 200, body: { canTrade: true, accountType: "SPOT", balances: [] } },
  ]);
  const client = makeClient();
  const account = await client.getAccount();
  check("a -1021 timestamp error triggers a resync and then succeeds", account.canTrade === true);
  check("a /time call was made in response to the drift", requestLog.filter((u) => u.includes("/api/v3/time")).length === 2);
  restoreFetch();
}

async function testOrderNeverRetriedBlindly(): Promise<void> {
  console.log("\n3. A lost order response is never treated as 'no order'");

  // The order POST dies with no response. This is THE dangerous case.
  installFakeExchange([timeOk, { networkError: "socket hang up" }]);
  const client = makeClient();
  const err = await expectThrow(() => client.placeMarketOrder("BTCUSDT", "BUY", 0.01, "cid-test-1"));

  check("a lost order response raises BinanceUnknownOutcomeError", err instanceof BinanceUnknownOutcomeError);
  check("it is NOT reported as a plain failure", err !== null && !/failed|rejected/i.test(err.message), err?.message);
  check("the order was sent exactly once — never blindly resent", requestLog.filter((u) => u.includes("/api/v3/order")).length === 1);
  restoreFetch();
}

async function testOrderRecoveryQuery(): Promise<void> {
  console.log("\n4. The exchange is asked what actually happened");

  // Case A: the order genuinely never arrived.
  installFakeExchange([timeOk, { status: 400, body: { code: -2013, msg: "Order does not exist." } }]);
  let client = makeClient();
  const missing = await client.findOrderByClientId("BTCUSDT", "cid-a", "BUY", 0.01);
  check("'order does not exist' resolves to null — definitely no trade", missing === null);
  restoreFetch();

  // Case B: the order DID exist and filled. The bot must learn it holds a position.
  installFakeExchange([
    timeOk,
    {
      status: 200,
      body: {
        orderId: 999,
        clientOrderId: "cid-b",
        symbol: "BTCUSDT",
        status: "FILLED",
        executedQty: "0.01",
        cummulativeQuoteQty: "765.50",
        type: "MARKET",
        updateTime: 1700000000000,
      },
    },
  ]);
  client = makeClient();
  const found = await client.findOrderByClientId("BTCUSDT", "cid-b", "BUY", 0.01);
  check("a filled order is found after a lost response", found !== null && found.executedQty === 0.01);
  check("its average price is derived correctly without a fills array", found !== null && Math.abs(found.avgFillPrice - 76550) < 0.01, `got ${found?.avgFillPrice}`);
  restoreFetch();

  // Case C: we cannot reach the exchange to ask. This must NOT look like case A.
  installFakeExchange([timeOk, ...Array(20).fill({ networkError: "ENETDOWN" })]);
  client = makeClient();
  const unknown = await expectThrow(() => client.findOrderByClientId("BTCUSDT", "cid-c", "BUY", 0.01));
  check("an unanswerable query throws rather than returning null", unknown !== null);
  check("'could not find out' is never confused with 'did not happen'", unknown !== null);
  restoreFetch();
}

function testClientOrderIds(): void {
  console.log("\n5. Client order IDs are valid and unique");

  const binanceFormat = /^[.A-Z:/a-z0-9_-]{1,36}$/;
  const ids = new Set<string>();
  let allValid = true;
  for (let i = 0; i < 5000; i++) {
    const id = newClientOrderId();
    if (!binanceFormat.test(id)) allValid = false;
    ids.add(id);
  }
  check("5000 generated IDs all match Binance's accepted format", allValid);
  check("5000 generated IDs are all unique", ids.size === 5000, `${ids.size} unique`);
}

function testStatePersistence(): void {
  console.log("\n6. State survives crashes, and refuses to guess when it cannot");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botstate-"));
  const p = path.join(dir, "live-state.json");

  // Missing file is a genuine fresh start.
  const fresh = loadState(p);
  check("a missing state file loads as flat", fresh.inPosition === false);

  // Round trip.
  const inPos: BotState = { ...freshState(), inPosition: true, entryPrice: 76000, quantity: 0.01 };
  saveState(inPos, p);
  const reloaded = loadState(p);
  check("an open position survives a save/load round trip", reloaded.inPosition === true && reloaded.quantity === 0.01);

  // A pending order survives too — this is what makes recovery possible.
  const pending: BotState = { ...inPos, pendingOrder: { clientOrderId: "cid-x", side: "SELL", quantity: 0.01, symbol: "BTCUSDT", sentAt: new Date().toISOString() } };
  saveState(pending, p);
  check("a pending order survives a restart", loadState(p).pendingOrder?.clientOrderId === "cid-x");

  // Truncated JSON — the classic crash-mid-write artifact.
  fs.writeFileSync(p, '{"date":"2026-09-15","inPosition":tr');
  let err: Error | null = null;
  try { loadState(p); } catch (e) { err = e as Error; }
  check("a truncated state file throws instead of loading", err !== null);
  check("the error explicitly refuses to trade", err !== null && /REFUSING TO TRADE/.test(err.message));
  check("it never silently reports flat", err !== null && !/inPosition.*false/.test(err.message));

  // Valid JSON, wrong shape — must also be refused.
  fs.writeFileSync(p, '{"something":"else"}');
  let shapeErr: Error | null = null;
  try { loadState(p); } catch (e) { shapeErr = e as Error; }
  check("valid JSON that is not a bot state is refused", shapeErr !== null);

  // Atomicity: no temp files left behind after a normal save.
  saveState(inPos, p);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
  check("no temp files are left behind after a save", leftovers.length === 0, leftovers.join(", "));

  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * The first real-money BUY (order 66662440058, 2026-09-17) filled 0.00032 BTC
 * with a 3.2e-7 BTC fee taken from the coins received. The bot recorded 0.00032,
 * the wallet held 0.00031968, and the eventual SELL would have been rejected for
 * insufficient balance. These checks pin that down so it cannot come back.
 */
function testFeeDeductedPositionSize(): void {
  console.log("\nTesting position size after fees taken in the base asset...\n");

  const fill = (commission: number, commissionAsset: string): OrderResult => ({
    orderId: 66662440058,
    clientOrderId: "live-test",
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    status: "FILLED",
    requestedQty: 0.00032,
    executedQty: 0.00032,
    cummulativeQuoteQty: 24.59,
    avgFillPrice: 76837.66,
    fills: [{ price: 76837.66, qty: 0.00032, commission, commissionAsset }],
    transactTime: Date.now(),
  });

  const net = netBaseReceived(fill(3.2e-7, "BTC"), "BTC");
  check("BTC fee is subtracted from the recorded position (0.00032 -> 0.00031968)", net === 0.00031968, `got ${net}`);

  const bnb = netBaseReceived(fill(0.00002, "BNB"), "BTC");
  check("fee paid in BNB leaves the position size untouched", bnb === 0.00032, `got ${bnb}`);

  const split: OrderResult = {
    ...fill(0, "BTC"),
    fills: [
      { price: 76837, qty: 0.0002, commission: 2e-7, commissionAsset: "BTC" },
      { price: 76838, qty: 0.00012, commission: 1.2e-7, commissionAsset: "BTC" },
    ],
  };
  const splitNet = netBaseReceived(split, "BTC");
  check("fees across multiple fills are summed", splitNet === 0.00031968, `got ${splitNet}`);

  const sellOld = sellableQuantity(0.00032, 0.00031968, 0.00001);
  check("SELL with the old gross record never exceeds the wallet (-> 0.00031)", sellOld === 0.00031, `got ${sellOld}`);
  check("that SELL is at or below the wallet balance", sellOld <= 0.00031968);

  const sellManual = sellableQuantity(0.00031968, 0.5, 0.00001);
  check("coins bought by hand are never sold (recorded amount wins)", sellManual === 0.00031, `got ${sellManual}`);

  const sellNothing = sellableQuantity(0.00031968, 0, 0.00001);
  check("an empty wallet yields a zero-size SELL, which sizing then blocks", sellNothing === 0, `got ${sellNothing}`);

  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const recorded = Math.random() * 0.01;
    const wallet = Math.random() * 0.01;
    const q = sellableQuantity(recorded, wallet, 0.00001);
    if (q > wallet + 1e-12 || q > recorded + 1e-12) worst++;
  }
  check("20,000 random cases: SELL never exceeds wallet or record", worst === 0, `${worst} violations`);
}

/**
 * The live bot must never infer "flat" from a missing state file.
 *
 * On 2026-10-16 real-state.json was found missing: the live trade had been
 * placed from a copy of the project on another machine, and that machine was
 * gone. The old loader returned a flat state, so the next live run would have
 * bought a second time on top of a position it still held — and, holding no
 * record of the first, could never have sold it.
 */
function testMissingLiveStateRefuses(): void {
  console.log("\nTesting that a missing live state file refuses to trade...\n");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-strict-"));
  const p = path.join(dir, "real-state.json");

  let err: Error | null = null;
  try { loadRealStateStrict(p); } catch (e) { err = e as Error; }
  check("a missing live state file throws instead of returning flat", err !== null);
  check("the error refuses to trade in so many words", (err?.message ?? "").includes("REFUSING TO TRADE"));
  check("the error says how to state a position deliberately", (err?.message ?? "").includes("state:init"));
  check("the permissive loader still treats a missing file as fresh", loadState(p).inPosition === false);

  // Once a position is written, the strict loader returns it unchanged.
  const held: BotState = {
    date: todayUTC(),
    dailyPnLPct: 0,
    inPosition: true,
    entryPrice: 76837.66,
    quantity: 0.00031968,
    pendingOrder: null,
  };
  saveState(held, p);
  const back = loadRealStateStrict(p);
  check("a written position survives the strict loader intact", back.inPosition && back.quantity === 0.00031968, JSON.stringify(back));

  // A corrupt file must still be refused, not silently replaced.
  fs.writeFileSync(p, "{ this is not json");
  let corruptErr: Error | null = null;
  try { loadRealStateStrict(p); } catch (e) { corruptErr = e as Error; }
  check("a corrupt live state file is still refused", corruptErr !== null);

  fs.rmSync(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  console.log("FAILURE-INJECTION TESTS — simulated outages, rate limits, crashes and lost orders");
  console.log("No network access and no API keys are used.\n");
  console.log("=".repeat(76));

  try {
    await testReadRetries();
    await testClockDriftRecovery();
    await testOrderNeverRetriedBlindly();
    await testOrderRecoveryQuery();
    testClientOrderIds();
    testStatePersistence();
    testFeeDeductedPositionSize();
    testMissingLiveStateRefuses();
  } finally {
    restoreFetch();
  }

  console.log("\n" + "=".repeat(76));
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nA failure here is a real failure mode that would bite with real money.");
    process.exit(1);
  }
  console.log("\nAll failure paths behave safely.");
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
