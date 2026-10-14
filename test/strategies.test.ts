import { describe, expect, it } from "vitest";

import type { ModelDecision } from "../src/model.js";
import { decideLaunchEntry, decideLaunchExit, tradesPerMinute, type LaunchMomentumSettings } from "../src/strategies/launchMomentum.js";
import { decideLlmManager } from "../src/strategies/llmManager.js";
import { decideMeanReversion, vwap, type MeanReversionSettings } from "../src/strategies/meanReversion.js";
import type { Candle, Position } from "../src/strategies/types.js";
import { BNB_POOL, ROUTED_POOL, sqrtFor } from "./fixtures.js";

const BNB = 10n ** 18n;
const NOW = Date.UTC(2026, 9, 13, 6, 0, 0);
const NOW_S = Math.floor(NOW / 1000);

/** A one-minute candle `ago` minutes back, flat at `price`, with `volume` of the quote asset. */
function candle(ago: number, price: number, volume: number, coinIsCurrency0: boolean): Candle {
  const s = sqrtFor(price, coinIsCurrency0).toString();
  return [NOW_S - ago * 60, s, s, s, s, (BigInt(Math.round(volume * 1e6)) * 10n ** 12n).toString()];
}

const mr: MeanReversionSettings = { windowMin: 60, entryPct: 5, exitPct: 5, orderWei: BNB / 100n, cooldownMin: 30 };

function position(overrides: Partial<Position> = {}): Position {
  return {
    poolId: BNB_POOL.poolId,
    coin: BNB_POOL.coin,
    strategy: "mean_reversion",
    coins: 1000n * BNB,
    costWei: BNB / 100n,
    openedAt: NOW - 3_600_000,
    peakValueWei: null,
    lastValueWei: null,
    ...overrides,
  };
}

describe("mean reversion", () => {
  // A fixture series: forty minutes around 1.00e-5, one heavy minute at 1.20e-5.
  const series = (coinIsCurrency0: boolean): Candle[] => [
    ...Array.from({ length: 40 }, (_, i) => candle(50 - i, 1e-5, 1, coinIsCurrency0)),
    candle(5, 1.2e-5, 10, coinIsCurrency0),
    // Outside the 60-minute window: ignored.
    candle(90, 5e-5, 1000, coinIsCurrency0),
  ];

  it("weights each candle's typical price by its volume, whichever side of the pool the coin is on", () => {
    for (const coinIsCurrency0 of [true, false]) {
      const average = vwap(series(coinIsCurrency0), NOW_S - 3600, coinIsCurrency0);
      // (40 × 1e-5 × 1 + 1.2e-5 × 10) / 50 = 1.04e-5
      expect(average).toBeCloseTo(1.04e-5, 12);
    }
  });

  it("has no average, and no order, when the window had no trades", () => {
    expect(vwap([candle(120, 1e-5, 1, true)], NOW_S - 3600, true)).toBeNull();
    const intent = decideMeanReversion({
      settings: mr, poolId: BNB_POOL.poolId, coin: BNB_POOL.coin, coinIsCurrency0: true, spot: 1e-6,
      candles: [], position: null, lastOrderAt: null, now: NOW,
    });
    expect(intent).toBeNull();
  });

  const decide = (spot: number, extra: Partial<Parameters<typeof decideMeanReversion>[0]> = {}) =>
    decideMeanReversion({
      settings: mr,
      poolId: ROUTED_POOL.poolId,
      coin: ROUTED_POOL.coin,
      coinIsCurrency0: false,
      spot,
      candles: series(false),
      position: null,
      lastOrderAt: null,
      now: NOW,
      ...extra,
    });

  it("buys when the price is entry_pct or more below the average", () => {
    // 5% below 1.04e-5 is 0.988e-5.
    const intent = decide(0.985e-5);
    expect(intent).toMatchObject({ side: "buy", strategy: "mean_reversion", amountWei: BNB / 100n, poolId: ROUTED_POOL.poolId });
    expect(decide(0.99e-5)).toBeNull();
  });

  it("sells the whole position when the price is exit_pct or more above the average", () => {
    const held = position({ poolId: ROUTED_POOL.poolId, coin: ROUTED_POOL.coin });
    expect(decide(1.095e-5, { position: held })).toMatchObject({ side: "sell", coins: held.coins });
    expect(decide(1.09e-5, { position: held })).toBeNull();
  });

  it("holds one position per coin: no second buy while one is open", () => {
    expect(decide(0.5e-5, { position: position({ poolId: ROUTED_POOL.poolId, coin: ROUTED_POOL.coin }) })).toBeNull();
  });

  it("leaves a position another strategy opened alone", () => {
    expect(decide(2e-5, { position: position({ strategy: "launch_momentum" }) })).toBeNull();
  });

  it("waits cooldown_min after any order on the coin", () => {
    expect(decide(0.5e-5, { lastOrderAt: NOW - 29 * 60_000 })).toBeNull();
    expect(decide(0.5e-5, { lastOrderAt: NOW - 30 * 60_000 })).not.toBeNull();
  });

  it("does nothing without a pool price", () => {
    expect(decide(Number.NaN)).toBeNull();
    expect(decideMeanReversion({ settings: mr, poolId: BNB_POOL.poolId, coin: BNB_POOL.coin, coinIsCurrency0: true, spot: null, candles: series(true), position: null, lastOrderAt: null, now: NOW })).toBeNull();
  });
});

describe("launch momentum", () => {
  const lm: LaunchMomentumSettings = {
    windowMin: 30,
    minHolders: 20,
    minTradesPerMin: 1,
    orderWei: BNB / 200n,
    trailingStopPct: 20,
    timeStopMin: 120,
  };
  const launched = NOW - 10 * 60_000;

  it("counts trades a minute since launch, the first minute as a whole one", () => {
    const times = Array.from({ length: 15 }, (_, i) => launched + i * 30_000);
    expect(tradesPerMinute(times, launched, NOW)).toBeCloseTo(1.5, 6);
    expect(tradesPerMinute([launched + 1000, launched + 2000], launched, launched + 10_000)).toBe(2);
  });

  const enter = (extra: Partial<Parameters<typeof decideLaunchEntry>[0]> = {}) =>
    decideLaunchEntry({
      settings: lm,
      poolId: BNB_POOL.poolId,
      coin: BNB_POOL.coin,
      launchedAtMs: launched,
      holders: 25,
      tradesPerMin: 1.5,
      position: null,
      alreadyEntered: false,
      now: NOW,
      ...extra,
    });

  it("enters small once holders and trades a minute both clear their thresholds inside the window", () => {
    expect(enter()).toMatchObject({ side: "buy", strategy: "launch_momentum", amountWei: BNB / 200n });
  });

  it.each([
    ["too few holders", { holders: 19 }],
    ["holders unknown", { holders: null }],
    ["too few trades", { tradesPerMin: 0.9 }],
    ["past the window", { launchedAtMs: NOW - 31 * 60_000 }],
    ["launch time unknown", { launchedAtMs: null }],
    ["already bought once", { alreadyEntered: true }],
    ["a position already open", { position: position() }],
  ])("does not enter: %s", (_why, extra) => {
    expect(enter(extra as Partial<Parameters<typeof decideLaunchEntry>[0]>)).toBeNull();
  });

  const held = position({ strategy: "launch_momentum", openedAt: NOW - 30 * 60_000, peakValueWei: BNB / 100n });

  it("tracks the peak exit value", () => {
    const up = decideLaunchExit({ settings: lm, position: held, valueWei: (BNB * 12n) / 1000n, now: NOW });
    expect(up.intent).toBeNull();
    expect(up.peakValueWei).toBe((BNB * 12n) / 1000n);
  });

  it("sells on the trailing stop: trailing_stop_pct below the peak", () => {
    // peak 0.01; 20% below is 0.008.
    expect(decideLaunchExit({ settings: lm, position: held, valueWei: (BNB * 8n) / 1000n, now: NOW }).intent).toMatchObject({
      side: "sell",
      coins: held.coins,
    });
    expect(decideLaunchExit({ settings: lm, position: held, valueWei: (BNB * 8n) / 1000n + 1n, now: NOW }).intent).toBeNull();
  });

  it("sells on the hard time stop, even when the exit value cannot be quoted", () => {
    const old = { ...held, openedAt: NOW - 120 * 60_000 };
    expect(decideLaunchExit({ settings: lm, position: old, valueWei: null, now: NOW }).intent?.reason).toMatch(/time stop/);
  });

  it("leaves a mean-reversion position alone", () => {
    expect(decideLaunchExit({ settings: lm, position: position(), valueWei: 0n, now: NOW }).intent).toBeNull();
  });
});

describe("llm manager: the model's answer, as intents", () => {
  const coins = new Map([
    [BNB_POOL.coin, { coin: BNB_POOL.coin, poolId: BNB_POOL.poolId }],
    [ROUTED_POOL.coin, { coin: ROUTED_POOL.coin, poolId: ROUTED_POOL.poolId }],
  ]);
  const decision = (overrides: Partial<ModelDecision>): ModelDecision => ({
    coin: BNB_POOL.coin,
    action: "hold",
    amountBnb: "0",
    amountWei: 0n,
    fraction: 0,
    reason: "because",
    ...overrides,
  });
  const held = position({ strategy: "llm_manager", coins: 1000n * BNB });

  it("buys what the model said, sells the share it said, holds the rest, and carries its reasons", () => {
    const { intents, skipped } = decideLlmManager({
      decisions: [
        decision({ action: "buy", amountBnb: "0.02", amountWei: BNB / 50n, reason: "entry" }),
        decision({ coin: ROUTED_POOL.coin, action: "sell", fraction: 0.25, reason: "trim" }),
      ],
      coins,
      position: (coin) => (coin === ROUTED_POOL.coin ? { ...held, coin: ROUTED_POOL.coin, poolId: ROUTED_POOL.poolId } : null),
      balanceWei: BNB,
    });
    expect(intents).toEqual([
      { side: "buy", strategy: "llm_manager", poolId: BNB_POOL.poolId, coin: BNB_POOL.coin, amountWei: BNB / 50n, reason: "entry" },
      { side: "sell", strategy: "llm_manager", poolId: ROUTED_POOL.poolId, coin: ROUTED_POOL.coin, coins: 250n * BNB, reason: "trim" },
    ]);
    expect(skipped).toEqual([]);
  });

  it("a fraction of 1 sells the whole position, to the last unit", () => {
    const odd = { ...held, coins: 1000n * BNB + 7n };
    const { intents } = decideLlmManager({ decisions: [decision({ action: "sell", fraction: 1 })], coins, position: () => odd, balanceWei: BNB });
    expect(intents[0]).toMatchObject({ side: "sell", coins: 1000n * BNB + 7n });
  });

  it("refuses, and says why: more than the wallet can spend, nothing to sell, another strategy's position, a coin not found", () => {
    const { intents, skipped } = decideLlmManager({
      decisions: [
        decision({ action: "buy", amountWei: BNB / 2n }),
        decision({ action: "buy", amountWei: BNB / 2n + 1n }),
        decision({ coin: ROUTED_POOL.coin, action: "sell", fraction: 0.5 }),
      ],
      coins,
      position: () => null,
      balanceWei: BNB,
    });
    // The first buy fits; the second does not fit beside it.
    expect(intents).toHaveLength(1);
    expect(skipped).toEqual([
      { coin: BNB_POOL.coin, action: "buy", why: "more BNB than the wallet can spend" },
      { coin: ROUTED_POOL.coin, action: "sell", why: "nothing held to sell" },
    ]);
    const theirs = decideLlmManager({ decisions: [decision({ action: "sell", fraction: 1 })], coins, position: () => position(), balanceWei: BNB });
    expect(theirs.skipped).toEqual([{ coin: BNB_POOL.coin, action: "sell", why: "the position belongs to mean_reversion" }]);
    const lost = decideLlmManager({ decisions: [decision({ action: "buy", amountWei: 1n })], coins: new Map(), position: () => null, balanceWei: BNB });
    expect(lost.skipped).toEqual([{ coin: BNB_POOL.coin, action: "buy", why: "the coin's pool has not been found" }]);
  });
});
