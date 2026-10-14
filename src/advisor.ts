/**
 * THE ADVISOR: the one part of `llm_manager` that talks to the network.
 *
 * The engine runs it before the strategies, every pass of its loop:
 *
 *   observe   reads what is cheap to keep current for the configured coins —
 *             each pool's new trades since the last read (one request a coin)
 *             and its holder count (from the feed the engine already read) —
 *             and notes the two events that wake a decision early: a single
 *             trade worth more than `event_trade_bnb`, or a pool younger than
 *             `event_new_pool_minutes`.
 *   due       a decision every `poll_minutes`; an event brings one forward,
 *             but never sooner than five minutes after the last.
 *   decide    assembles the packet (numbers only, `packet.ts`), asks the model
 *             ONCE, checks its answer (`model.ts`) and keeps it. The strategy
 *             turns the kept answer into intents; it never sees this module.
 *   record    one JSONL line per decision: the packet's hash, the model, the
 *             whole answer with its reasons, what became of every intent, and
 *             the tokens it cost.
 *
 * Any failure — an API error, a timeout, an answer off the schema — is a
 * decision with no answer: logged, and no intent comes of it.
 */

import type { Config } from "./config.js";
import type { Hex } from "./book.js";
import type { ApiPool, ApiTrade, ChainReader, FeastApi } from "./feast.js";
import { errorText, type Logger } from "./log.js";
import { ModelCallError, decisionRequest, parseAnswer, type ModelClient, type ModelDecision } from "./model.js";
import {
  PacketError,
  holderChanges,
  minutesBetween,
  priceChanges,
  serializePacket,
  sig,
  tradeFigures,
  volumes,
  whole,
  type AccountPacket,
  type CoinPacket,
  type Packet,
} from "./packet.js";
import type { State } from "./state.js";
import type { Candle } from "./strategies/types.js";
import type { Trader } from "./trade.js";

/** The soonest an event may bring a decision forward, after the last one. */
export const EARLY_GAP_MS = 5 * 60_000;
/** The trade window kept in memory: the longest the packet reports over, and a minute. */
const KEEP_MS = 61 * 60_000;
/** Pages of a pool's trade history read per pass of the loop while catching up. */
const CATCH_UP_PAGES = 5;
const PAGE = 1000;
/** How long a creator's other coins are kept before they are read again. */
const CREATOR_TTL_MS = 60 * 60_000;
const CREATOR_COINS_SHOWN = 20;

type Watched = {
  /** As the config lists it: a coin address or a pool id. */
  entry: Hex;
  coin: Hex | null;
  poolId: Hex | null;
  pool: ApiPool | null;
  /** When `pool` was read. */
  poolAt: number;
  cursor: string | null;
  caughtUp: boolean;
  trades: ApiTrade[];
  holders: Array<{ at: number; holders: number }>;
  bnbPerQuote: number | null;
  /** A repeat of a coin already listed. */
  ignored: boolean;
};

export type Trigger = { kind: "trade"; coin: Hex; bnb: number } | { kind: "new_pool"; coin: Hex; ageMin: number };

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export type Refusal = { kind: "packet" | "model_error" | "schema" | "gather"; detail: string; status?: number | null; requestId?: string | null };

/** One decision: what was asked, what came back. */
export type Decision = {
  pass: number;
  at: number;
  early: boolean;
  triggers: Trigger[];
  packetHash: string | null;
  model: string;
  /** The answer as the model gave it, when it passed every check. */
  decisions: ModelDecision[] | null;
  refusal: Refusal | null;
  usage: Usage | null;
};

/** What became of one intent, for the decision's record. */
export type IntentOutcome = {
  coin: Hex;
  side: "buy" | "sell";
  amount: string;
  /** Whether the risk gate let it through. */
  approved: boolean;
  outcome: string;
  detail?: string | null;
};

export class Advisor {
  private readonly watched: Watched[];
  private lastPassAt: number | null = null;
  private passes = 0;
  private triggers: Trigger[] = [];
  private readonly creators = new Map<string, { at: number; value: CoinPacket["creatorPriorCoins"] | null }>();
  private readonly startedAt: number;

  constructor(
    private readonly deps: {
      settings: Config["llmManager"];
      maxTotalLossWei: bigint;
      client: ModelClient;
      model: string;
      api: FeastApi;
      reader: ChainReader;
      trader: Trader;
      log: Logger;
      now: () => number;
    },
  ) {
    this.watched = deps.settings.coins.map((entry) => ({
      entry,
      coin: null,
      poolId: null,
      pool: null,
      poolAt: 0,
      cursor: null,
      caughtUp: false,
      trades: [],
      holders: [],
      bnbPerQuote: null,
      ignored: false,
    }));
    this.startedAt = deps.now();
  }

  get model(): string {
    return this.deps.model;
  }

  /** The configured coins found so far, by coin address: what the strategy may trade. */
  coins(): Map<Hex, { coin: Hex; poolId: Hex }> {
    const out = new Map<Hex, { coin: Hex; poolId: Hex }>();
    for (const w of this.watched) if (w.coin && w.poolId) out.set(w.coin, { coin: w.coin, poolId: w.poolId });
    return out;
  }

  // ── observe ──────────────────────────────────────────────────────────────

  /** Every pass of the loop: find the coins, read their new trades, sample holders, note events. */
  async observe(feed: Map<string, ApiPool>): Promise<void> {
    const now = this.deps.now();
    for (const w of this.watched) {
      try {
        if (w.ignored) continue;
        if (!w.poolId) await this.resolve(w, feed, now);
        if (!w.poolId || !w.coin) continue;
        const fromFeed = feed.get(w.poolId);
        if (fromFeed) {
          w.pool = fromFeed;
          w.poolAt = now;
          // Sampled only from a read made now: a stale copy stamped with the clock would misdate the change.
          if (fromFeed.market) this.sampleHolders(w, now, fromFeed.market.holders);
        }
        await this.readTrades(w, now);
        const createdAt = w.pool?.createdAt ? Date.parse(w.pool.createdAt) : null;
        const settings = this.deps.settings;
        if (createdAt !== null && settings.eventNewPoolMinutes > 0 && now - createdAt < settings.eventNewPoolMinutes * 60_000) {
          this.triggers.push({ kind: "new_pool", coin: w.coin, ageMin: minutesBetween(createdAt, now) });
        }
      } catch (error) {
        this.deps.log.warn("llm_watch_failed", { strategy: "llm_manager", coin: w.coin ?? w.entry, error: errorText(error) });
      }
    }
  }

  private async resolve(w: Watched, feed: Map<string, ApiPool>, now: number): Promise<void> {
    let pool: ApiPool | null = null;
    if (w.entry.length === 66) {
      pool = feed.get(w.entry) ?? (await this.deps.api.pool(w.entry));
    } else {
      pool = [...feed.values()].find((candidate) => candidate.coin.address.toLowerCase() === w.entry) ?? null;
      if (!pool) {
        const poolId = await this.deps.reader.poolIdOfCoin(w.entry);
        pool = feed.get(poolId.toLowerCase()) ?? (await this.deps.api.pool(poolId));
      }
    }
    const coin = pool.coin.address.toLowerCase() as Hex;
    // The same coin listed twice (by its address and by its pool id) is one coin.
    if (this.watched.some((other) => other !== w && other.coin === coin)) {
      w.ignored = true;
      this.deps.log.warn("llm_coin_repeated", { strategy: "llm_manager", entry: w.entry, coin, note: "this coin is already in [llm_manager] coins; the repeat is ignored" });
      return;
    }
    w.pool = pool;
    w.poolAt = now;
    w.poolId = pool.poolId.toLowerCase() as Hex;
    w.coin = coin;
    this.deps.log.info("llm_coin", { strategy: "llm_manager", entry: w.entry, coin: w.coin, poolId: w.poolId });
  }

  private sampleHolders(w: Watched, now: number, holders: number): void {
    w.holders.push({ at: now, holders });
    w.holders = w.holders.filter((sample) => sample.at >= now - KEEP_MS);
  }

  /**
   * A pool's trades come oldest first from a cursor. The first reads walk its
   * history up to now, a few pages a pass, keeping only the last hour; once
   * caught up, each pass reads only what is new. Until then the packet says
   * the trades are not known rather than showing a partial count.
   */
  private async readTrades(w: Watched, now: number): Promise<void> {
    const poolId = w.poolId as Hex;
    const wasCaughtUp = w.caughtUp;
    const fresh: ApiTrade[] = [];
    // The cursor only moves past trades that are kept: a page that fails
    // keeps what the pages before it read, and the next pass reads on from there.
    let failure: unknown = null;
    try {
      for (let page = 0; page < CATCH_UP_PAGES; page++) {
        const { trades, nextCursor } = await this.deps.api.trades({ poolId, sinceCursor: w.cursor, limit: PAGE });
        fresh.push(...trades);
        const last = trades.at(-1);
        w.cursor = nextCursor ?? last?.cursor ?? w.cursor;
        if (!nextCursor) {
          w.caughtUp = true;
          break;
        }
      }
    } catch (error) {
      failure = error;
    }
    w.trades = [...w.trades, ...fresh].filter((trade) => Date.parse(trade.at) >= now - KEEP_MS);
    await this.noteLargeTrades(w, fresh, wasCaughtUp);
    if (failure) throw failure;
  }

  /**
   * A large trade wakes a decision. Once caught up, every trade read is new
   * (the cursor says so, however late the index served it); history read
   * while catching up counts only from when the bot started.
   */
  private async noteLargeTrades(w: Watched, fresh: ApiTrade[], wasCaughtUp: boolean): Promise<void> {
    const recent = wasCaughtUp ? fresh : fresh.filter((trade) => Date.parse(trade.at) >= this.startedAt);
    if (recent.length === 0 || !w.caughtUp) return;
    const rate = w.bnbPerQuote ?? (await this.bnbPerQuote(w));
    if (rate === null || !w.pool) return;
    const threshold = whole(this.deps.settings.eventTradeWei);
    for (const trade of recent) {
      const bnb = whole(BigInt(trade.quoteAmount), w.pool.quote.decimals) * rate;
      if (bnb > threshold) this.triggers.push({ kind: "trade", coin: w.coin as Hex, bnb: sig(bnb) });
    }
  }

  private async bnbPerQuote(w: Watched): Promise<number | null> {
    if (!w.pool) return null;
    const one = 10n ** BigInt(w.pool.quote.decimals);
    const wei = await this.deps.trader.bnbValueOf(w.pool.quote.address, one).catch(() => null);
    w.bnbPerQuote = wei === null ? null : whole(wei);
    return w.bnbPerQuote;
  }

  // ── due ──────────────────────────────────────────────────────────────────

  /** Whether a decision is due now, and whether it comes early. */
  due(): { early: boolean } | null {
    const now = this.deps.now();
    if (this.coins().size === 0) return null;
    if (this.lastPassAt === null) return { early: false };
    if (now - this.lastPassAt >= this.deps.settings.pollMinutes * 60_000) return { early: false };
    if (this.triggers.length > 0 && now - this.lastPassAt >= EARLY_GAP_MS) return { early: true };
    return null;
  }

  // ── decide ───────────────────────────────────────────────────────────────

  /**
   * One decision: the packet, the call, the checked answer. `balanceWei` is
   * what the wallet may spend: its balance when live, the session's paper
   * BNB in a dry run.
   */
  async decide(input: { state: State; balanceWei: bigint | null; wallet: Hex; early: boolean }): Promise<Decision> {
    const now = this.deps.now();
    const minutesSinceLastPass = this.lastPassAt === null ? null : minutesBetween(this.lastPassAt, now);
    this.lastPassAt = now;
    this.passes += 1;
    const triggers = dedupe(this.triggers);
    this.triggers = [];
    const decision: Decision = {
      pass: this.passes,
      at: now,
      early: input.early,
      triggers,
      packetHash: null,
      model: this.deps.model,
      decisions: null,
      refusal: null,
      usage: null,
    };

    let packet: Packet;
    try {
      packet = {
        at: new Date(now).toISOString(),
        early: input.early,
        minutesSinceLastPass,
        account: this.account(input.state, input.balanceWei, input.wallet, now),
        coins: await this.coinPackets(input.state, now),
      };
    } catch (error) {
      decision.refusal = { kind: "gather", detail: errorText(error) };
      return decision;
    }

    let serialized: { json: string; hash: string };
    try {
      serialized = serializePacket(packet);
    } catch (error) {
      decision.refusal = { kind: "packet", detail: error instanceof PacketError ? error.message : errorText(error) };
      return decision;
    }
    decision.packetHash = serialized.hash;

    const coins = packet.coins.map((coin) => coin.coin);
    let reply: Awaited<ReturnType<ModelClient["createMessage"]>>;
    try {
      reply = await this.deps.client.createMessage(decisionRequest(this.deps.model, serialized.json, coins));
    } catch (error) {
      decision.refusal =
        error instanceof ModelCallError
          ? { kind: "model_error", detail: `${error.kind}: ${error.message}`, status: error.status, requestId: error.requestId }
          : { kind: "model_error", detail: errorText(error) };
      return decision;
    }
    decision.model = typeof reply.model === "string" && reply.model ? reply.model : this.deps.model;
    decision.usage = {
      inputTokens: reply.usage?.input_tokens ?? 0,
      outputTokens: reply.usage?.output_tokens ?? 0,
      cacheReadTokens: reply.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: reply.usage?.cache_creation_input_tokens ?? 0,
    };
    const parsed = parseAnswer(reply, coins);
    if (!parsed.ok) {
      decision.refusal = { kind: "schema", detail: parsed.problem };
      return decision;
    }
    decision.decisions = parsed.decisions;
    return decision;
  }

  private account(state: State, balanceWei: bigint | null, wallet: Hex, now: number): AccountPacket {
    const session = state.session();
    const equity = state.equityWei();
    if (!session || equity === null) throw new Error("no session to measure against");
    let realized = 0n;
    for (const value of Object.values(session.realizedWei)) realized += value;
    const loss = session.startEquityWei - equity;
    const lastAction = state.lastAnyOrderAt();
    return {
      wallet: wallet.toLowerCase() as Hex,
      bnbBalance: balanceWei === null ? null : sig(whole(balanceWei)),
      equityBnb: sig(whole(equity)),
      startEquityBnb: sig(whole(session.startEquityWei)),
      sessionStartedAt: new Date(session.startedAt).toISOString(),
      realizedBnb: sig(whole(realized)),
      unrealizedBnb: sig(whole(equity - session.startEquityWei - realized)),
      maxTotalLossBnb: sig(whole(this.deps.maxTotalLossWei)),
      lossBudgetLeftBnb: sig(whole(this.deps.maxTotalLossWei - loss)),
      lastActionAt: lastAction === null ? null : new Date(lastAction).toISOString(),
      minutesSinceLastAction: lastAction === null ? null : minutesBetween(lastAction, now),
    };
  }

  private async coinPackets(state: State, now: number): Promise<CoinPacket[]> {
    const out: CoinPacket[] = [];
    for (const w of this.watched) {
      if (!w.coin || !w.poolId) continue;
      out.push(await this.coinPacket(w, state, now));
    }
    return out;
  }

  /** One coin's figures. A read that fails leaves its figures null; it never stops the decision. */
  private async coinPacket(w: Watched, state: State, now: number): Promise<CoinPacket> {
    const { api, reader, log } = this.deps;
    const coin = w.coin as Hex;
    const poolId = w.poolId as Hex;
    // The feed's copy when it was read this pass of the loop; a coin past the feed's last page is read by id.
    const fresh = w.pool !== null && w.pool.market !== null && now - w.poolAt < 90_000;
    const pool = fresh ? w.pool : await api.pool(poolId).catch(() => w.pool);
    if (!pool) throw new Error(`pool ${poolId} could not be read`);
    if (!fresh && pool !== w.pool) w.poolAt = now;
    w.pool = pool;
    if (pool.market && !w.holders.some((sample) => sample.at === now)) this.sampleHolders(w, now, pool.market.holders);

    const coinIsCurrency0 = pool.poolKey.currency0.toLowerCase() === coin;
    const nowSec = Math.floor(now / 1000);
    const createdAtMs = timeOf(pool.createdAt);
    const lastTradeMs = timeOf(pool.market?.lastTradeAt ?? null);
    const [spot, rate, candles] = await Promise.all([
      reader.spotPrice(poolId, coinIsCurrency0).catch(() => null),
      this.bnbPerQuote(w),
      api.ohlcv({ poolId, timeframe: "minute", aggregate: 1, limit: 120 }).catch((error: unknown) => {
        log.warn("llm_read_failed", { strategy: "llm_manager", coin, read: "ohlcv", error: errorText(error) });
        return null as Candle[] | null;
      }),
    ]);
    const priceBnb = spot !== null && spot > 0 && rate !== null ? sig(spot * rate) : null;
    const holders = pool.market?.holders ?? null;

    const position = state.position(coin);
    const mine = position && position.strategy === "llm_manager" ? position : null;
    const realized = state.session()?.realizedWei[coin] ?? 0n;
    const lastOrder = state.lastOrderAt(coin);

    const packet: CoinPacket = {
      coin,
      poolId,
      creator: pool.creator ? (pool.creator.toLowerCase() as Hex) : null,
      createdAt: createdAtMs === null ? null : new Date(createdAtMs).toISOString(),
      poolAgeMin: createdAtMs === null ? null : minutesBetween(createdAtMs, now),
      priceBnb,
      priceChangePct: candles
        ? priceChanges({ candles, nowSec, coinIsCurrency0, spot, createdAtSec: createdAtMs === null ? null : Math.floor(createdAtMs / 1000) })
        : { "1m": null, "5m": null, "15m": null, "60m": null },
      volumeBnb: candles ? volumes({ candles, nowSec, quoteDecimals: pool.quote.decimals, bnbPerQuote: rate }) : { "1m": null, "5m": null, "15m": null, "60m": null },
      trades:
        w.caughtUp && rate !== null
          ? {
              "15m": tradeFigures({ trades: w.trades, nowMs: now, minutes: 15, quoteDecimals: pool.quote.decimals, bnbPerQuote: rate }),
              "60m": tradeFigures({ trades: w.trades, nowMs: now, minutes: 60, quoteDecimals: pool.quote.decimals, bnbPerQuote: rate }),
            }
          : null,
      holders,
      holdersChange: holderChanges(w.holders, now, holders),
      lastTradeAt: lastTradeMs === null ? null : new Date(lastTradeMs).toISOString(),
      openingCapBinding: pool.opening.capBinding,
      position: mine
        ? {
            coins: sig(whole(mine.coins)),
            costBnb: sig(whole(mine.costWei)),
            valueBnb: mine.lastValueWei === null ? null : sig(whole(mine.lastValueWei)),
            unrealizedBnb: mine.lastValueWei === null ? null : sig(whole(mine.lastValueWei - mine.costWei)),
            realizedBnb: sig(whole(realized)),
            openedAt: new Date(mine.openedAt).toISOString(),
            minutesHeld: minutesBetween(mine.openedAt, now),
          }
        : null,
      lastOrderAt: lastOrder === null ? null : new Date(lastOrder).toISOString(),
      minutesSinceLastOrder: lastOrder === null ? null : minutesBetween(lastOrder, now),
    };
    const prior = pool.creator ? await this.creatorCoins(pool.creator, coin, now) : null;
    if (prior) packet.creatorPriorCoins = prior;
    return packet;
  }

  /**
   * The creator's other coins, from the public launches list: each one's
   * holder count and trade count, both numbers as the API gives them. Their
   * names never leave this function. Omitted when the list cannot be read.
   */
  private async creatorCoins(creator: Hex, except: Hex, now: number): Promise<CoinPacket["creatorPriorCoins"] | null> {
    const key = creator.toLowerCase();
    const cached = this.creators.get(key);
    if (cached && now - cached.at < CREATOR_TTL_MS) return cached.value;
    let value: CoinPacket["creatorPriorCoins"] | null = null;
    try {
      const launches = await this.deps.api.launches(creator);
      const others = launches
        .filter((launch) => launch.coin.address.toLowerCase() !== except && Number.isFinite(launch.holders) && Number.isFinite(launch.trades))
        .map((launch) => ({ coin: launch.coin.address.toLowerCase() as Hex, holders: launch.holders, trades: launch.trades }));
      value = { count: others.length, coins: others.slice(0, CREATOR_COINS_SHOWN) };
    } catch (error) {
      this.deps.log.warn("llm_read_failed", { strategy: "llm_manager", coin: except, read: "creator launches", error: errorText(error) });
    }
    this.creators.set(key, { at: now, value });
    return value;
  }

  // ── record ───────────────────────────────────────────────────────────────

  /** The decision's one line in the log, after its intents have been through the gate. */
  record(decision: Decision, outcomes: IntentOutcome[], skipped: Array<{ coin: Hex; action: string; why: string }>): void {
    const fields = {
      strategy: "llm_manager",
      pass: decision.pass,
      early: decision.early,
      triggers: decision.triggers,
      packetHash: decision.packetHash,
      model: decision.model,
      answer: decision.decisions
        ? decision.decisions.map((d) => ({ coin: d.coin, action: d.action, amount_bnb: d.amountBnb, fraction: d.fraction, reason: d.reason }))
        : null,
      refusal: decision.refusal,
      intents: outcomes,
      skipped,
      usage: decision.usage,
    };
    if (decision.refusal) this.deps.log.warn("decision", fields);
    else this.deps.log.info("decision", fields);
  }
}

/** A time the API served, as ms; null when absent or unreadable, never a throw mid-packet. */
function timeOf(text: string | null): number | null {
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** One trigger per coin and kind: the largest trade, the latest age. */
function dedupe(triggers: Trigger[]): Trigger[] {
  const out = new Map<string, Trigger>();
  for (const trigger of triggers) {
    const key = `${trigger.kind}:${trigger.coin}`;
    const kept = out.get(key);
    if (!kept || (trigger.kind === "trade" && kept.kind === "trade" && trigger.bnb > kept.bnb) || trigger.kind === "new_pool") out.set(key, trigger);
  }
  return [...out.values()];
}
