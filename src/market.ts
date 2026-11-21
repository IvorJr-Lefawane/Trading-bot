// Real market data only. No generated/fixture candles, ever.
// Uses Binance's PUBLIC klines endpoint — no API key required, read-only.

import { Candle } from "./types";
import { assertReadOnlyEndpoint } from "./guardrails";

const BASE_URL = "https://api.binance.com/api/v3/klines";

interface BinanceKline extends Array<string | number> {}

function parseKline(k: BinanceKline): Candle {
  return {
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Number(k[6]),
  };
}

/**
 * Fetch a single page of real candles from Binance (max 1000 per call).
 * Throws clearly if the request fails — never falls back to fake data.
 */
export async function fetchCandles(
  symbol: string,
  interval: string,
  limit: number,
  endTime?: number
): Promise<Candle[]> {
  const params = new URLSearchParams({
    symbol: symbol.toUpperCase(),
    interval,
    limit: String(Math.min(limit, 1000)),
  });
  if (endTime !== undefined) params.set("endTime", String(endTime));

  const url = `${BASE_URL}?${params.toString()}`;
  assertReadOnlyEndpoint(url); // hard stop if this is ever anything but a public market-data endpoint

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(
      `Could not reach Binance public API (${url}). This machine's network must be able to reach api.binance.com. Underlying error: ${
        (err as Error).message
      }`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Binance API returned ${res.status} ${res.statusText} for ${url}. Body: ${body}`
    );
  }

  const raw = (await res.json()) as BinanceKline[];
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected response shape from Binance klines endpoint: ${JSON.stringify(raw)}`);
  }
  return raw.map(parseKline);
}

/**
 * Fetch `totalCount` real historical candles by paging backward through
 * Binance's klines endpoint (max 1000 per request). Returns candles sorted
 * ascending by openTime. Small delay between pages to be a polite API citizen.
 */
export async function fetchHistoricalCandles(
  symbol: string,
  interval: string,
  totalCount: number,
  endingAt?: number
): Promise<Candle[]> {
  let candles: Candle[] = [];
  let endTime: number | undefined = endingAt;

  while (candles.length < totalCount) {
    const remaining = totalCount - candles.length;
    const batch = await fetchCandles(symbol, interval, Math.min(1000, remaining), endTime);
    if (batch.length === 0) break;

    candles = [...batch, ...candles];
    endTime = batch[0].openTime - 1;

    if (batch.length < Math.min(1000, remaining)) break; // exhausted available history
    await new Promise((r) => setTimeout(r, 300)); // be polite to the public endpoint
  }

  // Trim in case we overshot on the first page
  if (candles.length > totalCount) {
    candles = candles.slice(candles.length - totalCount);
  }
  return candles;
}
