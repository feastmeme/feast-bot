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

/**
 * THE SESSION the total-loss stop is measured over. It begins on the first
 * pass with no session in the file and lasts until `run --new-session`, so a
 * restart — or a crash and a restart — never resets how much has been lost.
 *
 * Its BNB is kept by the book, from the bot's own fills: the balance it began
 * with, less every buy (gas included) and every failed transaction's gas, plus
 * every sale's proceeds (gas taken off). So BNB the owner adds to or takes out
 * of the wallet is neither a loss nor a gain, and a dry run's paper trades move
 * it exactly as live ones would.
 */
export type Session = {
  startedAt: number;
  /** The BNB it began with plus what the open positions would have sold for then, wei. */
  startEquityWei: bigint;
  /** BNB by the book, wei. */
  cashWei: bigint;
  /** Realized results since it began, by coin, wei, signed. */
  realizedWei: Record<string, bigint>;
};

type Data = {
  version: 1;
  positions: Record<string, Position>;
  orders: OrderRecord[];
  realized: RealizedRecord[];
  /** Pools launch momentum has bought once already, by pool id. */
  entered: Record<string, number>;
  /** Absent in files written before the total-loss stop; null after `--new-session`. */
  session?: Session | null;
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

/**
 * What a position counts for in equity: its last exit value, or what it cost
 * until it has been valued once. A pool that cannot be quoted keeps its last
 * value rather than dropping to zero, so one failed read does not fire the stop.
 */
function valueOf(position: Position): bigint {
  return position.lastValueWei ?? position.costWei;
}

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

  /** The last order on any coin, ms; null with none in the last two days. */
  lastAnyOrderAt(): number | null {
    let last: number | null = null;
    for (const order of this.data.orders) if (last === null || order.at > last) last = order.at;
    return last;
  }

  wasEntered(poolId: string): boolean {
    return poolId.toLowerCase() in this.data.entered;
  }

  /** Record a buy: open the position, or add to it. */
  recordBuy(input: { poolId: Hex; coin: Hex; strategy: StrategyName; coins: bigint; costWei: bigint; at: number }): void {
    const key = input.coin.toLowerCase();
    const open = this.data.positions[key];
    // Coins added to a position count at what they cost until the next valuation,
    // so equity does not dip by the buy's cost in between.
    this.data.positions[key] = open
      ? {
          ...open,
          coins: open.coins + input.coins,
          costWei: open.costWei + input.costWei,
          lastValueWei: open.lastValueWei === null ? null : open.lastValueWei + input.costWei,
        }
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
    const session = this.data.session;
    if (session) session.cashWei -= input.costWei;
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
    if (input.gasWei <= 0n) return;
    this.data.realized.push({ at: input.at, coin: input.coin, pnlWei: -input.gasWei });
    this.bookResult(input.coin, -input.gasWei, -input.gasWei);
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
      else {
        // What is left keeps its share of the last value and the peak, not the whole.
        const left = open.coins - sold;
        const share = (value: bigint | null) => (value === null ? null : (value * left) / open.coins);
        this.data.positions[key] = { ...open, coins: left, costWei: open.costWei - cost, lastValueWei: share(open.lastValueWei), peakValueWei: share(open.peakValueWei) };
      }
    }
    this.data.realized.push({ at: input.at, coin: input.coin, pnlWei: pnl });
    this.bookResult(input.coin, input.proceedsWei, pnl);
    this.prune(input.at);
    return pnl;
  }

  /** The session's book: BNB in or out, and the realized result, for one coin. */
  private bookResult(coin: Hex, cashDeltaWei: bigint, pnlWei: bigint): void {
    const session = this.data.session;
    if (!session) return;
    const key = coin.toLowerCase();
    session.cashWei += cashDeltaWei;
    session.realizedWei[key] = (session.realizedWei[key] ?? 0n) + pnlWei;
  }

  session(): Session | null {
    return this.data.session ?? null;
  }

  /**
   * Begin the session: `cashWei` is the BNB it starts with (the wallet's
   * balance), and the open positions count at what they would sell for now.
   */
  startSession(input: { at: number; cashWei: bigint }): Session {
    let positionsWei = 0n;
    for (const position of this.positions()) positionsWei += valueOf(position);
    const session: Session = { startedAt: input.at, startEquityWei: input.cashWei + positionsWei, cashWei: input.cashWei, realizedWei: {} };
    this.data.session = session;
    return session;
  }

  /** `run --new-session`: forget the session, so the next pass begins one from where things stand. */
  endSession(): void {
    this.data.session = null;
  }

  /** BNB by the book plus what every open position would sell for now, wei; null without a session. */
  equityWei(): bigint | null {
    const session = this.data.session;
    if (!session) return null;
    let equity = session.cashWei;
    for (const position of this.positions()) equity += valueOf(position);
    return equity;
  }

  /** How far the session is down, wei: starting equity less equity now. Negative when it is up; null without a session. */
  sessionLossWei(): bigint | null {
    const session = this.data.session;
    const equity = this.equityWei();
    return session && equity !== null ? session.startEquityWei - equity : null;
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
      sessionLossWei: this.sessionLossWei(),
    };
  }

  /** Keep two days of orders and results: enough for every limit, small enough to read. */
  private prune(now: number): void {
    const keep = now - 2 * DAY_MS;
    this.data.orders = this.data.orders.filter((order) => order.at >= keep);
    this.data.realized = this.data.realized.filter((record) => record.at >= keep);
  }
}
