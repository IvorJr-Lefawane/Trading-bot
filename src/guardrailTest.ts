// Proves the guardrails actually work, rather than just claiming they do.
// Each case runs the real scan entry point in a child process with a
// deliberately unsafe environment, and checks that it refuses to start.
// Run with: npm run guardrail:test

import { spawnSync } from "child_process";
import * as path from "path";

const ENTRY = path.join(__dirname, "index.ts");

interface Case {
  name: string;
  env: Record<string, string>;
  shouldBlock: boolean;
}

const cases: Case[] = [
  { name: "BINANCE_API_KEY present", env: { BINANCE_API_KEY: "fake-key-for-testing" }, shouldBlock: true },
  { name: "BINANCE_API_SECRET present", env: { BINANCE_API_SECRET: "fake-secret-for-testing" }, shouldBlock: true },
  { name: "API_KEY present", env: { API_KEY: "fake-key-for-testing" }, shouldBlock: true },
  { name: "TRADING_MODE=live", env: { TRADING_MODE: "live" }, shouldBlock: true },
  { name: "TRADING_MODE=real", env: { TRADING_MODE: "real" }, shouldBlock: true },
  { name: "TRADING_MODE=mainnet", env: { TRADING_MODE: "mainnet" }, shouldBlock: true },
  { name: "TRADING_MODE=paper (should be allowed through)", env: { TRADING_MODE: "paper" }, shouldBlock: false },
  // The critical one: real credentials must be refused even when testnet mode is
  // requested. Testnet keys use different variable names precisely so that a real
  // key pasted into the mainnet-named variable can never start the bot.
  {
    name: "mainnet key present WHILE in testnet mode",
    env: {
      TRADING_MODE: "testnet",
      BINANCE_API_KEY: "fake-mainnet-key",
      BINANCE_TESTNET_API_KEY: "fake-testnet-key",
      BINANCE_TESTNET_API_SECRET: "fake-testnet-secret",
    },
    shouldBlock: true,
  },
  {
    name: "testnet mode with testnet keys only (allowed through)",
    env: {
      TRADING_MODE: "testnet",
      BINANCE_TESTNET_API_KEY: "fake-testnet-key",
      BINANCE_TESTNET_API_SECRET: "fake-testnet-secret",
    },
    shouldBlock: false,
  },
];

let failures = 0;

console.log("Testing live-trading guardrails...\n");

for (const c of cases) {
  const result = spawnSync(process.execPath, ["-r", "ts-node/register", ENTRY, "scan"], {
    env: { ...process.env, ...c.env },
    encoding: "utf-8",
    timeout: 60000,
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const blocked = output.includes("GUARDRAIL TRIPPED");

  if (blocked === c.shouldBlock) {
    console.log(`  PASS  ${c.name} — ${blocked ? "blocked as expected" : "allowed as expected"}`);
  } else {
    failures++;
    console.log(`  FAIL  ${c.name} — expected ${c.shouldBlock ? "blocked" : "allowed"}, got ${blocked ? "blocked" : "allowed"}`);
    console.log(output.split("\n").slice(0, 6).map((l) => "        " + l).join("\n"));
  }
}

// Endpoint allowlist: prove order/account endpoints are unreachable through the fetch helper.
const endpointCases: { url: string; shouldBlock: boolean }[] = [
  { url: "https://api.binance.com/api/v3/order?symbol=BTCUSDT&side=BUY", shouldBlock: true },
  { url: "https://api.binance.com/api/v3/account", shouldBlock: true },
  { url: "https://api.binance.com/sapi/v1/capital/withdraw/apply", shouldBlock: true },
  { url: "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m", shouldBlock: false },
];

console.log("\nTesting read-only endpoint allowlist (public market data)...\n");

for (const ec of endpointCases) {
  const result = spawnSync(
    process.execPath,
    ["-r", "ts-node/register", "-e", `require(${JSON.stringify(path.join(__dirname, "guardrails.ts"))}).assertReadOnlyEndpoint(${JSON.stringify(ec.url)})`],
    { encoding: "utf-8", timeout: 60000 }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const blocked = output.includes("GUARDRAIL TRIPPED");

  if (blocked === ec.shouldBlock) {
    console.log(`  PASS  ${ec.url.slice(0, 60)} — ${blocked ? "blocked" : "allowed"} as expected`);
  } else {
    failures++;
    console.log(`  FAIL  ${ec.url} — expected ${ec.shouldBlock ? "blocked" : "allowed"}, got ${blocked ? "blocked" : "allowed"}`);
  }
}

// Signed requests: a changed base URL somewhere must never be able to point an
// authenticated order at a real account.
const signedCases: { url: string; shouldBlock: boolean }[] = [
  { url: "https://api.binance.com/api/v3/order", shouldBlock: true },
  { url: "https://api.binance.com/api/v3/account", shouldBlock: true },
  { url: "https://evil.example.com/api/v3/order", shouldBlock: true },
  { url: "https://testnet.binance.vision/api/v3/order", shouldBlock: false },
];

console.log("\nTesting signed-request host enforcement (orders)...\n");

for (const sc of signedCases) {
  const result = spawnSync(
    process.execPath,
    ["-r", "ts-node/register", "-e", `require(${JSON.stringify(path.join(__dirname, "guardrails.ts"))}).assertTestnetEndpoint(${JSON.stringify(sc.url)})`],
    { encoding: "utf-8", timeout: 60000 }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const blocked = output.includes("GUARDRAIL TRIPPED");

  if (blocked === sc.shouldBlock) {
    console.log(`  PASS  ${sc.url.slice(0, 60)} — ${blocked ? "blocked" : "allowed"} as expected`);
  } else {
    failures++;
    console.log(`  FAIL  ${sc.url} — expected ${sc.shouldBlock ? "blocked" : "allowed"}, got ${blocked ? "blocked" : "allowed"}`);
  }
}

// ---------------------------------------------------------------------------
// LIVE MODE. Every precondition must independently stop the process. These are
// the checks standing between a typo and real money, so each is tested alone.
// ---------------------------------------------------------------------------

const GUARDRAILS = JSON.stringify(path.join(__dirname, "guardrails.ts"));
const HALT_PATH = path.join(__dirname, "..", "data", "HALT");

const GOOD_LIVE_ENV: Record<string, string> = {
  TRADING_MODE: "live",
  LIVE_TRADING_ACKNOWLEDGED: "i-understand-real-money",
  BINANCE_LIVE_API_KEY: "fake-live-key",
  BINANCE_LIVE_API_SECRET: "fake-live-secret",
  MAX_ORDER_NOTIONAL: "25",
};

function runLiveAssert(env: Record<string, string>): string {
  const result = spawnSync(
    process.execPath,
    ["-r", "ts-node/register", "-e", `require(${GUARDRAILS}).assertLiveMode(); console.log("LIVE_MODE_ALLOWED");`],
    { env: { ...process.env, ...env }, encoding: "utf-8", timeout: 60000 }
  );
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

const liveCases: { name: string; env: Record<string, string>; shouldBlock: boolean }[] = [
  {
    name: "live mode with every precondition met (allowed)",
    env: GOOD_LIVE_ENV,
    shouldBlock: false,
  },
  {
    name: "live mode WITHOUT the acknowledgement phrase",
    env: { ...GOOD_LIVE_ENV, LIVE_TRADING_ACKNOWLEDGED: "" },
    shouldBlock: true,
  },
  {
    name: "live mode with a WRONG acknowledgement phrase",
    env: { ...GOOD_LIVE_ENV, LIVE_TRADING_ACKNOWLEDGED: "yes" },
    shouldBlock: true,
  },
  {
    name: "live mode with no credentials",
    env: { ...GOOD_LIVE_ENV, BINANCE_LIVE_API_KEY: "", BINANCE_LIVE_API_SECRET: "" },
    shouldBlock: true,
  },
  {
    name: "live mode with only half the credentials",
    env: { ...GOOD_LIVE_ENV, BINANCE_LIVE_API_SECRET: "" },
    shouldBlock: true,
  },
  {
    name: "live mode with a key in the REFUSED generic variable",
    env: { ...GOOD_LIVE_ENV, BINANCE_API_KEY: "pasted-into-the-obvious-name" },
    shouldBlock: true,
  },
  {
    name: "live mode with the order cap above the hard ceiling",
    env: { ...GOOD_LIVE_ENV, MAX_ORDER_NOTIONAL: "100000" },
    shouldBlock: true,
  },
  {
    name: "live mode with a negative order cap",
    env: { ...GOOD_LIVE_ENV, MAX_ORDER_NOTIONAL: "-5" },
    shouldBlock: true,
  },
  {
    name: "live mode with a non-numeric order cap",
    env: { ...GOOD_LIVE_ENV, MAX_ORDER_NOTIONAL: "lots" },
    shouldBlock: true,
  },
  {
    name: "live credentials present but mode is still testnet",
    env: { ...GOOD_LIVE_ENV, TRADING_MODE: "testnet" },
    shouldBlock: true,
  },
];

console.log("\nTesting LIVE mode preconditions (real money)...\n");

for (const lc of liveCases) {
  const output = runLiveAssert(lc.env);
  const blocked = output.includes("GUARDRAIL TRIPPED") || !output.includes("LIVE_MODE_ALLOWED");
  if (blocked === lc.shouldBlock) {
    console.log(`  PASS  ${lc.name} — ${blocked ? "blocked" : "allowed"} as expected`);
  } else {
    failures++;
    console.log(`  FAIL  ${lc.name} — expected ${lc.shouldBlock ? "blocked" : "allowed"}, got ${blocked ? "blocked" : "allowed"}`);
    console.log(output.split("\n").slice(0, 6).map((l) => "        " + l).join("\n"));
  }
}

// The kill switch, tested for real by creating the file.
console.log("\nTesting the kill switch...\n");
{
  const fs = require("fs") as typeof import("fs");
  const existedBefore = fs.existsSync(HALT_PATH);
  let output = "";
  try {
    fs.mkdirSync(path.dirname(HALT_PATH), { recursive: true });
    fs.writeFileSync(HALT_PATH, "guardrail test");
    output = runLiveAssert(GOOD_LIVE_ENV);
  } finally {
    if (!existedBefore && fs.existsSync(HALT_PATH)) fs.unlinkSync(HALT_PATH);
  }
  const blocked = output.includes("GUARDRAIL TRIPPED");
  if (blocked) {
    console.log("  PASS  data/HALT present — live mode refused to start");
  } else {
    failures++;
    console.log("  FAIL  data/HALT present but live mode started anyway");
  }

  // And that removing it restores normal operation, so the switch isn't sticky.
  const after = runLiveAssert(GOOD_LIVE_ENV);
  if (after.includes("LIVE_MODE_ALLOWED")) {
    console.log("  PASS  HALT removed — live mode starts again");
  } else {
    failures++;
    console.log("  FAIL  HALT was removed but live mode still refuses to start");
  }
}

// Endpoints that must be unreachable in EVERY mode, with no setting that helps.
const foreverBlocked = [
  "https://api.binance.com/sapi/v1/capital/withdraw/apply",
  "https://api.binance.com/sapi/v1/asset/transfer",
  "https://api.binance.com/sapi/v1/margin/loan",
  "https://api.binance.com/sapi/v1/sub-account/transfer/subToMaster",
  "https://api.binance.com/sapi/v1/simple-earn/flexible/subscribe",
];

console.log("\nTesting permanently blocked endpoints (all modes, no override)...\n");

for (const url of foreverBlocked) {
  let allBlocked = true;
  for (const mode of ["paper", "testnet", "live"]) {
    const result = spawnSync(
      process.execPath,
      ["-r", "ts-node/register", "-e", `require(${GUARDRAILS}).assertNeverBlocked(${JSON.stringify(url)})`],
      { env: { ...process.env, ...GOOD_LIVE_ENV, TRADING_MODE: mode }, encoding: "utf-8", timeout: 60000 }
    );
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (!out.includes("GUARDRAIL TRIPPED")) allBlocked = false;
  }
  if (allBlocked) {
    console.log(`  PASS  ${url.replace("https://api.binance.com", "")} — blocked in paper, testnet AND live`);
  } else {
    failures++;
    console.log(`  FAIL  ${url} — reachable in at least one mode`);
  }
}

// Signed-endpoint enforcement in live mode: mainnet trading paths allowed,
// everything else refused.
const liveSignedCases: { url: string; shouldBlock: boolean }[] = [
  { url: "https://api.binance.com/api/v3/order", shouldBlock: false },
  { url: "https://api.binance.com/api/v3/account", shouldBlock: false },
  { url: "https://api.binance.com/sapi/v1/account/apiRestrictions", shouldBlock: false },
  { url: "https://api.binance.com/sapi/v1/capital/withdraw/apply", shouldBlock: true },
  { url: "https://api.binance.com/api/v3/somethingElse", shouldBlock: true },
  { url: "https://testnet.binance.vision/api/v3/order", shouldBlock: true },
  { url: "https://evil.example.com/api/v3/order", shouldBlock: true },
];

console.log("\nTesting signed-request enforcement in LIVE mode...\n");

for (const sc of liveSignedCases) {
  const result = spawnSync(
    process.execPath,
    ["-r", "ts-node/register", "-e", `require(${GUARDRAILS}).assertSignedEndpoint(${JSON.stringify(sc.url)}, "live")`],
    { env: { ...process.env, ...GOOD_LIVE_ENV }, encoding: "utf-8", timeout: 60000 }
  );
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const blocked = out.includes("GUARDRAIL TRIPPED");
  if (blocked === sc.shouldBlock) {
    console.log(`  PASS  ${sc.url.slice(0, 62)} — ${blocked ? "blocked" : "allowed"} as expected`);
  } else {
    failures++;
    console.log(`  FAIL  ${sc.url} — expected ${sc.shouldBlock ? "blocked" : "allowed"}, got ${blocked ? "blocked" : "allowed"}`);
  }
}

// ---------------------------------------------------------------------------
// The test that would have caught the real bug.
//
// Testing the allowlist in isolation only proves the allowlist matches itself.
// The first live run failed because /api/v3/time — which the client calls
// before it can do anything — was never on the list. So: scan the client for
// every endpoint it can actually request, and assert live mode permits each.
// A new endpoint added later fails here rather than in front of a user.
// ---------------------------------------------------------------------------
console.log("\nTesting that live mode permits every endpoint the client actually uses...\n");
{
  const fs = require("fs") as typeof import("fs");
  const clientSrc = fs.readFileSync(path.join(__dirname, "binanceClient.ts"), "utf-8");
  const found = new Set<string>();
  for (const m of clientSrc.matchAll(/"(\/(?:api|sapi)\/[a-zA-Z0-9\/._-]+)"/g)) {
    found.add(m[1]);
  }

  if (found.size === 0) {
    failures++;
    console.log("  FAIL  could not find any endpoint literals in binanceClient.ts — the scan is broken");
  }

  for (const endpoint of [...found].sort()) {
    const url = `https://api.binance.com${endpoint}`;
    const result = spawnSync(
      process.execPath,
      ["-r", "ts-node/register", "-e", `require(${GUARDRAILS}).assertSignedEndpoint(${JSON.stringify(url)}, "live")`],
      { env: { ...process.env, ...GOOD_LIVE_ENV }, encoding: "utf-8", timeout: 60000 }
    );
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (out.includes("GUARDRAIL TRIPPED")) {
      failures++;
      console.log(`  FAIL  ${endpoint} — the client calls this but live mode blocks it`);
    } else {
      console.log(`  PASS  ${endpoint} — client uses it, live mode permits it`);
    }
  }
}

// A signed request must never be possible in paper mode at all.
{
  const result = spawnSync(
    process.execPath,
    ["-r", "ts-node/register", "-e", `require(${GUARDRAILS}).assertSignedEndpoint("https://api.binance.com/api/v3/order", "paper")`],
    { encoding: "utf-8", timeout: 60000 }
  );
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  console.log("");
  if (out.includes("GUARDRAIL TRIPPED")) {
    console.log("  PASS  a signed request in paper mode is refused outright");
  } else {
    failures++;
    console.log("  FAIL  a signed request was permitted in paper mode");
  }
}

console.log(
  failures === 0
    ? "\nAll guardrail checks passed — including every live-money precondition, the kill\nswitch, and the permanent block on withdrawals and transfers in all three modes.\n"
    : `\n${failures} guardrail check(s) FAILED — do not treat this bot as safe until that's fixed.\n`
);
process.exit(failures === 0 ? 0 : 1);
