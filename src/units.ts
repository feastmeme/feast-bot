/**
 * Amounts. Everything that is money stays a bigint of base units (wei for
 * BNB; the coin's 18 decimals for a coin). Floats appear only for prices and
 * percentages, where a strategy compares two figures and rounding cannot move
 * a wei.
 */

import { formatUnits, parseUnits } from "viem";

/** Every Feast coin, and BNB, has 18 decimals. */
export const DECIMALS = 18;

/** "0.01" (or 0.01) → wei. Refuses exponent notation, negatives and more than 18 decimals. */
export function parseAmount(value: string | number): bigint {
  const text = typeof value === "number" ? String(value) : value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`not a plain decimal amount: ${JSON.stringify(text)}`);
  const decimals = text.split(".")[1]?.length ?? 0;
  if (decimals > DECIMALS) throw new Error(`more than ${DECIMALS} decimals: ${JSON.stringify(text)}`);
  return parseUnits(text, DECIMALS);
}

/** wei → "0.01". Exact: no rounding. */
export function formatAmount(units: bigint): string {
  return formatUnits(units, DECIMALS);
}

/** `units × bps / 10_000`, floored. */
export function bpsOf(units: bigint, bps: number): bigint {
  return (units * BigInt(Math.round(bps))) / 10_000n;
}

/** `Q96`, the fixed-point base of every `sqrtPriceX96`. */
const Q96 = 2 ** 96;

/**
 * A pool's price in quote asset per coin, from a `sqrtPriceX96`.
 *
 * The pool prices currency1 in currency0; a coin can sit on either side (the
 * lower address is currency0), so the orientation is read from the pool key,
 * never assumed. A float is fine here: it is compared, never paid.
 */
export function priceFromSqrt(sqrtPriceX96: bigint | string, coinIsCurrency0: boolean): number {
  const s = Number(BigInt(sqrtPriceX96)) / Q96;
  const p = s * s;
  if (!(p > 0) || !Number.isFinite(p)) return 0;
  return coinIsCurrency0 ? p : 1 / p;
}

/** A base-unit figure as a float, for weights and ratios only. */
export function asFloat(units: bigint | string): number {
  return Number(BigInt(units)) / 10 ** DECIMALS;
}
