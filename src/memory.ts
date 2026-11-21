// Two-file memory system: data/ledger.csv (every real trade/skip, with real
// outcomes) and data/learnings.md (plain-English lessons distilled from real
// closed trades — live or replay). Nothing here is ever seeded or invented;
// if there's no real outcome yet, there's no entry yet either.

import * as fs from "fs";
import * as path from "path";

const DATA_DIR = path.join(__dirname, "..", "data");
export const LEDGER_PATH = path.join(DATA_DIR, "ledger.csv");
export const LEARNINGS_PATH = path.join(DATA_DIR, "learnings.md");

export const LEDGER_HEADER = "timestamp,symbol,action,price,quantity,reason,mode,outcome,pnl";
const LEARNINGS_TEMPLATE =
  "# Learnings\n\nPlain-English lessons distilled from real closed trades (live or replay). Nothing here is invented or seeded.\n\n";

export interface LedgerRow {
  timestamp: string;
  symbol: string;
  action: string; // BUY | SELL | SKIP
  price: string;
  quantity: string;
  reason: string;
  mode: string; // live | replay | memory
  outcome: string; // open | win | loss | timeout | skipped
  pnl: string; // "" if not applicable (e.g. an open BUY or a SKIP)
}

function ensureFiles(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LEDGER_PATH)) fs.writeFileSync(LEDGER_PATH, LEDGER_HEADER + "\n");
  if (!fs.existsSync(LEARNINGS_PATH)) fs.writeFileSync(LEARNINGS_PATH, LEARNINGS_TEMPLATE);
}

function csvEscape(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

export function appendLedgerRow(row: LedgerRow): void {
  ensureFiles();
  const line = [row.timestamp, row.symbol, row.action, row.price, row.quantity, csvEscape(row.reason), row.mode, row.outcome, row.pnl].join(",");
  fs.appendFileSync(LEDGER_PATH, line + "\n");
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function readLedger(): LedgerRow[] {
  ensureFiles();
  const raw = fs.readFileSync(LEDGER_PATH, "utf-8").trim();
  const lines = raw.split("\n");
  if (lines.length <= 1) return [];
  const rows: LedgerRow[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < 9) continue;
    rows.push({ timestamp: f[0], symbol: f[1], action: f[2], price: f[3], quantity: f[4], reason: f[5], mode: f[6], outcome: f[7], pnl: f[8] });
  }
  return rows;
}

export function appendLearning(text: string): void {
  ensureFiles();
  const existing = fs.readFileSync(LEARNINGS_PATH, "utf-8");
  if (existing.includes(text)) return; // don't duplicate an identical lesson
  fs.appendFileSync(LEARNINGS_PATH, `- ${text}\n`);
}

export function readLearnings(): string {
  ensureFiles();
  return fs.readFileSync(LEARNINGS_PATH, "utf-8");
}

export function resetMemory(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, LEDGER_HEADER + "\n");
  fs.writeFileSync(LEARNINGS_PATH, LEARNINGS_TEMPLATE);
}
