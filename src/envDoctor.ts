// Works out why the bot isn't in the mode you think it is, and tells you the
// one thing to change.
//
//   npm run env:doctor
//
// This runs entirely on your machine and NEVER prints a secret value — only
// whether each variable is set, and for keys a masked fingerprint. It is safe
// to screenshot or paste anywhere.
//
// It exists because "TRADING_MODE is testnet" can have three different causes
// that look identical from the outside: the .env line, a duplicate .env line,
// or a leftover shell variable that silently outranks the file.

import * as fs from "fs";
import * as path from "path";
import { maskSecret, LIVE_ACK_PHRASE } from "./guardrails";

const ENV_PATH = path.join(__dirname, "..", ".env");

interface EnvLine {
  key: string;
  value: string;
  lineNo: number;
}

/** Parses .env without evaluating it. Values stay local; only names are reported. */
function parseEnvFile(): { lines: EnvLine[]; exists: boolean } {
  if (!fs.existsSync(ENV_PATH)) return { lines: [], exists: false };
  const raw = fs.readFileSync(ENV_PATH, "utf-8");
  const lines: EnvLine[] = [];
  raw.split(/\r?\n/).forEach((text, i) => {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    lines.push({
      key: trimmed.slice(0, eq).trim(),
      value: trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, ""),
      lineNo: i + 1,
    });
  });
  return { lines, exists: true };
}

const SECRET_KEYS = [
  "BINANCE_LIVE_API_KEY",
  "BINANCE_LIVE_API_SECRET",
  "BINANCE_TESTNET_API_KEY",
  "BINANCE_TESTNET_API_SECRET",
];

function show(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "(not set)";
  if (SECRET_KEYS.includes(key)) return maskSecret(value);
  return `"${value}"`;
}

function main(): void {
  console.log("\nENV DOCTOR — why the bot is in the mode it's in");
  console.log("No secret values are printed. Safe to share.\n");
  console.log("=".repeat(70));

  const { lines, exists } = parseEnvFile();
  const problems: string[] = [];
  const fixes: string[] = [];

  if (!exists) {
    console.log(`\n  No .env file found at ${ENV_PATH}`);
    console.log(`  Every setting would have to come from the shell. Create the file first.\n`);
    process.exit(1);
  }

  // --- duplicates: the silent one. Node applies the file top to bottom, so the
  // LAST occurrence wins and a stale line above it is simply overwritten. The
  // danger is the reverse case: a correct line near the top, overridden by an
  // old one further down that you forgot was there. ---
  const seen = new Map<string, EnvLine[]>();
  for (const l of lines) {
    if (!seen.has(l.key)) seen.set(l.key, []);
    seen.get(l.key)!.push(l);
  }

  console.log("\n.env file contents (names and line numbers only):\n");
  for (const [key, occurrences] of seen) {
    const marker = occurrences.length > 1 ? "  <-- DUPLICATE" : "";
    const where = occurrences.map((o) => `line ${o.lineNo}`).join(", ");
    console.log(`  ${key.padEnd(30)} ${where}${marker}`);
    if (occurrences.length > 1) {
      const winner = occurrences[occurrences.length - 1];
      problems.push(
        `${key} appears ${occurrences.length} times in .env (${where}). ` +
          `Line ${winner.lineNo} is the one that takes effect; the others are ignored.`
      );
      fixes.push(`Delete the extra ${key} lines from .env, keeping only the one you want.`);
    }
  }

  // --- what the process actually sees ---
  const interesting = [
    "TRADING_MODE",
    "LIVE_TRADING_ACKNOWLEDGED",
    "MAX_ORDER_NOTIONAL",
    "BINANCE_LIVE_API_KEY",
    "BINANCE_LIVE_API_SECRET",
    "BINANCE_TESTNET_API_KEY",
    "BINANCE_TESTNET_API_SECRET",
  ];

  console.log("\nEffective values (what the bot will actually use):\n");
  for (const key of interesting) {
    // The file's effective value is its LAST occurrence, not its first —
    // comparing against the first reports a duplicate as a shell override,
    // which sends you hunting for a problem that isn't there.
    const occurrences = seen.get(key);
    const fileEntry = occurrences ? occurrences[occurrences.length - 1] : undefined;
    const effective = process.env[key];
    let source = "not set anywhere";
    if (effective !== undefined && effective !== "") {
      // A shell variable outranks the file: Node's --env-file does not override
      // something already present in the environment. This is THE trap.
      if (fileEntry && fileEntry.value !== effective) source = "SHELL (overriding .env!)";
      else if (fileEntry) source = ".env";
      else source = "shell";
    }
    console.log(`  ${key.padEnd(30)} ${show(key, effective).padEnd(28)} ${source}`);

    if (source.startsWith("SHELL (")) {
      problems.push(
        `${key} is set in your PowerShell session to something different from .env. ` +
          `The shell wins, so your .env edit is being ignored.`
      );
      fixes.push(`Remove-Item Env:${key}`);
    }
  }

  // --- mode-specific verdict ---
  const mode = (process.env.TRADING_MODE ?? "paper").trim().toLowerCase();
  console.log(`\n${"=".repeat(70)}`);
  console.log(`\nCurrent effective mode: ${mode.toUpperCase()}\n`);

  // Live readiness is reported in FULL regardless of the current mode.
  //
  // Checking these only once already in live mode produced a miserable loop:
  // fix one line, rerun, get told about the next one, repeat four times. If you
  // are heading for live, you should see the whole list at once.
  const ack = (process.env.LIVE_TRADING_ACKNOWLEDGED ?? "").trim();
  const liveKey = (process.env.BINANCE_LIVE_API_KEY ?? "").trim();
  const liveSecret = (process.env.BINANCE_LIVE_API_SECRET ?? "").trim();

  const requirements: { label: string; ok: boolean; fix: string }[] = [
    {
      label: `TRADING_MODE is "live"`,
      ok: mode === "live",
      fix: (() => {
        const occ = seen.get("TRADING_MODE");
        const last = occ ? occ[occ.length - 1] : undefined;
        return last
          ? `Change .env line ${last.lineNo} from "TRADING_MODE=${last.value}" to "TRADING_MODE=live"`
          : `Add to .env:   TRADING_MODE=live`;
      })(),
    },
    {
      label: `LIVE_TRADING_ACKNOWLEDGED is the exact phrase`,
      ok: ack === LIVE_ACK_PHRASE,
      fix: `Add to .env:   LIVE_TRADING_ACKNOWLEDGED=${LIVE_ACK_PHRASE}`,
    },
    {
      label: `BINANCE_LIVE_API_KEY is set`,
      ok: liveKey.length > 0,
      fix: `Add to .env:   BINANCE_LIVE_API_KEY=<the key from Binance>`,
    },
    {
      label: `BINANCE_LIVE_API_SECRET is set`,
      ok: liveSecret.length > 0,
      fix: `Add to .env:   BINANCE_LIVE_API_SECRET=<the secret from Binance>`,
    },
    {
      label: `MAX_ORDER_NOTIONAL is set (optional — defaults to 25)`,
      ok: true, // never blocking; shown for completeness
      fix: `Optionally add:   MAX_ORDER_NOTIONAL=25`,
    },
  ];

  console.log("Live-mode readiness:\n");
  for (const r of requirements) {
    console.log(`  [${r.ok ? "x" : " "}] ${r.label}`);
  }

  const missing = requirements.filter((r) => !r.ok);
  if (missing.length > 0) {
    problems.push(
      `Live mode is not ready: ${missing.length} of ${requirements.length - 1} requirements are not met ` +
        `(see the checklist above).`
    );
    for (const m of missing) fixes.push(m.fix);
  }

  if (mode === "live" && (process.env.BINANCE_TESTNET_API_KEY ?? "").trim()) {
    console.log(`\n  Note: testnet keys are also present. That is fine — live mode ignores them.`);
  }
  console.log("");

  if (problems.length === 0) {
    console.log("  Nothing wrong found. The environment is set up for the mode above.");
    console.log("\n  Next: npm run live:check\n");
    process.exit(0);
  }

  console.log("  PROBLEMS FOUND:\n");
  problems.forEach((p, i) => console.log(`   ${i + 1}. ${p}`));
  console.log("\n  DO THIS:\n");
  [...new Set(fixes)].forEach((f, i) => console.log(`   ${i + 1}. ${f}`));
  console.log("\n  Then run:  npm run env:doctor   again to confirm.\n");
  process.exit(1);
}

main();
