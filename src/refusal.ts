/**
 * Why the chain refused, by name.
 *
 * The venue wraps refusals: one inside `execute` comes back as the router's
 * `ExecutionFailed(index, message)`, one while quoting as the quoter's
 * `UnexpectedRevertBytes(bytes)`, and a hook's refusal inside either as the
 * pool manager's `WrappedError(target, selector, reason, details)`. This opens
 * the envelopes down to the error that actually refused — the way the Feast
 * site's `infinity-refusal.ts` does — so a log says `PurchaseCapExceeded`
 * rather than `UnexpectedRevertBytes`.
 */

import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from "viem";

import { ERRORS } from "./abi.js";

const ERROR_STRING = "0x08c379a0";
const ENVELOPES: Record<string, number> = { ExecutionFailed: 1, UnexpectedRevertBytes: 0, WrappedError: 2 };

/** The innermost error's name, or the text an `Error(string)` carried, or null. */
export function innermostRefusal(raw: Hex | undefined, depth = 0): string | null {
  if (!raw || raw.length < 10 || depth > 4) return null;
  if (raw.slice(0, 10).toLowerCase() === ERROR_STRING) {
    try {
      const decoded = decodeErrorResult({ abi: [], data: raw });
      return typeof decoded.args?.[0] === "string" ? decoded.args[0] : null;
    } catch {
      return null;
    }
  }
  try {
    const { errorName, args } = decodeErrorResult({ abi: ERRORS, data: raw });
    const slot = ENVELOPES[errorName];
    if (slot === undefined) return errorName;
    return innermostRefusal((args as readonly unknown[] | undefined)?.[slot] as Hex | undefined, depth + 1) ?? errorName;
  } catch {
    return null;
  }
}

/** The revert's name from any viem error, or null when it was not a revert. */
export function refusalName(error: unknown): string | null {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      return innermostRefusal(reverted.raw) ?? reverted.data?.errorName ?? reverted.reason ?? null;
    }
    // A raw call or gas estimate carries the revert bytes on a nested `data`.
    let raw: Hex | undefined;
    error.walk((e) => {
      const data = (e as { data?: unknown }).data;
      if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)) raw = data as Hex;
      return false;
    });
    if (raw) return innermostRefusal(raw);
  }
  return null;
}

/** What a refusal means for the bot, in one short line. */
export const REFUSAL_HINTS: Record<string, string> = {
  PurchaseCapExceeded: "the pool's opening cap: in its first two trading blocks a wallet may buy only up to the per-wallet cap",
  PoolNotOpenYet: "the pool has not opened for trading yet",
  TooLittleReceived: "the price moved past the slippage floor",
  V3TooLittleReceived: "the price moved past the slippage floor",
  InsufficientETH: "the price moved past the slippage floor",
  NotEnoughLiquidity: "the pool cannot fill this size",
  TransactionDeadlinePassed: "the deadline passed before the transaction landed",
  InsufficientAllowance: "Permit2 is not allowed to move this coin yet",
  TRANSFER_FROM_FAILED: "the wallet does not hold or has not approved the coin",
};
