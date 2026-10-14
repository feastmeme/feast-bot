/**
 * LLM MANAGER: a language model decides, this function only translates.
 *
 * The advisor (`advisor.ts`) shows Claude Haiku 5.5 a packet of numbers about
 * the coins the owner listed and gets back, per coin, buy (an amount of BNB),
 * sell (a fraction of the position) or hold, each with a reason. This function
 * turns that checked answer into intents, and does nothing else: like every
 * strategy it is pure, it cannot send, and every intent it returns goes
 * through `risk.ts`.
 *
 * What it refuses, and says why: a buy larger than the BNB the wallet can
 * spend; a sale with nothing held; a coin whose position another strategy
 * opened (that strategy's to close); a coin the advisor has not found.
 */

import type { Hex } from "../book.js";
import type { ModelDecision } from "../model.js";
import type { Intent, Position } from "./types.js";

/** Fractions are taken to a millionth of the position. */
const FRACTION_SCALE = 1_000_000n;

export type Skipped = { coin: Hex; action: ModelDecision["action"]; why: string };

export function decideLlmManager(input: {
  decisions: readonly ModelDecision[];
  /** The configured coins the advisor found, by coin address. */
  coins: ReadonlyMap<Hex, { coin: Hex; poolId: Hex }>;
  position: (coin: Hex) => Position | null;
  /** What the wallet may spend: its balance live, the session's paper BNB in a dry run; null when unknown. */
  balanceWei: bigint | null;
}): { intents: Intent[]; skipped: Skipped[] } {
  const intents: Intent[] = [];
  const skipped: Skipped[] = [];
  let spendable = input.balanceWei;
  for (const decision of input.decisions) {
    if (decision.action === "hold") continue;
    const target = input.coins.get(decision.coin);
    const skip = (why: string) => skipped.push({ coin: decision.coin, action: decision.action, why });
    if (!target) {
      skip("the coin's pool has not been found");
      continue;
    }
    const position = input.position(decision.coin);
    if (position && position.strategy !== "llm_manager") {
      skip(`the position belongs to ${position.strategy}`);
      continue;
    }
    if (decision.action === "buy") {
      if (spendable !== null && decision.amountWei > spendable) {
        skip("more BNB than the wallet can spend");
        continue;
      }
      if (spendable !== null) spendable -= decision.amountWei;
      intents.push({ side: "buy", strategy: "llm_manager", poolId: target.poolId, coin: target.coin, amountWei: decision.amountWei, reason: decision.reason });
      continue;
    }
    if (!position || position.coins <= 0n) {
      skip("nothing held to sell");
      continue;
    }
    const share = BigInt(Math.round(decision.fraction * Number(FRACTION_SCALE)));
    const coins = share >= FRACTION_SCALE ? position.coins : (position.coins * share) / FRACTION_SCALE;
    if (coins <= 0n) {
      skip("the fraction rounds to nothing");
      continue;
    }
    intents.push({ side: "sell", strategy: "llm_manager", poolId: target.poolId, coin: target.coin, coins, reason: decision.reason });
  }
  return { intents, skipped };
}
