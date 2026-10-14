/**
 * THE PACKET: everything the model is shown, and it is NUMBERS ONLY.
 *
 * The owner's rule: the model sees trading figures and nothing else — no coin
 * name, no symbol, no description, no link, nothing anyone wrote. So every
 * field here is picked by name from a figure the API or the chain served
 * (nothing is spread from an API object), and the only strings the packet
 * may carry are hex addresses and ids, and UTC timestamps.
 * `assertNumbersOnly` checks exactly that, on the whole packet, before every
 * call: a field that slipped in would stop the call, not reach the model.
 *
 * Amounts are whole BNB (or whole coins) as JSON numbers, rounded to six
 * significant figures: the model reads them, nothing pays them. What the model
 * answers comes back through `parseAnswer` as exact decimals.
 */

import { createHash } from "node:crypto";

import type { Hex } from "./book.js";
import type { ApiTrade } from "./feast.js";
import type { Candle } from "./strategies/types.js";
import { DECIMALS, priceFromSqrt } from "./units.js";

/** The windows the packet reports over, in minutes. */
export const PRICE_WINDOWS = [1, 5, 15, 60] as const;
export const TRADE_WINDOWS = [15, 60] as const;

type ByWindow<W extends readonly number[]> = { [K in W[number] as `${K}m`]: number | null };

export type TradeFigures = {
  count: number;
  perMin: number;
  buys: number;
  sells: number;
  uniqueBuyers: number;
  buyBnb: number;
  sellBnb: number;
  /** buyBnb ÷ sellBnb; null with no sales. */
  buySellRatio: number | null;
};

export type CoinPacket = {
  coin: Hex;
  poolId: Hex;
  creator: Hex | null;
  createdAt: string | null;
  poolAgeMin: number | null;
  priceBnb: number | null;
  priceChangePct: ByWindow<typeof PRICE_WINDOWS>;
  volumeBnb: ByWindow<typeof PRICE_WINDOWS>;
  /** Null while the pool's trade history is still being read. */
  trades: { "15m": TradeFigures; "60m": TradeFigures } | null;
  holders: number | null;
  holdersChange: ByWindow<typeof TRADE_WINDOWS>;
  lastTradeAt: string | null;
  openingCapBinding: boolean;
  /** Present only when the API gave the creator's other coins as numbers. */
  creatorPriorCoins?: { count: number; coins: Array<{ coin: Hex; holders: number; trades: number }> };
  position: {
    coins: number;
    costBnb: number;
    valueBnb: number | null;
    unrealizedBnb: number | null;
    realizedBnb: number;
    openedAt: string;
    minutesHeld: number;
  } | null;
  lastOrderAt: string | null;
  minutesSinceLastOrder: number | null;
};

export type AccountPacket = {
  wallet: Hex;
  bnbBalance: number | null;
  equityBnb: number;
  startEquityBnb: number;
  sessionStartedAt: string;
  realizedBnb: number;
  unrealizedBnb: number;
  maxTotalLossBnb: number;
  lossBudgetLeftBnb: number;
  lastActionAt: string | null;
  minutesSinceLastAction: number | null;
};

export type Packet = {
  at: string;
  early: boolean;
  minutesSinceLastPass: number | null;
  account: AccountPacket;
  coins: CoinPacket[];
};

// ── The guard ──────────────────────────────────────────────────────────────

const HEX = /^0x[0-9a-f]+$/i;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export class PacketError extends Error {
  override name = "PacketError";
}

/**
 * Throws unless every string in `value`, at any depth, is a hex address or
 * id, or a UTC timestamp; and unless every number is finite. Says where the
 * offending field is, never what it held.
 */
export function assertNumbersOnly(value: unknown, path = "packet"): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PacketError(`${path} is not a finite number`);
    return;
  }
  if (typeof value === "string") {
    if (!HEX.test(value) && !UTC_TIME.test(value)) throw new PacketError(`${path} is a string that is neither hex nor a UTC timestamp`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNumbersOnly(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) assertNumbersOnly(inner, `${path}.${key}`);
    return;
  }
  throw new PacketError(`${path} is a ${typeof value}`);
}

/** The packet as sent: checked, then serialized once, so the hash is of the very bytes the model read. */
export function serializePacket(packet: Packet): { json: string; hash: string } {
  assertNumbersOnly(packet);
  const json = JSON.stringify(packet);
  return { json, hash: createHash("sha256").update(json).digest("hex") };
}

// ── Figures ────────────────────────────────────────────────────────────────

/** Six significant figures: enough to decide on, short enough to read. */
export function sig(value: number): number {
  if (!Number.isFinite(value) || value === 0) return Number.isFinite(value) ? value : 0;
  return Number(value.toPrecision(6));
}

/** Base units → whole units, as a float. Display only. */
export function whole(units: bigint, decimals = DECIMALS): number {
  const scale = 10n ** BigInt(decimals);
  const integer = units / scale;
  const fraction = units % scale;
  return Number(integer) + Number(fraction) / Number(scale);
}

export function minutesBetween(fromMs: number, toMs: number): number {
  return Math.round(((toMs - fromMs) / 60_000) * 10) / 10;
}

/**
 * The price at `atSec`, quote per coin: the close of the last one-minute
 * candle that began at or before it. With no candle in the window at all the
 * pool did not trade, and the price then is the price now. Null when the
 * window has candles but none before `atSec` (the price then is not in it), or
 * when the pool did not exist yet.
 */
export function priceAt(candles: readonly Candle[], atSec: number, coinIsCurrency0: boolean, spot: number, createdAtSec: number | null): number | null {
  if (createdAtSec !== null && createdAtSec > atSec) return null;
  if (candles.length === 0) return spot;
  let found: Candle | null = null;
  for (const candle of candles) if (candle[0] <= atSec && (found === null || candle[0] > found[0])) found = candle;
  if (!found) return null;
  const price = priceFromSqrt(found[4], coinIsCurrency0);
  return price > 0 ? price : null;
}

/** Percent change from the price `minutes` ago to `spot`, per window. */
export function priceChanges(input: {
  candles: readonly Candle[];
  nowSec: number;
  coinIsCurrency0: boolean;
  spot: number | null;
  createdAtSec: number | null;
}): ByWindow<typeof PRICE_WINDOWS> {
  const out = {} as ByWindow<typeof PRICE_WINDOWS>;
  for (const minutes of PRICE_WINDOWS) {
    const then = input.spot === null ? null : priceAt(input.candles, input.nowSec - minutes * 60, input.coinIsCurrency0, input.spot, input.createdAtSec);
    out[`${minutes}m`] = input.spot === null || then === null ? null : sig(((input.spot - then) / then) * 100);
  }
  return out;
}

/** Quote-asset volume of the candles that began inside each window, in BNB at `bnbPerQuote`. */
export function volumes(input: { candles: readonly Candle[]; nowSec: number; quoteDecimals: number; bnbPerQuote: number | null }): ByWindow<typeof PRICE_WINDOWS> {
  const out = {} as ByWindow<typeof PRICE_WINDOWS>;
  for (const minutes of PRICE_WINDOWS) {
    if (input.bnbPerQuote === null) {
      out[`${minutes}m`] = null;
      continue;
    }
    let units = 0n;
    for (const candle of input.candles) if (candle[0] >= input.nowSec - minutes * 60) units += BigInt(candle[5]);
    out[`${minutes}m`] = sig(whole(units, input.quoteDecimals) * input.bnbPerQuote);
  }
  return out;
}

/** Counts and BNB over the trades of the last `minutes`. */
export function tradeFigures(input: { trades: readonly ApiTrade[]; nowMs: number; minutes: number; quoteDecimals: number; bnbPerQuote: number }): TradeFigures {
  const from = input.nowMs - input.minutes * 60_000;
  let buys = 0;
  let sells = 0;
  let buyUnits = 0n;
  let sellUnits = 0n;
  const buyers = new Set<string>();
  for (const trade of input.trades) {
    const at = Date.parse(trade.at);
    if (!(at >= from && at <= input.nowMs)) continue;
    if (trade.side === "buy") {
      buys += 1;
      buyUnits += BigInt(trade.quoteAmount);
      if (trade.payer) buyers.add(trade.payer.toLowerCase());
    } else {
      sells += 1;
      sellUnits += BigInt(trade.quoteAmount);
    }
  }
  const buyBnb = whole(buyUnits, input.quoteDecimals) * input.bnbPerQuote;
  const sellBnb = whole(sellUnits, input.quoteDecimals) * input.bnbPerQuote;
  return {
    count: buys + sells,
    perMin: sig((buys + sells) / input.minutes),
    buys,
    sells,
    uniqueBuyers: buyers.size,
    buyBnb: sig(buyBnb),
    sellBnb: sig(sellBnb),
    buySellRatio: sellBnb > 0 ? sig(buyBnb / sellBnb) : null,
  };
}

/**
 * The change in holders over each window, from samples taken as the loop
 * reads them: the sample nearest the window's start, if one lies within a
 * minute of it. Otherwise null — a change measured over some other span is
 * not the change over this one.
 */
export function holderChanges(samples: ReadonlyArray<{ at: number; holders: number }>, nowMs: number, holders: number | null): ByWindow<typeof TRADE_WINDOWS> {
  const out = {} as ByWindow<typeof TRADE_WINDOWS>;
  for (const minutes of TRADE_WINDOWS) {
    const target = nowMs - minutes * 60_000;
    let best: { at: number; holders: number } | null = null;
    for (const sample of samples) {
      if (Math.abs(sample.at - target) <= 60_000 && (best === null || Math.abs(sample.at - target) < Math.abs(best.at - target))) best = sample;
    }
    out[`${minutes}m`] = holders === null || best === null ? null : holders - best.holders;
  }
  return out;
}
