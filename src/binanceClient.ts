// Authenticated Binance Spot client — testnet or live.
//
// Real exchange mechanics: HMAC-signed requests, real order placement, real
// fills, real rejections. Against testnet those cost nothing, which is why the
// failure modes that only appear against a live API (clock drift, lot-size
// rounding, minimum notional, rate limits) were all found there first.
//
// One class serves both venues. The mode decides the base URL and is passed to
// the guardrail on EVERY signed request, immediately before it is sent, so a
// changed default cannot silently point orders at a real account.
//
// Secrets are read from the environment and never logged.

import * as crypto from "crypto";
import {
  ExchangeCredentials,
  MAINNET_BASE_URL,
  TESTNET_BASE_URL,
  TradingMode,
  assertSignedEndpoint,
} from "./guardrails";

const RECV_WINDOW = Number(process.env.RECV_WINDOW_MS ?? 5000);

// Retries apply to READS only. See the comment on `request` for why an order
// POST is never retried automatically.
const MAX_READ_RETRIES = Number(process.env.MAX_READ_RETRIES ?? 4);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS ?? 500);

/** Binance error code for a timestamp outside recvWindow — fixable by resyncing. */
const ERR_TIMESTAMP_OUTSIDE_RECVWINDOW = -1021;

export class BinanceHttpError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly binanceCode: number | undefined,
    readonly retryAfterMs: number | undefined
  ) {
    super(message);
    this.name = "BinanceHttpError";
  }
}

/** A request that never got a response. We do NOT know whether the exchange acted on it. */
export class BinanceUnknownOutcomeError extends Error {
  constructor(message: string, readonly cause: Error) {
    super(message);
    this.name = "BinanceUnknownOutcomeError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Client order IDs make a lost response recoverable.
 *
 * If the network dies after the exchange accepts an order but before we see the
 * reply, the order exists and we don't know it. With a client ID chosen BEFORE
 * sending, we can ask "did the order I called X ever exist?" and get a definite
 * answer instead of guessing. Without one, that question is unanswerable.
 *
 * Binance allows ^[\.A-Z\:/a-z0-9_-]{1,36}$.
 */
export function newClientOrderId(prefix = "bot"): string {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `${prefix}-${stamp}-${rand}`.slice(0, 36);
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
}

export interface AccountInfo {
  canTrade: boolean;
  accountType: string;
  balances: Balance[];
}

export interface OrderFill {
  price: number;
  qty: number;
  commission: number;
  commissionAsset: string;
}

export interface OrderResult {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  status: string;
  requestedQty: number;
  executedQty: number;
  cummulativeQuoteQty: number;
  avgFillPrice: number;
  fills: OrderFill[];
  transactTime: number;
}

export interface OpenOrder {
  orderId: number;
  symbol: string;
  side: string;
  type: string;
  price: number;
  origQty: number;
  executedQty: number;
  status: string;
  time: number;
}

/** The exchange's rules for a symbol. Ignoring these is the #1 cause of rejected orders. */
export interface SymbolFilters {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  stepSize: number;    // quantity must be a multiple of this
  minQty: number;
  maxQty: number;
  tickSize: number;    // price must be a multiple of this
  minNotional: number; // price * qty must be at least this
}

/** The exact permissions a key holds. Used to refuse a key that can withdraw. */
export interface ApiRestrictions {
  enableWithdrawals: boolean;
  enableSpotAndMarginTrading: boolean;
  enableInternalTransfer: boolean;
  enableMargin: boolean;
  enableFutures: boolean;
  ipRestrict: boolean;
}

/**
 * Binance Spot client. The same class serves testnet and live — the ONLY
 * differences are the base URL and the mode passed to the guardrail, which is
 * checked on every single signed request.
 *
 * Sharing one implementation is deliberate: testnet has exercised this exact
 * code, so the live path is not a separate, less-tested cousin of it.
 */
export class BinanceSpotClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  readonly mode: TradingMode;
  private timeOffsetMs = 0;
  private offsetSynced = false;

  constructor(creds: ExchangeCredentials, mode: TradingMode = "testnet") {
    this.apiKey = creds.apiKey;
    this.apiSecret = creds.apiSecret;
    this.mode = mode;
    this.baseUrl = mode === "live" ? MAINNET_BASE_URL : TESTNET_BASE_URL;
  }

  get isLive(): boolean {
    return this.mode === "live";
  }

  // ---------- low level ----------

  private sign(queryString: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(queryString).digest("hex");
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number> = {},
    signed = false
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    assertSignedEndpoint(url.toString(), this.mode);

    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) search.append(k, String(v));

    if (signed) {
      // Binance rejects signed requests whose timestamp drifts from server time.
      // It ALSO rejects any timestamp that isn't pure digits — Math.round here is
      // load-bearing, not cosmetic: a fractional offset produces "...916.5", and
      // the decimal point fails Binance's ^[0-9]{1,20}$ check with error -1100.
      search.append("timestamp", String(Math.round(Date.now() + this.timeOffsetMs)));
      search.append("recvWindow", String(Math.round(RECV_WINDOW)));
      search.append("signature", this.sign(search.toString()));
    }

    const finalUrl = `${url.toString()}?${search.toString()}`;
    assertSignedEndpoint(finalUrl, this.mode);

    let res: Response;
    try {
      res = await fetch(finalUrl, {
        method,
        headers: signed ? { "X-MBX-APIKEY": this.apiKey } : {},
      });
    } catch (err) {
      // The request never completed. For a GET this is merely a failure. For a
      // POST it is genuinely ambiguous — the exchange may have received and
      // executed it — so the error type says "unknown", not "failed", and the
      // caller is responsible for finding out which.
      throw new BinanceUnknownOutcomeError(
        `No response from Binance ${this.mode} (${method} ${path}): ${(err as Error).message}`,
        err as Error
      );
    }

    const text = await res.text();
    if (!res.ok) {
      // Binance error bodies are JSON like {"code":-2010,"msg":"..."} — surface them plainly.
      let detail = text;
      let code: number | undefined;
      try {
        const parsed = JSON.parse(text) as { code?: number; msg?: string };
        code = parsed.code;
        if (parsed.msg) detail = `${parsed.msg}${parsed.code !== undefined ? ` (code ${parsed.code})` : ""}`;
      } catch { /* keep raw text */ }

      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;

      throw new BinanceHttpError(
        `Binance ${this.mode} ${res.status} on ${path}: ${detail}`,
        res.status,
        code,
        Number.isFinite(retryAfterMs) ? retryAfterMs : undefined
      );
    }

    return JSON.parse(text) as T;
  }

  /**
   * Retry wrapper for IDEMPOTENT reads only.
   *
   * Deliberately NOT used for placing orders. Re-sending an order after a
   * timeout is how one intended position becomes two real ones: the first
   * attempt may well have succeeded out of sight. Order placement instead uses
   * a client order ID and asks the exchange what actually happened.
   *
   * Retried: network failures, 5xx, 429 rate limits, and -1021 clock drift
   * (which is resynced first, since retrying it unchanged would just fail again).
   * Not retried: 418 (IP banned — more requests make it worse) and ordinary
   * 4xx rejections, which are deterministic and will fail identically forever.
   */
  private async readWithRetry<T>(
    method: "GET",
    path: string,
    params: Record<string, string | number> = {},
    signed = false
  ): Promise<T> {
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt <= MAX_READ_RETRIES; attempt++) {
      try {
        return await this.request<T>(method, path, params, signed);
      } catch (err) {
        lastErr = err as Error;

        let waitMs = RETRY_BASE_MS * Math.pow(2, attempt);
        let retryable = false;

        if (err instanceof BinanceUnknownOutcomeError) {
          retryable = true; // a GET has no side effects, so re-asking is always safe
        } else if (err instanceof BinanceHttpError) {
          if (err.httpStatus === 418) {
            retryable = false; // banned; backing off harder is the only cure, and not here
          } else if (err.httpStatus === 429) {
            retryable = true;
            waitMs = err.retryAfterMs ?? Math.max(waitMs, 5000);
          } else if (err.httpStatus >= 500) {
            retryable = true;
          } else if (err.binanceCode === ERR_TIMESTAMP_OUTSIDE_RECVWINDOW) {
            // Our clock drifted mid-session. Resync, then the retry can succeed.
            retryable = true;
            try {
              await this.syncTime();
            } catch { /* if the resync itself fails, the retry will surface it */ }
          }
        }

        if (!retryable || attempt === MAX_READ_RETRIES) throw lastErr;

        // Jitter prevents a restarted fleet of bots from retrying in lockstep.
        const jitter = Math.floor(Math.random() * RETRY_BASE_MS);
        await sleep(waitMs + jitter);
      }
    }

    throw lastErr ?? new Error("Unreachable retry state");
  }

  /**
   * Aligns our clock with the exchange's. Signed requests fail with
   * "Timestamp for this request is outside of the recvWindow" if this drifts,
   * which is one of the most common and most confusing live-trading errors.
   */
  async syncTime(): Promise<number> {
    const before = Date.now();
    const { serverTime } = await this.request<{ serverTime: number }>("GET", "/api/v3/time");
    const after = Date.now();
    const latency = (after - before) / 2; // fractional when the round trip is an odd ms
    // Rounded at the source as well, so the offset can never be fractional.
    this.timeOffsetMs = Math.round(serverTime - (before + latency));
    this.offsetSynced = true;
    return this.timeOffsetMs;
  }

  get clockOffsetMs(): number {
    return this.timeOffsetMs;
  }

  private async ensureTimeSynced(): Promise<void> {
    if (!this.offsetSynced) await this.syncTime();
  }

  // ---------- read-only ----------

  async getAccount(): Promise<AccountInfo> {
    await this.ensureTimeSynced();
    const raw = await this.readWithRetry<{
      canTrade: boolean;
      accountType: string;
      balances: { asset: string; free: string; locked: string }[];
    }>("GET", "/api/v3/account", {}, true);

    return {
      canTrade: raw.canTrade,
      accountType: raw.accountType,
      balances: raw.balances
        .map((b) => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) }))
        .filter((b) => b.free > 0 || b.locked > 0),
    };
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrder[]> {
    await this.ensureTimeSynced();
    const raw = await this.readWithRetry<Record<string, string | number>[]>(
      "GET",
      "/api/v3/openOrders",
      symbol ? { symbol } : {},
      true
    );
    return raw.map((o) => ({
      orderId: Number(o.orderId),
      symbol: String(o.symbol),
      side: String(o.side),
      type: String(o.type),
      price: Number(o.price),
      origQty: Number(o.origQty),
      executedQty: Number(o.executedQty),
      status: String(o.status),
      time: Number(o.time),
    }));
  }

  /**
   * What this API key is actually allowed to do, according to the exchange.
   *
   * The point of asking is the withdrawal flag. A trading bot never needs it,
   * and a key that holds it turns any leak — a committed .env, a screenshot, a
   * compromised machine — from "someone can make bad trades with my money" into
   * "someone can take my money". Live mode refuses to start if it is on.
   */
  async getApiRestrictions(): Promise<ApiRestrictions> {
    await this.ensureTimeSynced();
    const raw = await this.readWithRetry<Record<string, unknown>>(
      "GET",
      "/sapi/v1/account/apiRestrictions",
      {},
      true
    );
    return {
      enableWithdrawals: Boolean(raw.enableWithdrawals),
      enableSpotAndMarginTrading: Boolean(raw.enableSpotAndMarginTrading),
      enableInternalTransfer: Boolean(raw.enableInternalTransfer),
      enableMargin: Boolean(raw.enableMargin),
      enableFutures: Boolean(raw.enableFutures),
      ipRestrict: Boolean(raw.ipRestrict),
    };
  }

  async getPrice(symbol: string): Promise<number> {
    const raw = await this.readWithRetry<{ price: string }>("GET", "/api/v3/ticker/price", { symbol });
    return Number(raw.price);
  }

  /** The exchange's trading rules for a symbol — step size, tick size, minimum notional. */
  async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    const raw = await this.readWithRetry<{
      symbols: {
        symbol: string;
        status: string;
        baseAsset: string;
        quoteAsset: string;
        filters: Record<string, string>[];
      }[];
    }>("GET", "/api/v3/exchangeInfo", { symbol });

    const s = raw.symbols.find((x) => x.symbol === symbol);
    if (!s) throw new Error(`Symbol ${symbol} not found on ${this.mode}.`);

    const find = (type: string) => s.filters.find((f) => f.filterType === type);
    const lot = find("LOT_SIZE");
    const price = find("PRICE_FILTER");
    const notional = find("NOTIONAL") ?? find("MIN_NOTIONAL");

    return {
      symbol: s.symbol,
      status: s.status,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      stepSize: Number(lot?.stepSize ?? 0),
      minQty: Number(lot?.minQty ?? 0),
      maxQty: Number(lot?.maxQty ?? 0),
      tickSize: Number(price?.tickSize ?? 0),
      minNotional: Number(notional?.minNotional ?? 0),
    };
  }

  // ---------- orders ----------

  /**
   * Binance's own validator. Same checks as a real order, but nothing is placed.
   * Used by broker:preview so the exchange itself confirms an order is valid
   * before anything is ever sent for real.
   */
  async testOrder(symbol: string, side: "BUY" | "SELL", quantity: number): Promise<void> {
    await this.ensureTimeSynced();
    await this.request("POST", "/api/v3/order/test", { symbol, side, type: "MARKET", quantity }, true);
  }

  private toOrderResult(raw: Record<string, unknown>, side: "BUY" | "SELL", requestedQty: number): OrderResult {
    const fills: OrderFill[] = ((raw.fills as Record<string, string>[]) ?? []).map((f) => ({
      price: Number(f.price),
      qty: Number(f.qty),
      commission: Number(f.commission),
      commissionAsset: String(f.commissionAsset),
    }));

    const executedQty = Number(raw.executedQty ?? 0);
    const quote = Number(raw.cummulativeQuoteQty ?? 0);

    return {
      orderId: Number(raw.orderId),
      clientOrderId: String(raw.clientOrderId ?? ""),
      symbol: String(raw.symbol),
      side: side,
      type: String(raw.type),
      status: String(raw.status),
      requestedQty,
      executedQty,
      cummulativeQuoteQty: quote,
      // A queried order has no `fills` array, so derive the average from the
      // cumulative quote total — which is what we actually paid either way.
      avgFillPrice: executedQty > 0 ? quote / executedQty : 0,
      fills,
      transactTime: Number(raw.transactTime ?? raw.updateTime ?? raw.time ?? Date.now()),
    };
  }

  /**
   * Places a market order, tagged with a caller-supplied client order ID.
   *
   * This is NOT retried on failure, by design. If the call throws a
   * BinanceUnknownOutcomeError the order's fate is genuinely unknown, and the
   * caller must call `findOrderByClientId` with the same ID to establish what
   * really happened before deciding anything.
   */
  async placeMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number,
    clientOrderId?: string
  ): Promise<OrderResult> {
    await this.ensureTimeSynced();
    const params: Record<string, string | number> = {
      symbol,
      side,
      type: "MARKET",
      quantity,
      newOrderRespType: "FULL",
    };
    if (clientOrderId) params.newClientOrderId = clientOrderId;

    const raw = await this.request<Record<string, unknown>>("POST", "/api/v3/order", params, true);
    return this.toOrderResult(raw, side, quantity);
  }

  /**
   * Asks the exchange whether an order with this client ID exists.
   *
   * Returns null if it genuinely never arrived (Binance answers -2013 "Order
   * does not exist"). Any other error is rethrown, because "I could not find
   * out" must never be mistaken for "it did not happen" — that mistake is what
   * causes a bot to place the same order a second time.
   */
  async findOrderByClientId(
    symbol: string,
    clientOrderId: string,
    side: "BUY" | "SELL",
    requestedQty: number
  ): Promise<OrderResult | null> {
    await this.ensureTimeSynced();
    try {
      const raw = await this.readWithRetry<Record<string, unknown>>(
        "GET",
        "/api/v3/order",
        { symbol, origClientOrderId: clientOrderId },
        true
      );
      return this.toOrderResult(raw, side, requestedQty);
    } catch (err) {
      if (err instanceof BinanceHttpError && err.binanceCode === -2013) return null;
      throw err;
    }
  }

  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    await this.ensureTimeSynced();
    await this.request("DELETE", "/api/v3/order", { symbol, orderId }, true);
  }
}

// ---------- order sizing helpers ----------
// Getting these wrong is the most common cause of rejected orders, and they are
// invisible in a backtest because a backtest will happily "fill" 0.0123456789 BTC.

/**
 * Round a quantity DOWN to the exchange's step size. Down, never up — never
 * exceed what was intended.
 *
 * The epsilon is not decoration. Binary floating point cannot represent these
 * decimals exactly, so `0.01 / 0.00001` evaluates to 999.9999999999999, which
 * floors to 999 and silently shaves a whole step off the order. It hits exactly
 * the round numbers people actually use — 0.01, 1, 0.25 — while 0.1 and 0.05
 * happen to survive, which is what makes it easy to miss.
 *
 * The epsilon is relative so it still works for large unit counts, and far
 * smaller than one step so a genuine sub-step remainder is never rounded up.
 */
/**
 * Decimal places of a step size, taken from its actual representation.
 *
 * Deriving this as -log10(stepSize) only works for powers of ten: for a step of
 * 0.5 it yields 0, and the subsequent toFixed(0) then ROUNDS 7.5 up to 8 —
 * turning a round-down helper into one that can exceed the requested size.
 * Some Binance symbols genuinely use steps like 0.5 or 5.
 */
function stepDecimals(stepSize: number): number {
  const s = stepSize.toString();
  const exp = s.indexOf("e-");
  if (exp !== -1) return Number(s.slice(exp + 2));
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

export function roundToStepSize(quantity: number, stepSize: number): number {
  if (stepSize <= 0) return quantity;
  const decimals = stepDecimals(stepSize);
  const units = quantity / stepSize;
  const eps = Math.max(1e-9, Math.abs(units) * 1e-12);
  const rounded = Math.floor(units + eps) * stepSize;
  const result = Number(rounded.toFixed(decimals));
  // Final guarantee: this function must never return more than it was given.
  return result > quantity ? Number((result - stepSize).toFixed(decimals)) : result;
}

/**
 * How much of the base asset a filled order actually put in the wallet.
 *
 * Binance takes the trading fee out of what you RECEIVE unless you pay fees in
 * BNB. On a BUY of 0.00032 BTC at 0.1%, the wallet gets 0.00031968 BTC — not
 * 0.00032. Recording executedQty as the position size makes the later SELL ask
 * for more BTC than exists, and the exchange rejects it for insufficient
 * balance. Testnet charges no fees, which is why this was never seen there.
 */
export function netBaseReceived(order: OrderResult, baseAsset: string): number {
  const feeInBase = order.fills
    .filter((f) => f.commissionAsset === baseAsset)
    .reduce((sum, f) => sum + f.commission, 0);
  const net = Number((order.executedQty - feeInBase).toFixed(12));
  return net > 0 ? net : 0;
}

/**
 * The quantity a SELL may safely ask for: the smaller of what the bot recorded
 * and what the wallet really holds, rounded DOWN to the step size.
 *
 * - Never more than the wallet holds, so the exchange cannot reject for balance.
 * - Never more than the bot recorded, so coins bought by hand are never sold.
 * - Rounding down leaves a sub-step remainder (dust) behind; that is the price
 *   of an order that is guaranteed to be valid.
 */
export function sellableQuantity(recordedQty: number, walletFree: number, stepSize: number): number {
  const capped = Math.min(Math.max(recordedQty, 0), Math.max(walletFree, 0));
  return roundToStepSize(capped, stepSize);
}

export interface SizingCheck {
  ok: boolean;
  adjustedQty: number;
  notional: number;
  problems: string[];
}

/** Validates an intended order against the exchange's rules BEFORE sending it. */
export function checkOrderSizing(quantity: number, price: number, filters: SymbolFilters): SizingCheck {
  const problems: string[] = [];
  const adjustedQty = roundToStepSize(quantity, filters.stepSize);
  const notional = adjustedQty * price;

  if (adjustedQty <= 0) {
    problems.push(`Quantity rounds to zero at step size ${filters.stepSize}. Increase the order size.`);
  }
  if (filters.minQty > 0 && adjustedQty < filters.minQty) {
    problems.push(`Quantity ${adjustedQty} is below the exchange minimum of ${filters.minQty}.`);
  }
  if (filters.maxQty > 0 && adjustedQty > filters.maxQty) {
    problems.push(`Quantity ${adjustedQty} exceeds the exchange maximum of ${filters.maxQty}.`);
  }
  if (filters.minNotional > 0 && notional < filters.minNotional) {
    problems.push(
      `Order value ${notional.toFixed(2)} ${filters.quoteAsset} is below the ${filters.minNotional} minimum. ` +
        `At ${price.toFixed(2)}, you need at least ${(filters.minNotional / price).toFixed(8)} ${filters.baseAsset}.`
    );
  }
  if (adjustedQty !== quantity) {
    problems.push(`NOTE: quantity rounded ${quantity} -> ${adjustedQty} to satisfy step size ${filters.stepSize}.`);
  }

  const blocking = problems.filter((p) => !p.startsWith("NOTE:"));
  return { ok: blocking.length === 0, adjustedQty, notional, problems };
}

/**
 * Backwards-compatible alias. Every existing testnet command constructs this
 * name; it is now a thin wrapper that pins the mode to testnet, so none of
 * those call sites can ever accidentally become live by changing a default.
 */
export class BinanceTestnetClient extends BinanceSpotClient {
  constructor(creds: ExchangeCredentials) {
    super(creds, "testnet");
  }
}
