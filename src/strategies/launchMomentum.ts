/**
 * LAUNCH MOMENTUM.
 *
 * The bot watches pools opened in the last `window_min` minutes. When a new
 * pool has at least `min_holders` holders and at least `min_trades_per_min`
 * trades a minute since it opened, the bot buys `order_bnb` once. It sells
 * the whole position when its exit value falls `trailing_stop_pct` below the
 * highest exit value seen since the buy, or when `time_stop_min` minutes have
 * passed, whichever comes first.
 *
 * "Exit value" is what selling the whole position would bring right now, as
 * the chain's own quoter simulates it — fees and price impact included — not
 * a price times a quantity.
 */

import type { Hex } from "../book.js";
import type { Intent, Position } from "./types.js";

export type LaunchMomentumSettings = {
  windowMin: number;
  minHolders: number;
  minTradesPerMin: number;
  orderWei: bigint;
  trailingStopPct: number;
  timeStopMin: number;
};

/** Trades a minute since launch, counting the first minute as a whole one. */
export function tradesPerMinute(tradeTimesMs: readonly number[], launchedAtMs: number, now: number): number {
  const count = tradeTimesMs.filter((at) => at >= launchedAtMs && at <= now).length;
  const minutes = Math.max(1, (now - launchedAtMs) / 60_000);
  return count / minutes;
}

/** Whether to enter a new pool. */
export function decideLaunchEntry(input: {
  settings: LaunchMomentumSettings;
  poolId: Hex;
  coin: Hex;
  launchedAtMs: number | null;
  holders: number | null;
  tradesPerMin: number | null;
  /** Any position the bot holds in this coin. */
  position: Position | null;
  /** Whether this strategy has already bought this pool once. */
  alreadyEntered: boolean;
  now: number;
}): Intent | null {
  const { settings, now } = input;
  if (input.position || input.alreadyEntered) return null;
  if (input.launchedAtMs === null) return null;
  const ageMin = (now - input.launchedAtMs) / 60_000;
  if (ageMin < 0 || ageMin > settings.windowMin) return null;
  if (input.holders === null || input.holders < settings.minHolders) return null;
  if (input.tradesPerMin === null || input.tradesPerMin < settings.minTradesPerMin) return null;
  return {
    side: "buy",
    strategy: "launch_momentum",
    poolId: input.poolId,
    coin: input.coin,
    amountWei: settings.orderWei,
    reason: `${Math.floor(ageMin)} min after launch: ${input.holders} holders, ${Math.round(input.tradesPerMin * 100) / 100} trades a minute`,
  };
}

/**
 * Whether to close a position this strategy opened, given its exit value now.
 * Returns the intent (or null) and the peak to remember.
 */
export function decideLaunchExit(input: {
  settings: LaunchMomentumSettings;
  position: Position;
  /** What selling the whole position would bring now, in wei; null when it could not be quoted. */
  valueWei: bigint | null;
  now: number;
}): { intent: Intent | null; peakValueWei: bigint | null } {
  const { settings, position, valueWei, now } = input;
  if (position.strategy !== "launch_momentum") return { intent: null, peakValueWei: position.peakValueWei };

  const peak =
    valueWei === null
      ? position.peakValueWei
      : position.peakValueWei === null || valueWei > position.peakValueWei
        ? valueWei
        : position.peakValueWei;

  const sell = (reason: string): Intent => ({
    side: "sell",
    strategy: "launch_momentum",
    poolId: position.poolId,
    coin: position.coin,
    coins: position.coins,
    reason,
  });

  // The time stop needs no quote: it fires on the clock alone.
  if (now - position.openedAt >= settings.timeStopMin * 60_000) {
    return { intent: sell(`time stop: held ${settings.timeStopMin} minutes`), peakValueWei: peak };
  }
  if (valueWei !== null && peak !== null && peak > 0n) {
    // value ≤ peak × (1 − pct/100), in integer arithmetic on basis points.
    const floor = (peak * BigInt(10_000 - Math.round(settings.trailingStopPct * 100))) / 10_000n;
    if (valueWei <= floor) {
      return { intent: sell(`trailing stop: exit value ${settings.trailingStopPct}% or more below its peak`), peakValueWei: peak };
    }
  }
  return { intent: null, peakValueWei: peak };
}
