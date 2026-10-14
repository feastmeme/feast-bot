import { describe, expect, it } from "vitest";

import type { ApiTrade } from "../src/feast.js";
import { holderChanges, priceAt, priceChanges, serializePacket, sig, tradeFigures, volumes, whole, type Packet } from "../src/packet.js";
import type { Candle } from "../src/strategies/types.js";
import { sqrtFor } from "./fixtures.js";

const NOW_S = 1_791_964_800;
const NOW = NOW_S * 1000;

function candle(agoMin: number, price: number, volume = "100000000000000000"): Candle {
  const s = sqrtFor(price, true).toString();
  return [NOW_S - agoMin * 60, s, s, s, s, volume];
}

describe("packet figures", () => {
  it("the price then is the last candle's close at or before then", () => {
    const candles = [candle(70, 0.5e-6), candle(30, 0.8e-6), candle(3, 1e-6)];
    expect(priceAt(candles, NOW_S - 15 * 60, true, 1e-6, null)).toBeCloseTo(0.8e-6, 12);
    expect(priceAt(candles, NOW_S - 60 * 60, true, 1e-6, null)).toBeCloseTo(0.5e-6, 12);
  });

  it("no candle at all in the window: the pool did not trade, so the price then is the price now", () => {
    expect(priceChanges({ candles: [], nowSec: NOW_S, coinIsCurrency0: true, spot: 2e-6, createdAtSec: null })).toEqual({ "1m": 0, "5m": 0, "15m": 0, "60m": 0 });
  });

  it("not known: before the pool existed, before the window's first candle, or with no price now", () => {
    const candles = [candle(10, 1e-6)];
    expect(priceChanges({ candles, nowSec: NOW_S, coinIsCurrency0: true, spot: 1e-6, createdAtSec: NOW_S - 20 * 60 })).toEqual({ "1m": 0, "5m": 0, "15m": null, "60m": null });
    expect(priceChanges({ candles, nowSec: NOW_S, coinIsCurrency0: true, spot: null, createdAtSec: null })).toEqual({ "1m": null, "5m": null, "15m": null, "60m": null });
  });

  it("volume counts the candles that began inside each window, in BNB", () => {
    const candles = [candle(70, 1e-6), candle(30, 1e-6), candle(10, 1e-6), candle(0, 1e-6, "50000000000000000")];
    expect(volumes({ candles, nowSec: NOW_S, quoteDecimals: 18, bnbPerQuote: 2 })).toEqual({ "1m": 0.1, "5m": 0.1, "15m": 0.3, "60m": 0.5 });
    expect(volumes({ candles, nowSec: NOW_S, quoteDecimals: 18, bnbPerQuote: null })).toEqual({ "1m": null, "5m": null, "15m": null, "60m": null });
    // A six-decimal quote asset.
    expect(volumes({ candles: [candle(0, 1e-6, "2500000")], nowSec: NOW_S, quoteDecimals: 6, bnbPerQuote: 0.001 })["1m"]).toBe(0.0025);
  });

  it("trades: counts, sides, distinct buying wallets and BNB, inside the window only", () => {
    const t = (agoMin: number, side: "buy" | "sell", payer: string, quote: string): ApiTrade => ({
      cursor: "c",
      at: new Date(NOW - agoMin * 60_000).toISOString(),
      blockNumber: 1,
      txHash: "0x01",
      side,
      payer: payer as ApiTrade["payer"],
      coinAmount: "1",
      quoteAmount: quote,
      sqrtPriceX96After: "1",
    });
    const trades = [t(61, "buy", "0xa", "9000000000000000000"), t(10, "buy", "0xA", "100000000000000000"), t(5, "buy", "0xa", "100000000000000000"), t(1, "sell", "0xb", "50000000000000000")];
    expect(tradeFigures({ trades, nowMs: NOW, minutes: 60, quoteDecimals: 18, bnbPerQuote: 1 })).toEqual({
      count: 3,
      perMin: 0.05,
      buys: 2,
      sells: 1,
      uniqueBuyers: 1,
      buyBnb: 0.2,
      sellBnb: 0.05,
      buySellRatio: 4,
    });
    expect(tradeFigures({ trades: [trades[1]!], nowMs: NOW, minutes: 15, quoteDecimals: 18, bnbPerQuote: 1 }).buySellRatio).toBeNull();
  });

  it("holders: the change since the sample taken at each window's start, null without one that old", () => {
    const samples = [
      { at: NOW - 61 * 60_000, holders: 10 },
      { at: NOW - 15 * 60_000, holders: 30 },
      { at: NOW - 60_000, holders: 39 },
    ];
    expect(holderChanges(samples, NOW, 40)).toEqual({ "15m": 10, "60m": 30 });
    expect(holderChanges(samples.slice(2), NOW, 40)).toEqual({ "15m": null, "60m": null });
    expect(holderChanges(samples, NOW, null)).toEqual({ "15m": null, "60m": null });
    // A sample five minutes off the window's start measures some other span: not reported as this one.
    expect(holderChanges([{ at: NOW - 20 * 60_000, holders: 5 }], NOW, 40)).toEqual({ "15m": null, "60m": null });
  });

  it("numbers are rounded to six significant figures, and base units read exactly", () => {
    expect(sig(0.123456789)).toBe(0.123457);
    expect(sig(1.23456789e-9)).toBe(1.23457e-9);
    expect(whole(1_234_567_890_123_456_789n)).toBeCloseTo(1.234567890123456789, 15);
    expect(whole(2_500_000n, 6)).toBe(2.5);
  });

  it("the hash is of the very bytes sent", () => {
    const packet = { at: "2026-10-14T08:00:00.000Z", early: false, minutesSinceLastPass: null, account: {}, coins: [] } as unknown as Packet;
    const { json, hash } = serializePacket(packet);
    expect(json).toBe('{"at":"2026-10-14T08:00:00.000Z","early":false,"minutesSinceLastPass":null,"account":{},"coins":[]}');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => serializePacket({ ...packet, note: "buy" } as unknown as Packet)).toThrow(/packet\.note is a string/);
  });
});
