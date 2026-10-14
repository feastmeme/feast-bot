/**
 * What a strategy may do: look at numbers and propose an order.
 *
 * A strategy is a pure function. It is handed market data, the position it
 * holds (if any) and the clock, and it returns an `Intent` or null. It never
 * sees the trader, the wallet or the risk module, so it cannot send anything
 * and cannot skip a limit: every intent goes through `risk.ts` before it can
 * become a transaction.
 */

import type { Hex } from "../book.js";

export type StrategyName = "mean_reversion" | "launch_momentum";

export type Intent =
  | { side: "buy"; strategy: StrategyName; poolId: Hex; coin: Hex; amountWei: bigint; reason: string }
  | { side: "sell"; strategy: StrategyName; poolId: Hex; coin: Hex; coins: bigint; reason: string };

/** An open position, as the bot recorded it. */
export type Position = {
  poolId: Hex;
  coin: Hex;
  strategy: StrategyName;
  /** Coins held, in base units. */
  coins: bigint;
  /** BNB spent on it, in wei, gas included when live. */
  costWei: bigint;
  /** When it was opened, ms since the epoch. */
  openedAt: number;
  /** The highest exit value seen since it was opened, in wei. */
  peakValueWei: bigint | null;
  /** The latest exit value: what selling the whole position would bring now, in wei. */
  lastValueWei: bigint | null;
};

/** One candle as the public API serves it: `[ts, open, high, low, close, volume]`, prices as sqrtPriceX96. */
export type Candle = readonly [number, string, string, string, string, string];
