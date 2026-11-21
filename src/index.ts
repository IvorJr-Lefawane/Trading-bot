import { assertPaperMode } from "./guardrails";
import { runScan } from "./bot";

async function main() {
  assertPaperMode(); // refuses to run if credentials or a non-paper mode are present

  const cmd = process.argv[2];

  if (cmd === "scan") {
    await runScan();
    return;
  }

  console.log("Usage: npm run scan");
  process.exit(1);
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
