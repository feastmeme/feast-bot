import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";
import { Risk, RiskError, type Approval, type RiskView } from "../src/risk.js";
import type { Plan } from "../src/trade.js";
import { BNB_POOL } from "./fixtures.js";

const BNB = 10n ** 18n;
const NOW = 1_791_870_000_000;
const limits = { ...parseConfig("", "/tmp").risk, stopFile: "/tmp/STOP" };

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "p1",
    side: "buy",
    strategy: "mean_reversion",
    reason: "test",
    poolId: BNB_POOL.poolId,
    coin: BNB_POOL.coin,
    quoteAsset: BNB_POOL.quote,
    amountIn: BNB / 100n,
    quote: { out: 1000n * BNB, legQuote: BNB / 100n, fee: BNB / 10_100n },
    minOut: 970n * BNB,
    spot: 1e-5,
    impact: 0.01,
    deadline: 1n,
    hookData: "0x",
    approval: "not-needed",
    permit: null,
    steps: [],
    sell: null,
    ...overrides,
  };
}

function view(overrides: Partial<RiskView> = {}): RiskView {
  return {
    now: NOW,
    positionCostWei: () => 0n,
    lastOrderAt: () => null,
    ordersSince: () => 0,
    realizedTodayWei: 0n,
    openLossWei: 0n,
    balanceWei: null,
    ...overrides,
  };
}

function risk(options: { stop?: boolean; now?: () => number } = {}) {
  return new Risk(limits, { exists: () => options.stop === true, now: options.now ?? (() => NOW) });
}

describe("the risk gate approves an order inside every limit", () => {
  it("returns an approval the trader can redeem once", () => {
    const gate = risk();
    const verdict = gate.check(plan(), view());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(gate.redeem(verdict.approval).id).toBe("p1");
    expect(() => gate.redeem(verdict.approval)).toThrow(/already been used/);
  });
});

describe("each cap blocks an order on its own", () => {
  const cases: Array<[string, () => { gate: Risk; plan: Plan; view: RiskView }, string]> = [
    ["the STOP file", () => ({ gate: risk({ stop: true }), plan: plan(), view: view() }), "stop_file"],
    ["max_orders_per_hour", () => ({ gate: risk(), plan: plan(), view: view({ ordersSince: () => limits.maxOrdersPerHour }) }), "max_orders_per_hour"],
    ["min_cooldown", () => ({ gate: risk(), plan: plan(), view: view({ lastOrderAt: () => NOW - (limits.minCooldownSeconds * 1000 - 1) }) }), "min_cooldown"],
    ["max_slippage", () => ({ gate: risk(), plan: plan({ impact: (limits.maxSlippageBps + 1) / 10_000 }), view: view() }), "max_slippage"],
    ["max_slippage with no pool price", () => ({ gate: risk(), plan: plan({ impact: null }), view: view() }), "max_slippage"],
    [
      "max_position",
      () => ({ gate: risk(), plan: plan(), view: view({ positionCostWei: () => limits.maxPositionWei - BNB / 100n + 1n }) }),
      "max_position",
    ],
    ["daily_loss_cap (realized)", () => ({ gate: risk(), plan: plan(), view: view({ realizedTodayWei: -limits.dailyLossCapWei }) }), "daily_loss_cap"],
    ["daily_loss_cap (open positions)", () => ({ gate: risk(), plan: plan(), view: view({ openLossWei: limits.dailyLossCapWei }) }), "daily_loss_cap"],
    ["gas_reserve", () => ({ gate: risk(), plan: plan(), view: view({ balanceWei: BNB / 100n + limits.gasReserveWei - 1n }) }), "gas_reserve"],
  ];

  it.each(cases)("%s", (_name, setup, rule) => {
    const { gate, plan: p, view: v } = setup();
    const verdict = gate.check(p, v);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rule).toBe(rule);
    expect(verdict.reason.length).toBeGreaterThan(0);
  });

  it("and each limit is a boundary, not a near miss: one step inside passes", () => {
    const gate = risk();
    expect(gate.check(plan(), view({ ordersSince: () => limits.maxOrdersPerHour - 1 })).ok).toBe(true);
    expect(gate.check(plan(), view({ lastOrderAt: () => NOW - limits.minCooldownSeconds * 1000 })).ok).toBe(true);
    expect(gate.check(plan({ impact: limits.maxSlippageBps / 10_000 }), view()).ok).toBe(true);
    expect(gate.check(plan(), view({ positionCostWei: () => limits.maxPositionWei - BNB / 100n })).ok).toBe(true);
    expect(gate.check(plan(), view({ realizedTodayWei: -limits.dailyLossCapWei + 1n })).ok).toBe(true);
    expect(gate.check(plan(), view({ balanceWei: BNB / 100n + limits.gasReserveWei })).ok).toBe(true);
  });

  it("never traps a sale: a full hour, a fresh cooldown, a thin pool, an unknown price or a bad day cannot hold one", () => {
    const gate = risk();
    const worst = view({
      ordersSince: () => 99,
      lastOrderAt: () => NOW,
      positionCostWei: () => 10n * BNB,
      realizedTodayWei: -10n * BNB,
      openLossWei: 10n * BNB,
      balanceWei: 0n,
    });
    expect(gate.check(plan({ side: "sell", amountIn: 1000n * BNB, impact: 0.5 }), worst).ok).toBe(true);
    expect(gate.check(plan({ side: "sell", impact: null }), worst).ok).toBe(true);
  });

  it("holds a sale to the STOP file", () => {
    const verdict = risk({ stop: true }).check(plan({ side: "sell" }), view());
    expect(verdict).toMatchObject({ ok: false, rule: "stop_file" });
  });

  it("freezes the plan it approves, so what was checked is what is sent", () => {
    const gate = risk();
    const p = plan();
    const verdict = gate.check(p, view());
    if (!verdict.ok) throw new Error("expected approval");
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.quote)).toBe(true);
    expect(() => {
      (p as { amountIn: bigint }).amountIn = 10n * BNB;
    }).toThrow(TypeError);
  });
});

describe("an approval cannot be forged, reused, kept, or spent after STOP", () => {
  it("refuses an object that only looks like an approval", () => {
    const forged: Approval = Object.freeze({ id: 1, planId: "p1" });
    expect(() => risk().redeem(forged)).toThrow(RiskError);
  });

  it("refuses an approval from another gate", () => {
    const verdict = risk().check(plan(), view());
    if (!verdict.ok) throw new Error("expected approval");
    expect(() => risk().redeem(verdict.approval)).toThrow(/not approved/);
  });

  it("refuses a stale approval", () => {
    let now = NOW;
    const gate = risk({ now: () => now });
    const verdict = gate.check(plan(), view());
    if (!verdict.ok) throw new Error("expected approval");
    now += 61_000;
    expect(() => gate.redeem(verdict.approval)).toThrow(/stale/);
  });

  it("checks the STOP file again at the moment of sending", () => {
    let stop = false;
    const gate = new Risk(limits, { exists: () => stop, now: () => NOW });
    const verdict = gate.check(plan(), view());
    if (!verdict.ok) throw new Error("expected approval");
    stop = true;
    expect(() => gate.redeem(verdict.approval)).toThrow(/STOP/);
  });
});
