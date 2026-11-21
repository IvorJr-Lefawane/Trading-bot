// Guardrails.
//
// Three modes:
//   paper   — everything simulated locally (default)
//   testnet — real authenticated orders against testnet.binance.vision (fake money)
//   live    — REAL ORDERS WITH REAL MONEY on api.binance.com
//
// Live mode was added deliberately and late, after the testnet adapter had
// caught three real bugs. It is built so that reaching it by accident is very
// close to impossible: every one of the following must be true, and any single
// missing piece stops the process.
//
//   1. TRADING_MODE=live, set explicitly.
//   2. Credentials in BINANCE_LIVE_API_KEY / BINANCE_LIVE_API_SECRET. The
//      generic names (BINANCE_API_KEY, API_KEY, ...) remain REFUSED IN EVERY
//      MODE, so keys pasted into the obvious variable still start nothing.
//   3. LIVE_TRADING_ACKNOWLEDGED set to the exact required phrase.
//   4. A per-order notional cap, which has a low default and a hard ceiling.
//   5. No kill-switch file present.
//   6. The API key must NOT hold withdrawal permission (checked against the
//      exchange itself before the first order — see brokerLiveReal.ts).
//
// Withdrawal and transfer endpoints are blocked in ALL modes, permanently.
// There is no configuration in which this project can move funds off the
// exchange. That is the single most important line in this file.

export type TradingMode = "paper" | "testnet" | "live";

/**
 * Generic real-money credential names. Refused in EVERY mode, including live.
 *
 * This looks odd at first — why refuse real keys in real mode? Because these
 * are the names a person reaches for by reflex. Keeping them permanently
 * poisoned means that pasting a real key into the obvious variable never
 * starts trading; going live requires typing a different name on purpose.
 */
const REFUSED_CREDENTIAL_VARS = [
  "BINANCE_API_KEY",
  "BINANCE_API_SECRET",
  "BINANCE_SECRET_KEY",
  "API_KEY",
  "API_SECRET",
  "EXCHANGE_API_KEY",
  "EXCHANGE_API_SECRET",
];

/** Testnet credentials — deliberately different names so real keys can't be used by accident. */
export const TESTNET_KEY_VAR = "BINANCE_TESTNET_API_KEY";
export const TESTNET_SECRET_VAR = "BINANCE_TESTNET_API_SECRET";

/** Live credentials — a third distinct pair, so no mode can borrow another's keys. */
export const LIVE_KEY_VAR = "BINANCE_LIVE_API_KEY";
export const LIVE_SECRET_VAR = "BINANCE_LIVE_API_SECRET";

/** Must be set to this exact string for live mode to start. */
export const LIVE_ACK_VAR = "LIVE_TRADING_ACKNOWLEDGED";
export const LIVE_ACK_PHRASE = "i-understand-real-money";

export const TESTNET_BASE_URL = "https://testnet.binance.vision";
export const MAINNET_BASE_URL = "https://api.binance.com";

/** Mainnet public market data — allowed in every mode, no key needed. */
const MAINNET_READONLY_ENDPOINTS = [
  "https://api.binance.com/api/v3/klines",
  "https://api.binance.com/api/v3/ticker",
  "https://api.binance.com/api/v3/time",
  "https://api.binance.com/api/v3/exchangeInfo",
];

/**
 * The ONLY mainnet paths this project may ever reach in live mode.
 *
 * Split into two lists purely for readability — both are enforced identically.
 * The public list is not a weaker tier: those endpoints need no key and change
 * nothing, but leaving them off the list entirely just means the bot cannot
 * find out the time or the price, which is how the first live run failed.
 */
const LIVE_SIGNED_ALLOWLIST = [
  "/api/v3/order",
  "/api/v3/order/test",
  "/api/v3/openOrders",
  "/api/v3/account",
  "/api/v3/myTrades",
  "/sapi/v1/account/apiRestrictions", // used to verify the key CANNOT withdraw
];

/** Unauthenticated reads the client makes before it can do anything useful. */
const LIVE_PUBLIC_ALLOWLIST = [
  "/api/v3/time",         // clock sync — without this every signed request fails
  "/api/v3/ticker/price",
  "/api/v3/exchangeInfo", // lot size, tick size, minimum notional
  "/api/v3/klines",
];

/** Everything live mode may request, for the check and for the error message. */
const LIVE_ALLOWLIST = [...LIVE_SIGNED_ALLOWLIST, ...LIVE_PUBLIC_ALLOWLIST];

/**
 * Blocked everywhere, in every mode, forever. No flag, env var or mode enables
 * these. A trading bot has no business moving funds off the exchange, and the
 * defence against a compromised key is that the capability does not exist in
 * the code at all.
 */
const FOREVER_BLOCKED_PATTERNS = [
  "/sapi/v1/capital/withdraw",
  "/sapi/v1/asset/transfer",
  "/sapi/v1/sub-account",
  "/sapi/v1/futures/transfer",
  "/sapi/v1/margin/transfer",
  "/sapi/v1/margin/loan",
  "/sapi/v1/lending",
  "/sapi/v1/staking",
  "/sapi/v1/simple-earn",
  "/api/v3/withdraw",
];

/** Absolute ceiling on a single order, in quote currency. Raising this needs a code edit. */
export const HARD_MAX_ORDER_NOTIONAL = 250;
export const DEFAULT_MAX_ORDER_NOTIONAL = 25;

function fail(message: string): never {
  console.error("\n=== GUARDRAIL TRIPPED — STOPPING ===");
  console.error(message);
  console.error("====================================\n");
  process.exit(1);
}

/** Never print a secret. Shows only enough to confirm which key is loaded. */
export function maskSecret(value: string): string {
  if (!value) return "(not set)";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length} chars)`;
}

export function getTradingMode(): TradingMode {
  const raw = (process.env.TRADING_MODE ?? "paper").trim().toLowerCase();
  if (raw === "paper" || raw === "testnet" || raw === "live") return raw;
  fail(
    `TRADING_MODE is "${raw}", but the only supported values are "paper", "testnet" and "live".\n` +
      `Note that "real" and "mainnet" are NOT accepted — live mode is spelled "live", and needs\n` +
      `several other things set before it will start.`
  );
}

/**
 * The universal check, called first by every entry point.
 *
 * Refuses the generic credential variable names in all three modes, and
 * returns the mode. Live mode's own extra preconditions are in assertLiveMode.
 */
export function assertNoRealMoney(): TradingMode {
  const found = REFUSED_CREDENTIAL_VARS.filter((v) => (process.env[v] ?? "").trim() !== "");
  if (found.length > 0) {
    fail(
      `Credentials are set in refused environment variables (${found.join(", ")}).\n` +
        `This bot refuses to run while they are present — in EVERY mode, live included.\n\n` +
        `These generic names are permanently poisoned on purpose: a real key pasted into the\n` +
        `obvious variable must never start anything.\n\n` +
        `  Testnet keys -> ${TESTNET_KEY_VAR} / ${TESTNET_SECRET_VAR}\n` +
        `  Live keys    -> ${LIVE_KEY_VAR} / ${LIVE_SECRET_VAR}\n\n` +
        `Unset the current ones (PowerShell: Remove-Item Env:${found[0]}).`
    );
  }
  return getTradingMode();
}

/** Backwards-compatible name used by the backtest commands. */
export function assertPaperMode(): void {
  const mode = assertNoRealMoney();
  if (mode === "live") {
    fail(
      `TRADING_MODE is "live", but this is a backtest/simulation command.\n` +
        `Run it with TRADING_MODE=paper so there is no chance of confusion about what it touched.`
    );
  }
}

export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
}

/** Kept as the old name so existing testnet call sites are unchanged. */
export type TestnetCredentials = ExchangeCredentials;

/** For the testnet broker commands: requires testnet mode AND testnet credentials. */
export function assertTestnetMode(): ExchangeCredentials {
  const mode = assertNoRealMoney();
  if (mode !== "testnet") {
    fail(
      `This command talks to Binance Spot Testnet, so TRADING_MODE must be "testnet" (it is "${mode}").\n\n` +
        `PowerShell:  $env:TRADING_MODE="testnet"`
    );
  }
  const apiKey = (process.env[TESTNET_KEY_VAR] ?? "").trim();
  const apiSecret = (process.env[TESTNET_SECRET_VAR] ?? "").trim();
  if (!apiKey || !apiSecret) {
    fail(
      `Testnet credentials are missing. Set both of these (never paste them into a chat):\n` +
        `  ${TESTNET_KEY_VAR}\n  ${TESTNET_SECRET_VAR}\n\n` +
        `Get them free at https://testnet.binance.vision (sign in with GitHub, generate a HMAC key).\n` +
        `Put them in a local .env file — it is already git-ignored.`
    );
  }
  return { apiKey, apiSecret };
}

export interface LiveConfig {
  credentials: ExchangeCredentials;
  maxOrderNotional: number;
}

/**
 * Live mode. Every precondition is checked here, and each failure explains
 * exactly what is missing rather than failing vaguely.
 */
export function assertLiveMode(): LiveConfig {
  const mode = assertNoRealMoney();
  if (mode !== "live") {
    fail(
      `This command places REAL orders with REAL money, so TRADING_MODE must be "live" (it is "${mode}").\n\n` +
        `If you did not intend to trade real funds, you are in the right place — stop here.\n\n` +
        `If you DID mean to, the usual cause is one of three things that look identical:\n` +
        `  - the .env line still says something else\n` +
        `  - there are two TRADING_MODE lines in .env (the last one wins)\n` +
        `  - a leftover shell variable is overriding .env entirely\n\n` +
        `Run this to find out which, without printing any secrets:\n` +
        `  npm run env:doctor`
    );
  }

  assertNotHalted();

  const ack = (process.env[LIVE_ACK_VAR] ?? "").trim();
  if (ack !== LIVE_ACK_PHRASE) {
    fail(
      `Live mode requires an explicit acknowledgement.\n\n` +
        `PowerShell:  $env:${LIVE_ACK_VAR}="${LIVE_ACK_PHRASE}"\n\n` +
        `This exists so that live trading can never begin from a config file someone forgot about.\n` +
        `Typing it is meant to be a moment where you decide, not a box that was already ticked.`
    );
  }

  const apiKey = (process.env[LIVE_KEY_VAR] ?? "").trim();
  const apiSecret = (process.env[LIVE_SECRET_VAR] ?? "").trim();
  if (!apiKey || !apiSecret) {
    fail(
      `Live credentials are missing. Set both (never paste them into a chat, ever):\n` +
        `  ${LIVE_KEY_VAR}\n  ${LIVE_SECRET_VAR}\n\n` +
        `Create the key at Binance > Account > API Management with:\n` +
        `  - "Enable Spot & Margin Trading"  ON\n` +
        `  - "Enable Withdrawals"            OFF   <- this bot refuses to run if it is on\n` +
        `  - IP address restriction          ON, limited to this machine's IP\n\n` +
        `Put them in your local .env file. It is git-ignored.`
    );
  }

  const rawCap = process.env.MAX_ORDER_NOTIONAL;
  const maxOrderNotional = rawCap === undefined ? DEFAULT_MAX_ORDER_NOTIONAL : Number(rawCap);

  if (!Number.isFinite(maxOrderNotional) || maxOrderNotional <= 0) {
    fail(`MAX_ORDER_NOTIONAL must be a positive number of quote currency (got "${rawCap}").`);
  }
  if (maxOrderNotional > HARD_MAX_ORDER_NOTIONAL) {
    fail(
      `MAX_ORDER_NOTIONAL is ${maxOrderNotional}, above this project's hard ceiling of ${HARD_MAX_ORDER_NOTIONAL}.\n\n` +
        `The ceiling is in the source, not the environment, so raising it is a deliberate code change\n` +
        `rather than a typo in a terminal. If you genuinely want to trade larger, edit\n` +
        `HARD_MAX_ORDER_NOTIONAL in src/guardrails.ts and think about it while you do.`
    );
  }

  return { credentials: { apiKey, apiSecret }, maxOrderNotional };
}

/**
 * Kill switch. Creating data/HALT stops every live command immediately, with
 * no need to find a process or remember a flag. Checked before each order too.
 */
export function assertNotHalted(): void {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const haltPath = path.join(__dirname, "..", "data", "HALT");
  if (fs.existsSync(haltPath)) {
    let note = "";
    try {
      note = fs.readFileSync(haltPath, "utf-8").trim();
    } catch { /* the file's presence is the signal; its contents are a courtesy */ }
    fail(
      `HALT file present at data/HALT — refusing to trade.\n` +
        (note ? `\nNote in the file: ${note}\n` : "") +
        `\nDelete the file to resume.`
    );
  }
}

/** Mainnet market data only. Used by the public market-data fetcher. */
export function assertReadOnlyEndpoint(url: string): void {
  assertNeverBlocked(url);
  if (url.startsWith(TESTNET_BASE_URL)) return; // testnet is fake money, checked separately
  const allowed = MAINNET_READONLY_ENDPOINTS.some((prefix) => url.startsWith(prefix));
  if (!allowed) {
    fail(
      `Blocked a request to an endpoint that is not on the read-only market-data allowlist:\n  ${url}\n\n` +
        `Allowed:\n${MAINNET_READONLY_ENDPOINTS.map((e) => "  " + e).join("\n")}`
    );
  }
}

/**
 * The permanent block. Applied to every request in every mode before anything
 * else is considered. Withdrawals, transfers, sub-accounts, margin, lending —
 * none of it is reachable from this project under any configuration.
 */
export function assertNeverBlocked(url: string): void {
  const lower = url.toLowerCase();
  const hit = FOREVER_BLOCKED_PATTERNS.find((p) => lower.includes(p.toLowerCase()));
  if (hit) {
    fail(
      `Blocked a request to a permanently forbidden endpoint:\n  ${url}\n\n` +
        `Matched the blocked pattern "${hit}". Withdrawals, transfers, margin, lending and\n` +
        `sub-account endpoints are unreachable in EVERY mode, with no flag or setting that\n` +
        `enables them. If this fired, something is wrong — stop and work out what.`
    );
  }
}

/**
 * Every signed request is checked here, immediately before it is sent, against
 * the mode it claims to be running in.
 */
export function assertSignedEndpoint(url: string, mode: TradingMode): void {
  assertNeverBlocked(url);

  if (mode === "paper") {
    fail(`A signed request was attempted in paper mode:\n  ${url}\n\nPaper mode sends no authenticated requests at all.`);
  }

  if (mode === "testnet") {
    if (!url.startsWith(TESTNET_BASE_URL)) {
      fail(
        `An authenticated testnet request tried to reach another host:\n  ${url}\n\n` +
          `In testnet mode, signed requests may ONLY go to ${TESTNET_BASE_URL}.`
      );
    }
    return;
  }

  // live
  if (!url.startsWith(MAINNET_BASE_URL)) {
    fail(`A live signed request tried to reach a host that is not ${MAINNET_BASE_URL}:\n  ${url}`);
  }
  const pathOnly = new URL(url).pathname;
  if (!LIVE_ALLOWLIST.includes(pathOnly)) {
    fail(
      `A live request tried to reach a path that is not on the allowlist:\n  ${pathOnly}\n\n` +
        `Allowed in live mode:\n${LIVE_ALLOWLIST.map((e) => "  " + e).join("\n")}`
    );
  }
}

/** Kept for the existing testnet call sites. */
export function assertTestnetEndpoint(url: string): void {
  assertSignedEndpoint(url, "testnet");
}

/** Every simulated fill passes through here — one obvious place proving paper mode sends nothing. */
export function assertSimulatedFill(): void {
  const mode = (process.env.TRADING_MODE ?? "paper").trim().toLowerCase();
  if (mode !== "paper") {
    fail(`The paper-execution path ran while TRADING_MODE is "${mode}". These must never mix.`);
  }
}
