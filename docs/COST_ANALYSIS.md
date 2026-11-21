# Cost Analysis: what has to come before any higher-frequency strategy (2026-10-14)

**Status: analysis and plan, not yet carried out.** Every number below comes from the project's own records, Binance's published fee schedule, or arithmetic on those. None of it has been measured on a live account yet.

## Why cost comes before a new strategy

Trading more often for a smaller reward per trade is arithmetically hostile at a 0.22% round-trip cost. Cost grows with every trade, while the edge on each trade stays the same:

| round trips / yr | annual cost drag @ 0.22% | @ 0.17% |
|---|---|---|
| 7 (current `trend_following`) | 1.53% | 1.18% |
| 12 (monthly) | 2.61% | 2.02% |
| 52 (weekly) | 10.83% | 8.47% |
| 365 (daily) | **55.2%** | 46.3% |

Every trade has to earn more than the round-trip cost just to break even. The [research log](RESEARCH_LOG.md) §9 learned this the expensive way: a 0.00% gross edge became −75.41% once 0.22% was charged 343 times.

So the real goal is **a small per-trade edge that survives the round-trip cost**. The cheapest progress is shrinking that cost, which doesn't need an edge at all.

---

## Finding 1: at 25 USDT, dust costs more than fees

The BTCUSDT spot `LOT_SIZE` step is 0.00001 BTC. `sellableQuantity()` rounds **down**, so each round trip can leave up to one full step of BTC unsold.

Using the first real fill:

| | |
|---|---|
| Step size | 0.00001 BTC ≈ 0.77 USDT at 76,800 |
| Position value | 24.59 USDT |
| Recorded net quantity | 0.00031968 BTC |
| Sellable, rounded down | 0.00031 BTC |
| **Stranded** | **0.00000968 BTC ≈ 0.74 USDT** |
| **As % of position** | **≈ 3.0%** |
| Round-trip fee cost, for comparison | 0.22% ≈ 0.054 USDT |

**Dust costs roughly 14 times as much as all the fees together**, and no backtest includes it. It's also a fixed *absolute* amount per round trip, so unlike fees it doesn't grow with position size. As a percentage, it shrinks as the position grows:

| order notional | one step of dust, as % |
|---|---|
| 25 USDT | 3.1% |
| 100 USDT | 0.77% |
| 250 USDT | 0.31% |
| 1,000 USDT | 0.077% |
| 2,500 USDT | 0.031% |

**What this means: at a 25 USDT cap, no frequent strategy can work, whatever the signal.** A 3% leak on each of 52 round trips compounds to a 79% annual drag. That's a limit set by how much capital is used. It isn't a bug in the code.

### Candidate fixes, most valuable first

1. **Raise `MAX_ORDER_NOTIONAL`.** This is the only fix that scales. It's a decision about capital, not code.
2. **Carry dust forward.** Track the cumulative stranded BTC in the state file, and add it to the next SELL once it exceeds one step. Only dust the bot itself created should count, so coins bought by hand are never sold.
3. **Step-align the BUY.** Size the buy so that the quantity left after the fee lands on a step boundary. This interacts with `MIN_NOTIONAL` and needs tests.

---

## Finding 2: the BNB fee discount is real but small

Binance spot at the regular / VIP 0 tier charges **0.100% maker and 0.100% taker**. Paying fees in BNB gives **25% off, i.e. 0.075% on both sides**.

- Current model: 0.1% × 2 fee + 0.01% × 2 slippage = **0.22%**
- With BNB: 0.075% × 2 + 0.01% × 2 = **0.17%**

On the current 7-trades-a-year strategy, that's about 0.35 percentage points a year, which comes to cents on a 25 USDT position. It's still worth doing, because it makes the modelled cost honest and it's a precondition for trading more often. **If the BNB balance runs out, the discount stops without any warning**, so preflight should check the BNB balance.

---

## Finding 3: post-only LIMIT orders aren't worth it

At this fee tier maker and taker fees are the same, so the only saving would be the spread: about 0.01% per side on BTCUSDT. In exchange, a post-only order might not fill, leaving the bot flat while the backtest is long. That's the "live bot can't reproduce its own backtest" failure that was already found and fixed once. It's worth revisiting only at a VIP tier where maker fees are lower than taker fees.

---

## Finding 4: read the fee tier from the API, not the website

`GET /api/v3/account` returns `commissionRates`. Preflight should compare it with `FEE_PCT_PER_SIDE` and **refuse to trade when the configured value is below the exchange's reported rate**. That turns a manual check, which gets forgotten over time, into a rule the code enforces. It also can't be fooled the way testnet's zero-fee fills were.

---

## Execution order

1. **(manual, on Binance)** Buy a small amount of BNB, enable BNB fee deduction and note the spot fee tier.
2. **(code)** Read `commissionRates` in `live:check`, refuse to trade if `FEE_PCT_PER_SIDE` is below it, and warn when BNB is running low.
3. **(code)** Set `FEE_PCT_PER_SIDE` from the verified figure and re-run `replay:raw` and `replay:windows`.
4. **(code)** Add dust carry-forward and step-aligned buy sizing, and extend `failure:test` to cover both.
5. **(decision)** `MAX_ORDER_NOTIONAL`. This decides whether a frequent strategy is worth testing at all.

## Proposed standing rule

**Model dust as a cost.** Any backtest of a strategy that trades more often than about monthly should charge one step of stranded BTC per round trip at the configured order size.
