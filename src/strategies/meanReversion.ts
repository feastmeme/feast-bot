/**
 * MEAN REVERSION, per pool.
 *
 * The pool's volume-weighted average price over the last `window_min` minutes
 * is the reference. When the pool's price now is `entry_pct` below it, buy
 * `order_bnb`; when the price is `exit_pct` above it, sell the whole position.
 * One open position per coin, and at least `cooldown_min` minutes between two
 * orders on the same coin.
 *
 * The average comes from the public API's one-minute candles. Each candle's
 * typical price — (high + low + close) / 3 — is weighted by the candle's
 * quote-asset volume. Candles exist only for minutes with trades, so a quiet
 * pool has few of them, and a window with no trades at all has no average and
 * produces no order.
 */

import type { Hex } from "../book.js";
import { asFloat, priceFromSqrt } from "../units.js";
import type { Candle, Intent, Position } from "./types.js";

export type MeanReversionSettings = {
  windowMin: number;
  entryPct: number;
  exitPct: number;
  orderWei: bigint;
  cooldownMin: number;
};

/**
 * The volume-weighted average price, in quote asset per coin, over candles
 * that start at or after `fromSec`. Null when there was no volume.
 */
export function vwap(candles: readonly Candle[], fromSec: number, coinIsCurrency0: boolean): number | null {
  let weighted = 0;
  let volume = 0;
  for (const [ts, , high, low, close, vol] of candles) {
    if (ts < fromSec) continue;
    const v = asFloat(vol);
    if (!(v > 0)) continue;
    const typical =
      (priceFromSqrt(high, coinIsCurrency0) + priceFromSqrt(low, coinIsCurrency0) + priceFromSqrt(close, coinIsCurrency0)) / 3;
    if (!(typical > 0)) continue;
    weighted += typical * v;
    volume += v;
  }
  return volume > 0 ? weighted / volume : null;
}

export function decideMeanReversion(input: {
  settings: MeanReversionSettings;
  poolId: Hex;
  coin: Hex;
  coinIsCurrency0: boolean;
  /** The pool's price now, quote asset per coin, from the chain. */
  spot: number | null;
  candles: readonly Candle[];
  /** Whatever position the bot holds in this coin, from either strategy. */
  position: Position | null;
  /** The last order on this coin, ms. */
  lastOrderAt: number | null;
  now: number;
}): Intent | null {
  const { settings, position, spot, now } = input;
  // Another strategy's position is that strategy's to close.
  if (position && position.strategy !== "mean_reversion") return null;
  if (input.lastOrderAt !== null && now - input.lastOrderAt < settings.cooldownMin * 60_000) return null;
  if (spot === null || !(spot > 0)) return null;

  const average = vwap(input.candles, Math.floor(now / 1000) - settings.windowMin * 60, input.coinIsCurrency0);
  if (average === null) return null;
  const gapPct = ((spot - average) / average) * 100;

  if (position) {
    if (gapPct >= settings.exitPct && position.coins > 0n) {
      return {
        side: "sell",
        strategy: "mean_reversion",
        poolId: input.poolId,
        coin: input.coin,
        coins: position.coins,
        reason: `price ${round2(gapPct)}% above its ${settings.windowMin}-minute average (exit at ${settings.exitPct}%)`,
      };
    }
    return null;
  }
  if (-gapPct >= settings.entryPct) {
    return {
      side: "buy",
      strategy: "mean_reversion",
      poolId: input.poolId,
      coin: input.coin,
      amountWei: settings.orderWei,
      reason: `price ${round2(-gapPct)}% below its ${settings.windowMin}-minute average (entry at ${settings.entryPct}%)`,
    };
  }
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
