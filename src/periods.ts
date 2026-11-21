// Tests the strategy across distinct historical ERAS — the closest thing to a
// true out-of-sample test available without waiting years for new data.
//
// Everything else in this project was measured on roughly 2022-2026, a window
// containing one enormous bull run. Almost any strategy that stays long through
// that looks competent. The real question is how it behaved in the 2018 bear
// market, through the March 2020 crash, and across the 2021 peak — periods you
// have not looked at while designing any of this.
//
// Each era is a contiguous, NON-OVERLAPPING slice, so a good result in one does
// not prop up another. Buy-and-hold is measured over the identical slice, so
// the comparison is exactly like-for-like.
//
// Run with: npm run periods

import { fetchHistoricalCandles } from "./market";
import { STRATEGY_CONFIG, RISK_CONFIG, COST_CONFIG } from "./bot";
import { assertPaperMode } from "./guardrails";
import { runSignalBacktest } from "./signalBacktest";
import { Candle, StrategyConfig, StrategyType } from "./types";

const TOTAL_CANDLES = Number(process.env.PERIODS_CANDLES ?? 3500); // as far back as Binance goes for BTC daily
const ERA_COUNT = Number(process.env.PERIODS_COUNT ?? 4);
const INTERVAL = process.env.INTERVAL ?? "1d";
const STRATEGY = (process.env.STRATEGY as StrategyType) ?? "trend_following";
const LOOKBACK = Number(process.env.TREND_LOOKBACK ?? STRATEGY_CONFIG.trendLookback);

// The combined test: every lookback against every era. One parameter surviving
// every era could still be a lucky needle; a whole RANGE of parameters
// surviving every era is much harder to explain as chance.
const MATRIX_LOOKBACKS = (process.env.PERIODS_LOOKBACKS ?? "30,50,80,100,130,160,200").split(",").map(Number);

function pct(v: number): string {
  return (v * 100).toFixed(1) + "%";
}
function pad(s: string, n: number): string {
  return s.padEnd(n);
}

interface EraResult {
  label: string;
  from: string;
  to: string;
  candles: number;
  trades: number;
  cagr: number;
  maxDD: number;
  bhCagr: number;
  bhMaxDD: number;
  exposure: number;
}

async function main() {
  assertPaperMode();

  console.log(`Out-of-sample era test — ${STRATEGY} (lookback ${LOOKBACK}) on ${STRATEGY_CONFIG.symbol} ${INTERVAL}`);
  console.log(`Splitting all available history into ${ERA_COUNT} non-overlapping eras.\n`);

  const all: Candle[] = await fetchHistoricalCandles(STRATEGY_CONFIG.symbol, INTERVAL, TOTAL_CANDLES);
  console.log(`Fetched ${all.length} candles: ${new Date(all[0].openTime).toISOString().slice(0, 10)} to ${new Date(all[all.length - 1].closeTime).toISOString().slice(0, 10)}\n`);

  const eraSize = Math.floor(all.length / ERA_COUNT);
  if (eraSize < LOOKBACK + 50) {
    console.log(`Each era would only be ${eraSize} candles, too short for a ${LOOKBACK}-period lookback.`);
    console.log(`Reduce PERIODS_COUNT or TREND_LOOKBACK, or raise PERIODS_CANDLES.`);
    return;
  }

  const config: StrategyConfig = { ...STRATEGY_CONFIG, strategyType: STRATEGY, interval: INTERVAL, trendLookback: LOOKBACK };
  const results: EraResult[] = [];

  for (let i = 0; i < ERA_COUNT; i++) {
    const start = i * eraSize;
    const end = i === ERA_COUNT - 1 ? all.length : (i + 1) * eraSize;
    const slice = all.slice(start, end);

    // No warm-up candles are borrowed from the previous era: the first
    // `LOOKBACK` bars simply have no moving average yet, so the strategy sits
    // flat — exactly what a bot started fresh in that era would do. Buy-and-hold
    // covers the identical slice, so neither side gets an advantage.
    const r = runSignalBacktest(slice, config, RISK_CONFIG, COST_CONFIG, false);

    results.push({
      label: `Era ${i + 1}`,
      from: new Date(slice[0].openTime).toISOString().slice(0, 10),
      to: new Date(slice[slice.length - 1].closeTime).toISOString().slice(0, 10),
      candles: slice.length,
      trades: r.trades.length,
      cagr: r.strategy.cagrPct,
      maxDD: r.strategy.maxDrawdownPct,
      bhCagr: r.buyHold.cagrPct,
      bhMaxDD: r.buyHold.maxDrawdownPct,
      exposure: r.strategy.exposurePct,
    });
  }

  console.log("=".repeat(104));
  console.log("RESULTS BY ERA");
  console.log("=".repeat(104));
  console.log(
    pad("era", 7), pad("from", 12), pad("to", 12), pad("trades", 8),
    pad("CAGR", 10), pad("maxDD", 10), pad("B&H CAGR", 11), pad("B&H maxDD", 11), "verdict"
  );
  for (const r of results) {
    const betterReturn = r.cagr > r.bhCagr;
    const betterDD = r.maxDD > r.bhMaxDD;
    const v = betterReturn && betterDD ? "both better" : betterDD ? "safer only" : betterReturn ? "return only" : "worse on both";
    console.log(
      pad(r.label, 7), pad(r.from, 12), pad(r.to, 12), pad(String(r.trades), 8),
      pad(pct(r.cagr), 10), pad(pct(r.maxDD), 10), pad(pct(r.bhCagr), 11), pad(pct(r.bhMaxDD), 11), v
    );
  }

  const ddBetter = results.filter((r) => r.maxDD > r.bhMaxDD).length;
  const retBetter = results.filter((r) => r.cagr > r.bhCagr).length;
  const meanCagr = results.reduce((s, r) => s + r.cagr, 0) / results.length;
  const meanBh = results.reduce((s, r) => s + r.bhCagr, 0) / results.length;
  const losingEras = results.filter((r) => r.cagr < 0);

  console.log("\n" + "=".repeat(104));
  console.log("ACROSS ERAS");
  console.log("=".repeat(104));
  console.log(`  Shallower drawdown than holding: ${ddBetter}/${results.length} eras`);
  console.log(`  Higher return than holding:      ${retBetter}/${results.length} eras`);
  console.log(`  Mean CAGR: ${pct(meanCagr)}   vs buy-and-hold mean: ${pct(meanBh)}`);
  console.log(`  Eras where the strategy lost money: ${losingEras.length}/${results.length}`);

  if (losingEras.length > 0) {
    console.log(`\n  Losing eras:`);
    for (const e of losingEras) {
      console.log(`    ${e.from} to ${e.to}: ${pct(e.cagr)}/yr, drawdown ${pct(e.maxDD)} (holding did ${pct(e.bhCagr)}/yr)`);
    }
    console.log(`  You would have had to keep running it through these. That is the part most people`);
    console.log(`  underestimate — a strategy you abandon during its bad years returns nothing at all.`);
  }

  // ---------- Compounded, not averaged ----------
  // An arithmetic mean of period CAGRs is not what an account would have done:
  // one spectacular era inflates it. Chaining the eras and compounding is the
  // honest figure.
  let chainedStrategy = 1, chainedBH = 1;
  for (let i = 0; i < ERA_COUNT; i++) {
    const start = i * eraSize;
    const end = i === ERA_COUNT - 1 ? all.length : (i + 1) * eraSize;
    const slice = all.slice(start, end);
    const r = runSignalBacktest(slice, config, RISK_CONFIG, COST_CONFIG, false);
    chainedStrategy *= 1 + r.strategy.totalReturnPct;
    chainedBH *= 1 + r.buyHold.totalReturnPct;
  }
  const totalYears = (all[all.length - 1].closeTime - all[0].openTime) / (365.25 * 24 * 3600 * 1000);
  const chainedStratCagr = Math.pow(chainedStrategy, 1 / totalYears) - 1;
  const chainedBHCagr = Math.pow(chainedBH, 1 / totalYears) - 1;

  console.log(`\n  COMPOUNDED across all eras (the figure an account would actually have seen):`);
  console.log(`    Strategy:   ${pct(chainedStrategy - 1)} total, ${pct(chainedStratCagr)} per year`);
  console.log(`    Buy & hold: ${pct(chainedBH - 1)} total, ${pct(chainedBHCagr)} per year`);
  console.log(`    (The "mean CAGR" above averages the eras and is flattered by the single best one.`);
  console.log(`     Trust this compounded line instead.)`);

  // ---------- The combined test: parameters x eras ----------
  console.log("\n" + "=".repeat(104));
  console.log("PARAMETERS x ERAS — the test that matters most");
  console.log("=".repeat(104));
  console.log("One lookback surviving every era could be luck. A whole RANGE surviving every era is");
  console.log("much harder to explain away. Each cell shows the strategy's CAGR minus buy-and-hold's.\n");

  const eraRanges: [number, number][] = [];
  for (let i = 0; i < ERA_COUNT; i++) {
    eraRanges.push([i * eraSize, i === ERA_COUNT - 1 ? all.length : (i + 1) * eraSize]);
  }

  console.log(pad("lookback", 10) + eraRanges.map((_, i) => pad(`Era ${i + 1}`, 12)).join("") + pad("ret wins", 11) + "DD wins");
  let totalCells = 0, retWinCells = 0, ddWinCells = 0;

  for (const lb of MATRIX_LOOKBACKS) {
    if (eraSize < lb + 50) continue;
    const cfgLb: StrategyConfig = { ...config, trendLookback: lb };
    let rowRetWins = 0, rowDDWins = 0;
    const cells: string[] = [];

    for (const [s, e] of eraRanges) {
      const slice = all.slice(s, e);
      const r = runSignalBacktest(slice, cfgLb, RISK_CONFIG, COST_CONFIG, false);
      const diff = r.strategy.cagrPct - r.buyHold.cagrPct;
      const ddBetterCell = r.strategy.maxDrawdownPct > r.buyHold.maxDrawdownPct;
      totalCells++;
      if (diff > 0) { rowRetWins++; retWinCells++; }
      if (ddBetterCell) { rowDDWins++; ddWinCells++; }
      cells.push(pad((diff >= 0 ? "+" : "") + pct(diff), 12));
    }
    console.log(pad(String(lb), 10) + cells.join("") + pad(`${rowRetWins}/${eraRanges.length}`, 11) + `${rowDDWins}/${eraRanges.length}`);
  }

  console.log(`\n  Return beat buy-and-hold in   ${retWinCells}/${totalCells} parameter-era combinations (${((retWinCells / totalCells) * 100).toFixed(0)}%)`);
  console.log(`  Drawdown beat buy-and-hold in ${ddWinCells}/${totalCells} parameter-era combinations (${((ddWinCells / totalCells) * 100).toFixed(0)}%)`);

  // How surprising is that return record, if the strategy had no edge at all?
  // Without this, 64% looks like evidence. It mostly isn't.
  const pAtLeast = (k: number, n: number): number => {
    const choose = (a: number, b: number): number => {
      let r = 1;
      for (let i = 0; i < b; i++) r = (r * (a - i)) / (i + 1);
      return r;
    };
    let p = 0;
    for (let i = k; i <= n; i++) p += choose(n, i) * Math.pow(0.5, n);
    return p;
  };
  const pValue = pAtLeast(retWinCells, totalCells);
  console.log(`\n  If the strategy had NO return edge and each cell were a coin flip, getting ${retWinCells} or more`);
  console.log(`  wins out of ${totalCells} would happen ${(pValue * 100).toFixed(1)}% of the time. ${pValue > 0.05 ? "That is not rare enough to be evidence." : "That is unlikely by chance alone."}`);
  console.log(`  And these cells are NOT independent — they share eras and share one asset — so the real`);
  console.log(`  probability is higher still. Treat ${((retWinCells / totalCells) * 100).toFixed(0)}% as weaker than it looks.`);

  // The row that wins everything is the single most seductive trap in this table.
  const eraN = eraRanges.length;
  const rowsTested = MATRIX_LOOKBACKS.filter((lb) => eraSize >= lb + 50).length;
  const pPerfectRow = 1 - Math.pow(1 - Math.pow(0.5, eraN), rowsTested);
  console.log(`\n  BEWARE THE PERFECT ROW. With ${rowsTested} lookbacks tested over ${eraN} eras, the chance that at least`);
  console.log(`  one lookback wins EVERY era by luck alone is ${(pPerfectRow * 100).toFixed(0)}%. So a row going ${eraN}/${eraN} is exactly what`);
  console.log(`  randomness produces — it is not a discovery, and picking it now is textbook data mining.`);

  if (ddWinCells === totalCells) {
    console.log(`\n  Drawdown reduction held in EVERY parameter-era combination tested. At this point that`);
    console.log(`  claim is about as well-supported as this data can make it.`);
  }
  if (retWinCells / totalCells >= 0.7) {
    console.log(`  Return outperformance held in most combinations too — notably stronger evidence than`);
    console.log(`  one parameter on one window. Still one asset in one market, so not a law of nature.`);
  } else if (retWinCells / totalCells >= 0.4) {
    console.log(`  Return outperformance is a coin-flip across combinations — roughly half win, half lose.`);
    console.log(`  Treat the return advantage as unproven; the drawdown advantage is the real finding.`);
  } else {
    console.log(`  Return outperformance did NOT generalise — it fails in most combinations. The apparent`);
    console.log(`  edge at lookback ${LOOKBACK} was a lucky parameter, exactly what this test exists to catch.`);
  }

  console.log("\n" + "=".repeat(104));
  console.log("HOW TO READ THIS");
  console.log("=".repeat(104));
  if (ddBetter === results.length) {
    console.log(`  The drawdown reduction held in EVERY era, including ones you never looked at while`);
    console.log(`  building this. That is the strongest evidence in the whole project for it being real`);
    console.log(`  and structural rather than fitted.`);
  } else {
    console.log(`  The drawdown reduction did NOT hold everywhere (${ddBetter}/${results.length} eras). It is less`);
    console.log(`  structural than the earlier tests suggested — treat that claim with more caution.`);
  }
  if (meanCagr < meanBh) {
    console.log(`\n  On return it underperformed holding on average across eras (${pct(meanCagr)} vs ${pct(meanBh)}).`);
    console.log(`  Consistent with everything else: this is a risk-reduction tool, not a return engine.`);
  } else {
    console.log(`\n  On return it beat holding on average across eras (${pct(meanCagr)} vs ${pct(meanBh)}).`);
    console.log(`  Encouraging — but eras within one asset still share market-wide cycles, so this is`);
    console.log(`  weaker evidence than ${results.length} truly independent tests would be.`);
  }
  console.log(`\n  Caveat that does not go away: these eras are all crypto, all one asset, and the whole`);
  console.log(`  sample is about ${(all.length / 365).toFixed(0)} years. Traditional trend-following research uses decades across`);
  console.log(`  dozens of uncorrelated markets. This is suggestive evidence, not established fact.`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
