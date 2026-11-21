# Research Log

This is the working log for the project, kept in date order as the bot was built and tested. It records what was tried, what the data showed, and the mistakes made along the way and how each was corrected.

**Read it as a history, not a spec.** The early sections describe the first paper-only baseline (a 9/21 MA crossover with no live code path). Later sections replace them: the RSI and MA strategies were rejected, trend following became the default, and testnet and capped live modes were added. The [README](../README.md) describes the current state.

---

## 1. Project Goal
Build a paper-trading bot in TypeScript/Node.js that trades BTCUSDT on Binance using a 9/21 moving-average crossover strategy on 5-minute candles. Paper/test mode only, throughout — the bot never places a real order or touches real funds. The goal for this first phase is an honest, working baseline: real market data in, a clear signal → risk → decision pipeline out, with results reported exactly as they are (win or lose).

## 2. Safety Rules
- Paper trading only. No live-trading code path exists anywhere in this project.
- No API keys are required for this phase — Binance's public market-data endpoints (candles/klines) need no authentication, and "orders" are simulated entirely inside the bot's own code, never sent to Binance.
- If a real API key is ever added later (e.g. for Binance Spot Testnet), it lives only in a local `.env` file, is never pasted into chat, never committed to source control, and never exposed to frontend code.
- The bot takes no action unless it has passed the risk check.

## 3. Strategy Rules
- Symbol: BTCUSDT. Timeframe: 5-minute candles.
- **Original strategy (9/21 MA crossover) was backtested first and replaced.** `replay:raw` on ~1 week of real candles showed BTC range-bound (~2.3% total range), not trending: win rate 59.3% but average PnL -0.06% per trade, because most trades timed out near breakeven well short of the 2% take-profit. Giving trades more time (36 candles instead of 12) made it worse (47.2% win rate, -5.52% max drawdown) — confirming the market genuinely wasn't moving enough for a trend-following crossover, not that trades just needed longer to play out.
- **Current strategy: RSI(14) mean-reversion**, better suited to range-bound conditions.
- Entry: BUY when RSI(14) crosses down through 30 (fresh dip into oversold).
- Exit: SELL when RSI(14) crosses back up through 50 (recovered to neutral).
- HOLD otherwise.
- Backtest note: no TradingView MCP or browser session was available to run a live backtest before this file was written. The bot's own `replay:raw` command runs the active strategy against real historical BTCUSDT candles and reports genuine trade-by-trade results — an honest, code-level equivalent of a TradingView backtest. A Pine Script v5 version of the original MA crossover strategy is provided separately (`ma_crossover_strategy.pine`) if you want to validate that one in TradingView directly; it has not been updated for the RSI version.

## 4. Risk Rules
- Quantity per trade: 0.01 BTC (configurable).
- Max position: 0.01 BTC — only one position open at a time, no pyramiding.
- If a signal would exceed max position, the final action is SKIP.
- Stop-loss: 1% below entry. Take-profit: 2% above entry (1:2 risk-reward).
- Max daily loss: if simulated losses for the day reach -3% of paper balance, the bot stops opening new positions until the next day (existing logic only — this is not a broker-side circuit breaker, just the bot refusing new entries).
- Every decision (BUY, SELL, HOLD, or SKIP) is logged with a plain-English reason.

## 5. Broker/MCP Rules
- Venue: Binance.
- No Binance MCP server is connected in this environment; the fallback is Binance's public REST API (`/api/v3/klines`), which is read-only and requires no API key.
- No account, balance, order, or position endpoints are used in this phase, because none are needed — paper execution is simulated locally.
- If real paper-trading permissions (e.g. Binance Spot Testnet) are added later, that connection must be verified read-only first (account status, balances, open orders) before any order-placing code is added, and it must be explicitly confirmed as test/testnet mode.

## 6. Memory Rules
- **Implemented.** Two local files: `data/ledger.csv` (every real BUY/SELL/SKIP, live or replay, with timestamp, symbol, action, price, quantity, reason, mode, outcome, PnL) and `data/learnings.md` (plain-English lessons, one per real closed loss — never invented or seeded).
- Before `scan` opens a fresh BUY, it checks the ledger: if the last 2 real closed trades for this exact strategy+symbol were both losses, the BUY is downgraded to SKIP. SELL is never blocked by memory.
- `replay:raw` still computes its baseline without using memory — it appends those real results to the ledger/learnings afterward.
- `replay:memory` shows what memory alone would decide on the most recent real setup (SKIP or HOLD only — it never places an order itself).
- `npm run memory:reset` clears both files back to empty.

## 7. Definition of Done — met
- `npm install`, `npm run scan`, `npm run replay:raw`, `npm run replay:memory`, `npm run memory:reset` all work and have been run against real Binance data.
- `npm run guardrail:test` passes all 10 checks: credentials refused, non-paper `TRADING_MODE` refused, order/account/withdrawal endpoints unreachable, paper mode allowed.
- No real broker order endpoint exists anywhere in the code, and no API keys are requested or required.
- `.env.example` documents every knob; `.env`, `node_modules/`, `dist/` and `data/state.json` are git-ignored.

## 8. Known Limitations (recorded honestly, not glossed over)
- `replay:raw` exits trades on a fixed 1%/2% stop/target inside a 12-candle window; the live bot exits on the RSI recovery signal. They are not identical simulations.
- The tested edge (+0.06% average per trade, 53.3% win rate, 30 setups) comes from roughly one week of range-bound BTC data. That is thin and not proof of anything.
- Fees and slippage are not modelled; real costs would reduce every result and could erase an edge this small.
- The memory rule is a simple "last two closes were both losses" check, not pattern recognition. It cannot rescue a strategy with no edge.

## 9. FINAL RESULT — strategy tested and rejected (2026-09-13)

The RSI(14) mean-reversion strategy on BTCUSDT was tested to conclusion and **does not have a
tradeable edge**. This is a well-powered negative result, not an inconclusive one.

**Definitive test:** 1h candles, ~958 days (~2.6 years, covering multiple market regimes),
343 trades, ATR-scaled stops (0.45% stop / 0.91% target vs 0.22% round-trip cost).

| Metric | Value |
|---|---|
| Gross avg per trade | **0.00%** |
| Round-trip cost | −0.22% |
| Net avg per trade | −0.22% |
| Net win rate | 33.5% (115 W / 228 L) |
| Total net | −75.41% |
| Max drawdown | −78.70% |
| t-statistic | −6.41 |
| Standard error | ±0.034% per trade |

**Why this is conclusive.** The gross edge is 0.00% with a standard error of 0.034%, putting the
true edge within roughly ±0.07% at 95% confidence. Clearing costs requires +0.22% — about 6.5
standard errors beyond what the data allows. The strategy does not merely fail to show an edge;
the data actively excludes an edge large enough to matter. RSI dipping below 30 carries no
predictive information about subsequent hourly BTC returns.

**Timeframes tested and eliminated:** 5m, 15m, 1h, 4h, 1d. None net-positive. On 1d, where ATR
(2.71%) dwarfs costs and the fee excuse disappears entirely, gross was −1.25%/trade — confirming
the problem was the signal, not the fees.

### Methodological errors made and corrected along the way
1. **Fees omitted initially.** The first "+0.06%/trade edge" ignored a 0.22% round-trip cost and
   was actually −0.16%/trade. Cost modelling is now mandatory in every backtest.
2. **Degenerate test config.** ATR-scaled targets on 5m produced a 0.111% take-profit against a
   0.22% cost — winning was arithmetically impossible, producing a meaningless 0% win rate over
   270 trades. `checkConfigViability()` now refuses to run such a configuration.
3. **Sample sizes far too small.** Conclusions were nearly drawn from 13–30 trades. 343 trades
   were needed before the error bars meant anything.

### Standing rules for any future strategy tested in this project
- Report net of costs, never gross alone.
- Minimum ~200 trades before any conclusion; check the t-statistic, not the win rate.
- Confirm across multiple independent windows (`replay:windows`), not one period.
- Take-profit must exceed the round-trip cost, ideally by 2x or more.
- Testing many variations and keeping the winner is p-hacking. Form the hypothesis first;
  a winner found by search is a hypothesis needing fresh out-of-sample data, not a result.

## 10. TREND FOLLOWING — tested, and what it actually is (2026-09-13)

Tested `trend_following` (long while price is above its N-period MA, flat below) on daily candles,
2022-08 to 2026-09, with a buy-and-hold benchmark and both robustness attacks.

**Headline at lookback 100 on BTCUSDT:** CAGR 32.8% vs 34.2% holding; max drawdown −20.1% vs −53.0%;
28 trades, 25% win rate, 54.7% time in market, 1.5% annual cost drag.

### The two claims must be judged separately — they disagree

**DRAWDOWN REDUCTION — robust. 14 out of 14 tests.**
Shallower drawdown than buy-and-hold in 9/9 lookbacks (20 through 250) and 5/5 assets
(BTC, ETH, BNB, LTC, ADA). This is structural: being flat during downtrends cuts drawdown
almost mechanically, so it does not depend on getting the parameter right and is not the
kind of effect that gets arbitraged away.

**RETURN ENHANCEMENT — not supported.**
- CAGR across lookbacks ranged 14.7% to 43.1% — a 3x spread. Parameter choice mattered as much
  as the strategy.
- **Mean CAGR across parameters was 27.5%, BELOW buy-and-hold's 34.2%.** Only 2 of 9 settings beat
  holding. The 32.8% at lookback 100 was a fortunate draw, not a repeatable edge.
- Beat holding on return in only 3 of 5 assets — and those three (ETH, BNB, ADA) were assets where
  holding did badly, so "winning" meant losing less, not earning more.
- Worst case LTC: −11.4%/yr with a −64.6% drawdown, over 42 trades. It genuinely fails on
  choppy, declining assets — it churns and bleeds.

### Honest conclusion
This is a **risk-reduction tool, not a return-enhancement tool**. It roughly halves worst-case
drawdown and costs you return on average. Whether that trade is worth making is a judgement about
risk tolerance — the data does not settle it, and it is not evidence of a money-making edge.

### Tooling bug found and fixed
The first robustness verdict printed "results are reasonably stable across parameters" because the
threshold only warned when spread > 2x mean. A 3x best-to-worst CAGR range is not stable. The
heuristic now compares mean CAGR against buy-and-hold (not the best setting), warns when
spread > 0.75x mean, and reports the return and drawdown claims separately instead of merging
them into one misleading verdict.

## 11. FINAL VERDICT — parameters x eras (2026-09-13)

Tested 7 lookbacks (30-200) against 4 non-overlapping eras spanning 2017-08 to 2026-09
(3,315 daily candles, two full bear markets). 28 parameter-era combinations.

| lookback | Era 1 | Era 2 | Era 3 | Era 4 | ret | DD |
|---|---|---|---|---|---|---|
| 30  | +35.8% | +9.3%  | −3.4%  | +2.8%  | 3/4 | 4/4 |
| 50  | +43.7% | +42.7% | +22.6% | +14.0% | 4/4 | 4/4 |
| 80  | +27.5% | −24.5% | +8.3%  | +16.0% | 3/4 | 4/4 |
| 100 | +13.3% | −6.5%  | +17.6% | +17.0% | 3/4 | 4/4 |
| 130 | −16.9% | +12.2% | +37.8% | +15.5% | 3/4 | 4/4 |
| 160 | −22.2% | −20.9% | +41.1% | −5.0%  | 1/4 | 4/4 |
| 200 | −25.2% | −60.6% | +43.9% | −8.8%  | 1/4 | 4/4 |

(cells = strategy CAGR minus buy-and-hold CAGR)

**Drawdown: 28/28 (100%).** Probability of that by chance ≈ 0. Across every parameter, every era,
both bear markets. This is a real, structural property — being flat during downtrends reduces
drawdown mechanically, and it does not depend on choosing the parameter correctly.

**Return: 18/28 (64%).** Under a no-edge null hypothesis, 18-or-more wins out of 28 occurs 9.2%
of the time by chance — not significant. And the cells are not independent (shared eras, one
asset), so the true probability is higher. **The return advantage is unproven.**

**The lookback-50 trap.** That row wins 4/4 and is the most seductive line in the table. With 7
lookbacks tested over 4 eras, the chance that at least one row wins everything by pure luck is
**36%**. A perfect row is what randomness routinely produces at this sample size. Selecting it now
would be textbook data mining. Do not.

**Compounded (lookback 100, chained across eras):** strategy 3307.5% total / 47.5% per year vs
buy-and-hold 1429.6% / 35.1% per year. Encouraging, but it rests on one parameter that the matrix
shows goes negative in Era 2 — so this figure carries much less weight than it appears to.

### Bottom line for the project
A **validated risk-reduction tool with an unproven return advantage.** It reliably roughly halves
worst-case drawdown. It does not reliably beat buy-and-hold on return. Whether trading upside for
a shallower drawdown is worthwhile is a risk-tolerance judgement, not something this data decides.

### Remaining limitations that no further testing here can fix
- One asset class (crypto), ~9 years, 12-15 trades per era. Traditional trend-following research
  spans decades across dozens of uncorrelated markets.
- BTC survived and appreciated enormously over the sample — survivorship bias is baked in.
  Earlier cross-asset testing showed LTC at −11.4%/yr with a −64.6% drawdown.
- Backtests assume every fill happens at the close at the modelled cost. Live slippage,
  outages, and API failures are not modelled anywhere.

## 12. TESTNET ADAPTER — built 2026-09-15

Real authenticated trading against Binance Spot Testnet (fake money). Four commands:

| command | what it does | places orders? |
|---|---|---|
| `broker:check` | connection, clock drift, balances, symbol rules | no |
| `broker:preview` | current signal → exact order, validated by Binance's `/order/test` | no |
| `broker:testorder` | real round-trip buy+sell, measures true trading cost | yes (testnet) |
| `broker:live` | strategy on a timer with reconciliation | yes (testnet) |

### Safety design
- **Mainnet credential variable names are refused in EVERY mode**, paper and testnet alike.
  Testnet keys use different names (`BINANCE_TESTNET_API_KEY` / `_SECRET`), so a real key pasted
  into `BINANCE_API_KEY` cannot start anything.
- `TRADING_MODE` accepts only `paper` or `testnet`. `live`/`real`/`mainnet` are refused — no value
  enables real trading because no real-money code path exists.
- Every signed request is host-checked against `testnet.binance.vision` immediately before sending,
  so a changed base URL cannot silently point orders at a real account.
- `npm run guardrail:test` now runs **17 checks** covering all of the above.

### Verified in the sandbox before shipping
- HMAC-SHA256 signing matches Binance's own published documentation test vector exactly.
- Lot-size rounding always rounds DOWN (never exceeds intended size); dust and sub-minimum
  quantities are rejected before sending.
- Minimum-notional validation catches undersized orders with the exact minimum quantity needed.
- All 17 guardrail checks pass, including mainnet keys refused while in testnet mode.

### Why `broker:testorder` exists
The strategy trades ~7 times a year, so waiting for a live signal to observe the plumbing is
impractical. This does a deliberate round trip at the exchange minimum and reports fill prices,
commission, slippage and partial fills — then compares the **measured** round-trip cost against the
0.22% every backtest assumes. If the real figure is higher, every backtest here is optimistic and
`FEE_PCT_PER_SIDE` / `SLIPPAGE_PCT_PER_SIDE` need raising before any conclusion is trusted.

Note: testnet liquidity is not real liquidity. Treat measured slippage as a sanity check on
mechanics and fee tier, not a true measure of live execution quality.

## 13. FIRST REAL TESTNET RUN — results and what they mean (2026-09-15)

`broker:check` → `broker:preview` → `broker:testorder` were run end to end against Binance Spot
Testnet with the trend-following default (1d candles, lookback 100).

### Round trip that was executed
0.00019 BTC (~14.61 USDT), bought and sold 5 seconds apart.

| | |
|---|---|
| BUY order 2453256 | FILLED, 0.00019 requested / 0.00019 executed, avg 76878.64, slippage +0.0000%, **fee 0 BTC** |
| SELL order 2453322 | FILLED, 0.00019 requested / 0.00019 executed, avg 76892.75, slippage −0.0000%, **fee 0 USDT** |
| Net | +0.0027 USDT — exactly the 0.0184% the price drifted while held |
| Measured round-trip cost | 0.0000% |

### What this DID validate
Signing, clock sync, sizing against LOT_SIZE / MIN_NOTIONAL, order placement, fill parsing,
the sell-back quantity, and balance reconciliation. Both orders filled in a single piece with
no partial fills, and the balances reconciled to the cent. The plumbing works.

### What this did NOT validate — the zero-fee artifact
Both fills report a commission of **zero**. Binance Spot Testnet charges no commission, so the
0.0000% measured cost is a measurement of an exchange that does not charge fees — not a
measurement of trading cost. It is **not** confirmation that the 0.22% modelled figure is
conservative, and the tool's original conclusion ("real cost is lower than modelled — the
backtests were conservative") was wrong in exactly this case.

Prediction made on record before the run was ~0.1% per side, ~0.2% round trip. It came back at
0.0000%, which is "wildly off" — and under the standing rule that a wildly-off number must be
explained rather than accepted, the explanation is the zero-fee schedule, not a favourable venue.

**`brokerTestOrder.ts` was patched** to sum commission across both legs and, when it is zero,
print `MEASUREMENT VOID — NO COMMISSION WAS CHARGED` instead of a reassurance. Real Binance spot
charges 0.1% per side at the base tier (0.075% paying in BNB), so **0.22% round trip remains the
number to plan against** and no backtest conclusion changes.

### Three real bugs the testnet caught before any real money was involved
1. **Fractional timestamp.** Clock-offset arithmetic `(after − before) / 2` produced a `.5` on
   odd-millisecond round trips; Binance rejected it with `-1100 Illegal characters found in
   parameter 'timestamp'`. Fixed with `Math.round()` at both the source and the use site.
2. **Event-vs-state signal mismatch.** `generateTrendSignal` only fired on MA crossings, so a bot
   started mid-uptrend would sit flat forever while the backtest was long — **the live bot could
   not reproduce its own backtest.** `computeSignal` is now position-aware and the two paths agree.
3. **Reconciliation would adopt pre-funded balances.** The testnet account holds 1 BTC the bot
   never bought; `reconcile()` would have adopted it as a position and tried to sell it. It now
   auto-corrects only in the safe direction (bot thinks it holds something the exchange says is
   gone), warns on unexplained balances, and stays flat.

Also fixed: lot-size rounding produced 0.00999 instead of 0.01 from float error, and the first fix
introduced a worse bug (`−log10(0.5) = 0` rounded 7.5 *up* to 8). The final version derives decimals
from the step size's string form and is verified over 50,000 random cases with zero violations.
Defaults were also corrected — a fresh terminal was falling back to the rejected
`rsi_mean_reversion` on 5m instead of `trend_following` on 1d.

### Standing rule added
A cost measurement taken on a venue that charges no fees measures nothing about cost. Before any
real funds are committed, confirm the actual fee tier at Binance → Account → Fees and set
`FEE_PCT_PER_SIDE` from it.


## 14. FAILURE HANDLING — the gap closed before real funds (2026-09-15)

Everything up to this point was tested against an exchange that behaved perfectly. That proves
nothing about the cases that actually cost money. Four concrete failure modes were found in the
existing code by reading it against the question "what happens when this call doesn't come back?"

### 14.1 The one that mattered: a lost order response

`placeMarketOrder` threw a generic error on a network failure, and `brokerLive` logged
`ORDER FAILED` and left the state flat. But a request that never returns does **not** mean the
order never happened — the exchange may have accepted and filled it before the connection died.

The consequence was concrete: the bot would believe it was flat while actually holding BTC, and
`reconcile()` (correctly) refuses to adopt unexplained balances, so the next BUY signal would open
a **second** position on top of the invisible first one. On a real account that is a double-size
position nobody intended.

Fix — a write-ahead intent journal plus a recoverable identity:
1. A `newClientOrderId()` is generated and written to `data/live-state.json` **before** the order
   is sent. If the process dies in the next millisecond, that record is the only evidence the order
   ever existed.
2. A lost response now raises `BinanceUnknownOutcomeError` — a distinct type meaning *unknown*, not
   *failed*. The word choice is the point: the old message asserted something the code did not know.
3. The bot then asks the exchange directly: `findOrderByClientId()`. Binance's `-2013 Order does not
   exist` resolves to `null` (definitely no trade); **any other error is rethrown**, because
   "I could not find out" must never collapse into "it did not happen".
4. If it did fill, the position is adopted and back-filled into the ledger. If the query itself
   fails, the pending record is **kept** so the next cycle asks again — and the bot places no
   further orders until it resolves.

### 14.2 Retries, with the correct asymmetry

Reads (`getPrice`, `getAccount`, `getSymbolFilters`, `getOpenOrders`) retry with exponential
backoff and jitter. Orders are **never** retried automatically. Re-sending an order after a timeout
is precisely how one intended position becomes two.

| condition | retried? | why |
|---|---|---|
| network drop / no response | yes (reads only) | a GET has no side effects |
| HTTP 5xx | yes | exchange-side, transient |
| HTTP 429 rate limit | yes, honouring `Retry-After` | the exchange is telling us when |
| HTTP 418 IP ban | **no** | more requests deepen the ban |
| `-1021` clock drift | yes, after resyncing | retrying unchanged would just fail again |
| ordinary 4xx | **no** | deterministic; will fail identically forever |
| any order POST | **never** | ambiguity is resolved by asking, not by resending |

### 14.3 State that cannot lie

- Writes are atomic: temp file → `fsync` → rename. Without the fsync a power cut can reorder the
  write and the rename and leave an empty file under the real name.
- A corrupt or wrong-shaped state file **throws and refuses to trade** rather than falling back
  to "flat". *"I can't read my notes"* and *"I hold nothing"* are completely different situations.
- State persistence lives in `src/liveState.ts` so it can be tested without an exchange.

### 14.4 Ctrl+C no longer kills mid-order

`SIGINT` printed "stopping after this cycle" and then called `process.exit(0)` immediately. If that
landed between placing an order and recording the fill, the exchange held a position the bot never
wrote down. Now the first Ctrl+C sets a flag and the cycle finishes; a second is an explicit
override with a warning.

### 14.5 `npm run failure:test`

Failure injection with a scripted fake exchange (no network, no keys): retry classification for
every status above, bounded retries, clock-drift resync, lost order responses, the three recovery
outcomes (never arrived / filled / unanswerable), 5,000 client IDs checked against Binance's
accepted format and for uniqueness, and state round-trips including truncated JSON and
valid-JSON-wrong-shape.

### Still not covered
Exchange downtime lasting longer than the retry budget, a partial fill followed by a crash (the
executed quantity is recorded, but the intent to fill the remainder is not), and clock drift large
enough that `recvWindow` fails on every attempt.

## 15. FIRST REAL-MONEY TRADE — and the fee bug it exposed (2026-09-17)

Live mode was added as a single-cycle command (`live:trade`) behind its own credentials, an
explicit acknowledgement phrase, a per-order notional cap and a typed confirmation. Before the
first run, `guardrail:test`, `failure:test` and `env:doctor` passed, and the `live:check`
preflight passed (spot trading ON, withdrawals OFF, transfers OFF, key IP-restricted).

### The trade
`live:trade`, trend_following on BTCUSDT 1d, lookback 100. Price was 13.37% above its 100-day MA → BUY.
The strategy size of 0.01 BTC was capped to the 25 USDT `MAX_ORDER_NOTIONAL`.

| | |
|---|---|
| Order | MARKET BUY, FILLED |
| Quantity | 0.00032 BTC @ avg 76,837.66 |
| Value | 24.59 USDT |
| Fee | 3.2e-7 BTC (0.1%, taken from the BTC received) |

### Bug found: position recorded gross of fees
Binance deducts the fee from the asset received unless fees are paid in BNB. The wallet held
0.00031968 BTC but the state file recorded 0.00032. The exit SELL would have asked for more BTC
than existed and been rejected for insufficient balance — the bot could not have closed its own
position. Testnet charges no fees, so this never appeared there.

**Fixed:**
- `netBaseReceived()` — BUYs now record quantity net of any commission paid in the base asset.
- `sellableQuantity()` — SELLs use min(recorded, wallet free), rounded DOWN to step size. Never more
  than the wallet holds; never more than the bot recorded (coins bought by hand are never sold).
- Applied to both `brokerLiveReal.ts` and `brokerLive.ts` so testnet and live stay identical.
- `failure:test` gained regression checks built from the real fill plus 20,000 random cases.

### Operating rules
- `live:trade` is one cycle per run; there is no unattended live loop. Run it once a day (daily candles).
- No exchange-side stop order exists — if the bot is not run, it does not exit.
- Kill switch: create `data/HALT`.
- Keep the system clock synced; preflight refuses to trade above 2,000 ms of drift.

## 16. A missing state file is not a flat position (2026-10)

After the project moved between machines, the live state file was absent while a real position
was still open. The live command at the time treated a missing file as "holding nothing" — so the
next run, with price still above its 100-day MA, would have bought a **second** time and never been
able to sell the first.

**Fixed:**
- `loadRealStateStrict()` — `live:trade` now **refuses to run** when `data/real-state.json` does not
  exist, and says how to state the position deliberately.
- `npm run state:init -- --flat` or `-- --qty <BTC> --entry <price>` writes the state file from what
  you state. It fetches, guesses and reconstructs nothing: the quantity must come from the
  exchange's reported balance (`live:check`), because the wallet is the only ground truth.
- `failure:test` covers it: a missing file throws, the error refuses to trade in so many words, a
  written position survives the strict loader, and a corrupt file is still refused.

Same class of failure as §15: state that disagrees with the wallet makes the exit impossible.
