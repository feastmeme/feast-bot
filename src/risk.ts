/**
 * THE RISK GATE: every limit, in one place, and nothing reaches the chain
 * without passing it.
 *
 * `check(plan, view)` runs every rule against a fully quoted order and
 * returns either the first rule that blocks it or an APPROVAL. The trader
 * sends only on an approval, and only this module can mint one: approvals are
 * remembered here in a private WeakMap, so an object that merely looks like
 * one is refused. An approval is good for one order, for one minute, and is
 * re-checked against the STOP file at the moment it is redeemed — right
 * before anything is broadcast.
 *
 * Strategies never see this module or the trader; they only propose. So a
 * strategy cannot skip a limit, and neither can a bug in one.
 *
 * The rules, in the order they are checked:
 *   stop_file            a file named `[bot] stop_file` exists: no orders at all
 *   max_total_loss       (buys) the session is `max_total_loss_bnb` down; the
 *                        engine stops the bot at that point too, so this is the
 *                        second line, not the first
 *   max_orders_per_hour  (buys) orders in the last 60 minutes, buys and sales together
 *   min_cooldown         (buys) seconds since the last order on the same coin
 *   max_slippage         (buys) the expected slippage against the pool's price
 *   max_position         (buys) BNB in this coin after the order
 *   daily_loss_cap       (buys) today's realized result plus open positions' paper loss
 *   gas_reserve          (buys, when the balance is known) BNB left for gas
 *
 * A SALE IS HELD TO THE STOP FILE ALONE. It closes a position the bot already
 * holds, so no limit may trap it there: a stop that fires into a thin pool, or
 * in an hour that already had its orders, must still be able to get out. Sales
 * cannot run away on their own — each needs a position, and every position
 * began with a buy that passed every rule — and each still carries its floor,
 * `max_slippage_bps` below the quote, so the chain reverts one the price ran
 * away from between quote and block.
 *
 * THE MODEL'S ORDERS (`llm_manager`) answer to the stop file and the
 * total-loss stop ALONE while `[risk] only_total_loss` is true, which is its
 * default: that is the owner's design for the strategy, and the README puts
 * it in a warning of its own. Every other strategy keeps every rule. A model's buy with no
 * session to measure against is refused outright. Its transactions still carry
 * the floor `max_slippage_bps` below the quote: that is the trader's, not a rule.
 */

import { existsSync } from "node:fs";

import type { Config } from "./config.js";
import type { Plan } from "./trade.js";
import { formatAmount } from "./units.js";

export type RiskRule =
  | "stop_file"
  | "max_total_loss"
  | "max_orders_per_hour"
  | "min_cooldown"
  | "max_slippage"
  | "max_position"
  | "daily_loss_cap"
  | "gas_reserve";

/** What the risk gate needs to know about the bot's book. `state.ts` builds it. */
export type RiskView = {
  now: number;
  /** BNB already spent on the open position in this coin, wei. */
  positionCostWei: (coin: string) => bigint;
  lastOrderAt: (coin: string) => number | null;
  ordersSince: (ms: number) => number;
  /** Realized result since 00:00 UTC, wei, signed: a loss is negative. */
  realizedTodayWei: bigint;
  /** What open positions would lose if sold at their last exit value, wei, never negative. */
  openLossWei: bigint;
  /** The wallet's BNB balance when known (live), else null. */
  balanceWei: bigint | null;
  /** How far the session is down, wei (negative when up); null or absent without a session. */
  sessionLossWei?: bigint | null;
};

export type Approval = { readonly id: number; readonly planId: string };

export type Verdict = { ok: true; approval: Approval } | { ok: false; rule: RiskRule; reason: string };

/** How long an approval stays good: the quote it rests on goes stale. */
const APPROVAL_TTL_MS = 60_000;

export class RiskError extends Error {
  constructor(
    readonly rule: RiskRule | "approval",
    message: string,
  ) {
    super(message);
    this.name = "RiskError";
  }
}

export class Risk {
  private readonly issued = new WeakMap<Approval, { plan: Plan; at: number; used: boolean }>();
  private nextId = 1;

  constructor(
    private readonly limits: Config["risk"] & { stopFile: string },
    private readonly deps: { exists?: (path: string) => boolean; now?: () => number } = {},
  ) {}

  /** Whether the kill switch is on. */
  stopped(): boolean {
    return (this.deps.exists ?? existsSync)(this.limits.stopFile);
  }

  check(plan: Plan, view: RiskView): Verdict {
    const limits = this.limits;
    if (this.stopped()) return refuse("stop_file", `${limits.stopFile} exists; delete it to allow orders again`);
    if (plan.side === "sell") return this.approve(plan);

    const sessionLoss = view.sessionLossWei ?? null;
    if (limits.maxTotalLossWei > 0n && sessionLoss !== null && sessionLoss >= limits.maxTotalLossWei) {
      return refuse("max_total_loss", `the session is ${formatAmount(sessionLoss)} BNB down (limit ${formatAmount(limits.maxTotalLossWei)})`);
    }
    if (plan.strategy === "llm_manager" && limits.onlyTotalLoss) {
      if (sessionLoss === null || limits.maxTotalLossWei === 0n) return refuse("max_total_loss", "no session to measure the total-loss stop against");
      return this.approve(plan);
    }

    const lastHour = view.ordersSince(view.now - 3_600_000);
    if (lastHour >= limits.maxOrdersPerHour) {
      return refuse("max_orders_per_hour", `${lastHour} orders in the last hour (limit ${limits.maxOrdersPerHour})`);
    }

    const last = view.lastOrderAt(plan.coin);
    if (last !== null && view.now - last < limits.minCooldownSeconds * 1000) {
      const wait = Math.ceil((limits.minCooldownSeconds * 1000 - (view.now - last)) / 1000);
      return refuse("min_cooldown", `last order on this coin was ${Math.floor((view.now - last) / 1000)} s ago; ${wait} s to go`);
    }

    if (plan.impact === null) return refuse("max_slippage", "no pool price to measure the expected slippage against");
    const impactBps = Math.round(plan.impact * 10_000);
    if (impactBps > limits.maxSlippageBps) {
      return refuse("max_slippage", `expected slippage ${impactBps} bps (limit ${limits.maxSlippageBps} bps)`);
    }

    const after = view.positionCostWei(plan.coin) + plan.amountIn;
    if (after > limits.maxPositionWei) {
      return refuse("max_position", `${formatAmount(after)} BNB in this coin after the order (limit ${formatAmount(limits.maxPositionWei)})`);
    }
    const loss = view.openLossWei - view.realizedTodayWei;
    if (loss >= limits.dailyLossCapWei) {
      return refuse("daily_loss_cap", `${formatAmount(loss)} BNB down today (limit ${formatAmount(limits.dailyLossCapWei)}); buys resume at 00:00 UTC`);
    }
    if (view.balanceWei !== null && view.balanceWei - plan.amountIn < limits.gasReserveWei) {
      return refuse("gas_reserve", `the order would leave less than ${formatAmount(limits.gasReserveWei)} BNB for gas`);
    }
    return this.approve(plan);
  }

  /** Mint the approval for a plan that passed, and freeze the plan it carries: what was checked is what is sent. */
  private approve(plan: Plan): Verdict {
    const approval: Approval = Object.freeze({ id: this.nextId++, planId: plan.id });
    this.issued.set(approval, { plan: deepFreeze(plan), at: this.now(), used: false });
    return { ok: true, approval };
  }

  /**
   * Spend an approval: the plan it was minted for, or a throw. Called by the
   * trader immediately before it logs a dry-run order or broadcasts a live one.
   */
  redeem(approval: Approval): Plan {
    const entry = this.issued.get(approval);
    if (!entry) throw new RiskError("approval", "this order was not approved by the risk gate");
    if (entry.used) throw new RiskError("approval", "this approval has already been used");
    if (this.now() - entry.at > APPROVAL_TTL_MS) throw new RiskError("approval", "this approval is stale; quote again");
    entry.used = true;
    this.assertNotStopped();
    return entry.plan;
  }

  /** The kill switch, checked again before every broadcast. */
  assertNotStopped(): void {
    if (this.stopped()) throw new RiskError("stop_file", `${this.limits.stopFile} exists; nothing is sent`);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

function refuse(rule: RiskRule, reason: string): Verdict {
  return { ok: false, rule, reason };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}
