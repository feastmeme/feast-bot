/**
 * What the bot remembers between ticks and between runs: open positions,
 * recent orders, and the realized result of each sale.
 *
 * A dry run keeps its own file (`….dry.json` beside `[bot] state_file`), so
 * paper positions never mix with real ones. The file holds amounts as decimal
 * strings of base units, and nothing secret: no key, no signature.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { Hex } from "./book.js";
import type { RiskView } from "./risk.js";
import type { Position, StrategyName } from "./strategies/types.js";

type OrderRecord = { at: number; coin: Hex; side: "buy" | "sell"; strategy: StrategyName };
type RealizedRecord = { at: number; coin: Hex; pnlWei: bigint };

type Data = {
  version: 1;
  positions: Record<string, Position>;
  orders: OrderRecord[];
  realized: RealizedRecord[];
  /** Pools launch momentum has bought once already, by pool id. */
  entered: Record<string, number>;
};

export type StateIo = {
  exists: (path: string) => boolean;
  read: (path: string) => string;
  write: (path: string, data: string) => void;
};

const fileIo: StateIo = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  write: (path, data) => {
    const temp = `${path}.tmp`;
    writeFileSync(temp, data, { mode: 0o600 });
    renameSync(temp, path);
  },
};

/** The dry-run twin of a state file path. */
export function dryRunPath(path: string): string {
  return path.endsWith(".json") ? `${path.slice(0, -".json".length)}.dry.json` : `${path}.dry`;
}

const DAY_MS = 86_400_000;

export class State {
  private constructor(
    private readonly path: string,
    private readonly io: StateIo,
    private data: Data,
  ) {}

  static load(path: string, io: StateIo = fileIo): State {
    if (!io.exists(path)) return new State(path, io, { version: 1, positions: {}, orders: [], realized: [], entered: {} });
    const parsed = JSON.parse(io.read(path), (_key, value) =>
      typeof value === "string" && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value,
    ) as Data;
    if (parsed.version !== 1) throw new Error(`${path} is not a state file this kit can read`);
    return new State(path, io, parsed);
  }

  save(): void {
    this.io.write(this.path, `${JSON.stringify(this.data, (_key, value) => (typeof value === "bigint" ? `${value}n` : value), 1)}\n`);
  }

  position(coin: string): Position | null {
    return this.data.positions[coin.toLowerCase()] ?? null;
  }

  positions(): Position[] {
    return Object.values(this.data.positions);
  }

  lastOrderAt(coin: string): number | null {
    let last: number | null = null;
    for (const order of this.data.orders) if (order.coin.toLowerCase() === coin.toLowerCase() && (last === null || order.at > last)) last = order.at;
    return last;
  }

  wasEntered(poolId: string): boolean {
    return poolId.toLowerCase() in this.data.entered;
  }

  /** Record a buy: open the position, or add to it. */
  recordBuy(input: { poolId: Hex; coin: Hex; strategy: StrategyName; coins: bigint; costWei: bigint; at: number }): void {
    const key = input.coin.toLowerCase();
    const open = this.data.positions[key];
    this.data.positions[key] = open
      ? { ...open, coins: open.coins + input.coins, costWei: open.costWei + input.costWei }
      : {
          poolId: input.poolId,
          coin: input.coin,
          strategy: input.strategy,
          coins: input.coins,
          costWei: input.costWei,
          openedAt: input.at,
          peakValueWei: null,
          lastValueWei: null,
        };
    if (input.strategy === "launch_momentum") this.markEntered(input.poolId, input.at);
    this.prune(input.at);
  }

  /**
   * An order the risk gate approved, counted the moment it is approved — before
   * it is sent — so one that fails after going out still counts against the
   * hourly cap and the cooldown, and cannot be retried every pass.
   */
  recordAttempt(input: { coin: Hex; side: "buy" | "sell"; strategy: StrategyName; at: number }): void {
    this.data.orders.push({ at: input.at, coin: input.coin, side: input.side, strategy: input.strategy });
    this.prune(input.at);
  }

  /** Gas a failed transaction burned: a loss like any other, for the daily cap. */
  recordCost(input: { coin: Hex; gasWei: bigint; at: number }): void {
    if (input.gasWei > 0n) this.data.realized.push({ at: input.at, coin: input.coin, pnlWei: -input.gasWei });
  }

  /** Launch momentum buys a pool once, whatever became of the attempt. */
  markEntered(poolId: string, at: number): void {
    this.data.entered[poolId.toLowerCase()] = at;
  }

  /** Record a sale of `coins` for `proceedsWei`; returns the realized result, wei, signed. */
  recordSell(input: { coin: Hex; strategy: StrategyName; coins: bigint; proceedsWei: bigint; at: number }): bigint {
    const key = input.coin.toLowerCase();
    const open = this.data.positions[key];
    let pnl = input.proceedsWei;
    if (open) {
      const sold = input.coins >= open.coins ? open.coins : input.coins;
      const cost = open.coins === 0n ? open.costWei : (open.costWei * sold) / open.coins;
      pnl = input.proceedsWei - cost;
      if (sold >= open.coins) delete this.data.positions[key];
      else this.data.positions[key] = { ...open, coins: open.coins - sold, costWei: open.costWei - cost };
    }
    this.data.realized.push({ at: input.at, coin: input.coin, pnlWei: pnl });
    this.prune(input.at);
    return pnl;
  }

  /** Remember what selling a position would bring now, and its peak. */
  markValue(coin: string, valueWei: bigint | null, peakValueWei: bigint | null): void {
    const open = this.data.positions[coin.toLowerCase()];
    if (!open) return;
    this.data.positions[coin.toLowerCase()] = {
      ...open,
      lastValueWei: valueWei ?? open.lastValueWei,
      peakValueWei: peakValueWei ?? open.peakValueWei,
    };
  }

  /** The figures the risk gate reads. */
  view(now: number, balanceWei: bigint | null): RiskView {
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
    let realizedTodayWei = 0n;
    for (const record of this.data.realized) if (record.at >= dayStart) realizedTodayWei += record.pnlWei;
    let openLossWei = 0n;
    for (const position of this.positions()) {
      if (position.lastValueWei !== null && position.lastValueWei < position.costWei) openLossWei += position.costWei - position.lastValueWei;
    }
    return {
      now,
      positionCostWei: (coin) => this.position(coin)?.costWei ?? 0n,
      lastOrderAt: (coin) => this.lastOrderAt(coin),
      ordersSince: (ms) => this.data.orders.filter((order) => order.at >= ms).length,
      realizedTodayWei,
      openLossWei,
      balanceWei,
    };
  }

  /** Keep two days of orders and results: enough for every limit, small enough to read. */
  private prune(now: number): void {
    const keep = now - 2 * DAY_MS;
    this.data.orders = this.data.orders.filter((order) => order.at >= keep);
    this.data.realized = this.data.realized.filter((record) => record.at >= keep);
  }
}
