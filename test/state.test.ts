import { describe, expect, it } from "vitest";

import { Logger } from "../src/log.js";
import { State, dryRunPath, type StateIo } from "../src/state.js";
import { BNB_POOL, ROUTED_POOL } from "./fixtures.js";

const BNB = 10n ** 18n;
const DAY = 86_400_000;
const NOON = Date.UTC(2026, 9, 13, 12, 0, 0);

function memoryIo() {
  const files = new Map<string, string>();
  const io: StateIo = { exists: (p) => files.has(p), read: (p) => files.get(p) ?? "", write: (p, d) => void files.set(p, d) };
  return { io, files };
}

describe("state", () => {
  it("keeps a dry run's paper positions in a file of their own", () => {
    expect(dryRunPath("/x/feast-bot.state.json")).toBe("/x/feast-bot.state.dry.json");
  });

  it("opens, adds to and closes a position, and reports the realized result", () => {
    const { io } = memoryIo();
    const state = State.load("/s.json", io);
    state.recordBuy({ poolId: BNB_POOL.poolId, coin: BNB_POOL.coin, strategy: "mean_reversion", coins: 1000n * BNB, costWei: BNB / 100n, at: NOON });
    state.recordBuy({ poolId: BNB_POOL.poolId, coin: BNB_POOL.coin, strategy: "mean_reversion", coins: 1000n * BNB, costWei: BNB / 100n, at: NOON + 1 });
    expect(state.position(BNB_POOL.coin)).toMatchObject({ coins: 2000n * BNB, costWei: BNB / 50n });
    const pnl = state.recordSell({ coin: BNB_POOL.coin, strategy: "mean_reversion", coins: 2000n * BNB, proceedsWei: BNB / 40n, at: NOON + 2 });
    expect(pnl).toBe(BNB / 40n - BNB / 50n);
    expect(state.position(BNB_POOL.coin)).toBeNull();
    // Orders are counted when they are approved, not when they fill.
    expect(state.lastOrderAt(BNB_POOL.coin)).toBeNull();
    state.recordAttempt({ coin: BNB_POOL.coin, side: "sell", strategy: "mean_reversion", at: NOON + 2 });
    expect(state.lastOrderAt(BNB_POOL.coin)).toBe(NOON + 2);
  });

  it("gives the risk gate today's realized result, open paper losses and the hour's orders", () => {
    const { io } = memoryIo();
    const state = State.load("/s.json", io);
    // Yesterday's loss does not count today.
    state.recordBuy({ poolId: BNB_POOL.poolId, coin: BNB_POOL.coin, strategy: "mean_reversion", coins: 1n, costWei: BNB, at: NOON - DAY });
    state.recordSell({ coin: BNB_POOL.coin, strategy: "mean_reversion", coins: 1n, proceedsWei: 0n, at: NOON - DAY + 1 });
    // Today's.
    state.recordBuy({ poolId: BNB_POOL.poolId, coin: BNB_POOL.coin, strategy: "mean_reversion", coins: 1n, costWei: BNB / 10n, at: NOON - 1000 });
    state.recordSell({ coin: BNB_POOL.coin, strategy: "mean_reversion", coins: 1n, proceedsWei: BNB / 20n, at: NOON - 500 });
    // An open position worth less than it cost.
    state.recordBuy({ poolId: ROUTED_POOL.poolId, coin: ROUTED_POOL.coin, strategy: "launch_momentum", coins: 5n, costWei: BNB / 100n, at: NOON });
    state.markValue(ROUTED_POOL.coin, BNB / 400n, BNB / 100n);
    // Three approved orders this hour; gas a reverted one burned counts as a loss.
    for (const at of [NOON - 1000, NOON - 500, NOON]) state.recordAttempt({ coin: BNB_POOL.coin, side: "buy", strategy: "mean_reversion", at });
    state.recordAttempt({ coin: BNB_POOL.coin, side: "buy", strategy: "mean_reversion", at: NOON - 2 * 3_600_000 });
    state.recordCost({ coin: BNB_POOL.coin, gasWei: 10n ** 15n, at: NOON });

    const view = state.view(NOON, null);
    expect(view.realizedTodayWei).toBe(-(BNB / 20n) - 10n ** 15n);
    expect(view.openLossWei).toBe(BNB / 100n - BNB / 400n);
    expect(view.ordersSince(NOON - 3_600_000)).toBe(3);
    expect(view.positionCostWei(ROUTED_POOL.coin)).toBe(BNB / 100n);
    expect(state.wasEntered(ROUTED_POOL.poolId)).toBe(true);
    expect(state.wasEntered(BNB_POOL.poolId)).toBe(false);
  });

  it("round-trips every amount exactly through its file, and keeps nothing secret in it", () => {
    const { io, files } = memoryIo();
    const state = State.load("/s.json", io);
    const odd = 123_456_789_012_345_678_901_234_567n;
    state.recordBuy({ poolId: BNB_POOL.poolId, coin: BNB_POOL.coin, strategy: "launch_momentum", coins: odd, costWei: odd + 1n, at: NOON });
    state.save();
    const again = State.load("/s.json", io);
    expect(again.position(BNB_POOL.coin)).toMatchObject({ coins: odd, costWei: odd + 1n });
    expect(files.get("/s.json")).not.toMatch(/key|signature/i);
  });
});

describe("the logger", () => {
  it("writes one JSON object per line, amounts as exact strings, to stdout and the file alike", () => {
    const out: string[] = [];
    const file: string[] = [];
    const log = new Logger({ out: (l) => out.push(l), file: "/l.jsonl", append: (_p, d) => file.push(d), now: () => new Date(NOON) });
    log.info("order", { amountIn: 10n ** 30n + 1n });
    expect(JSON.parse(out[0]!)).toEqual({ ts: "2026-10-13T12:00:00.000Z", level: "info", event: "order", amountIn: "1000000000000000000000000000001" });
    expect(file[0]).toBe(`${out[0]}\n`);
  });

  it("scrubs a registered secret from every line, in any letter case", () => {
    const key = `0x${"aB".repeat(32)}`;
    const out: string[] = [];
    const log = new Logger({ out: (l) => out.push(l), file: null });
    log.redact(key);
    log.redact(key.slice(2));
    log.error("oops", { message: `bad key ${key}`, upper: key.toUpperCase(), bare: key.slice(2).toLowerCase() });
    expect(out[0]).not.toMatch(/ab(ab){10}/i);
    expect(out[0]!.match(/\[redacted\]/g)).toHaveLength(3);
  });
});
