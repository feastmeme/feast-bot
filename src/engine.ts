/**
 * ONE TICK: read, decide, check, act.
 *
 *   1. If the STOP file exists, do nothing this tick.
 *   2. Read the pool feed (one or a few API requests).
 *   3. Value every open position by quoting its sale; close launch-momentum
 *      positions whose trailing or time stop has fired.
 *   4. Mean reversion: for each listed pool, one candle request and one chain
 *      read of the price, then the strategy's decision.
 *   5. Launch momentum: for each pool younger than its window that has not
 *      been bought, check holders (already in the feed) and, only if they
 *      pass, count its trades (one request).
 *   6. Every proposed order is quoted (`trade.plan`), checked (`risk.check`)
 *      and only then executed — logged in a dry run, sent with `--live`.
 *
 * WITH A TOTAL-LOSS STOP (`[risk] max_total_loss_bnb`, which `[llm_manager]`
 * requires), right after step 3 the session begins if it has not, and the
 * session's loss is measured. At the limit the bot HALTS: it sells nothing,
 * creates the STOP file, writes a final log line and exits.
 *
 * WITH `[llm_manager]`, before the rule strategies: the advisor reads the
 * configured coins and, when a decision is due, asks the model once; the
 * strategy turns the answer into intents, and each goes through step 6 like
 * any other. The decision's record is written after its last intent.
 */

import { writeFileSync } from "node:fs";

import type { Advisor, IntentOutcome } from "./advisor.js";
import type { Hex } from "./book.js";
import type { Config } from "./config.js";
import { ApiError, type ApiPool, type ChainReader, type FeastApi } from "./feast.js";
import { errorText, type Logger } from "./log.js";
import type { Risk } from "./risk.js";
import type { State } from "./state.js";
import { decideLaunchEntry, decideLaunchExit, tradesPerMinute } from "./strategies/launchMomentum.js";
import { decideLlmManager, type Skipped } from "./strategies/llmManager.js";
import { decideMeanReversion, vwap } from "./strategies/meanReversion.js";
import type { Intent } from "./strategies/types.js";
import { NOTHING_HELD, SentTxError, TradeRefusedError, type Trader } from "./trade.js";
import { formatAmount } from "./units.js";

export type Engine = {
  config: Config;
  api: FeastApi;
  reader: ChainReader;
  trader: Trader;
  risk: Risk;
  state: State;
  log: Logger;
  now: () => number;
  /** Present when `[llm_manager]` is on. */
  advisor?: Advisor | null;
  /** How the total-loss stop creates the STOP file. Default: the real filesystem. */
  writeFile?: (path: string, data: string) => void;
};

/** "halt": the total-loss stop fired, and the bot must exit. */
export type TickResult = "halt" | void;

export async function tick(engine: Engine): Promise<TickResult> {
  const { config, api, reader, risk, state, log, now } = engine;
  const mode = engine.trader.live ? "live" : "dry-run";

  if (risk.stopped()) {
    log.warn("stopped", { mode, stopFile: config.bot.stopFile, note: "the STOP file exists: no reads, no orders this tick" });
    return;
  }

  let pools: ApiPool[];
  try {
    pools = await api.pools({ order: "created_desc", limit: 200, maxPages: 5 });
  } catch (error) {
    log.error("pools_unreadable", { error: errorText(error) });
    return;
  }
  const byId = new Map(pools.map((pool) => [pool.poolId.toLowerCase(), pool]));
  log.info("tick", { mode, pools: pools.length, positions: state.positions().length });

  // 3. Value open positions; launch momentum's stops.
  const exits: Intent[] = [];
  for (const position of state.positions()) {
    const value = await engine.trader.exitValue(position.poolId, position.coin, position.coins);
    if (position.strategy === "launch_momentum") {
      const decision = decideLaunchExit({ settings: config.launchMomentum, position, valueWei: value, now: now() });
      state.markValue(position.coin, value, decision.peakValueWei);
      if (decision.intent) exits.push(decision.intent);
    } else {
      state.markValue(position.coin, value, value !== null && (position.peakValueWei === null || value > position.peakValueWei) ? value : null);
    }
  }

  // The session, and its total-loss stop, measured on the values just read —
  // before any exit is acted on: when the stop fires, nothing is sold.
  await ensureSession(engine);
  if (lossStopReached(engine)) return halt(engine);
  for (const intent of exits) await act(engine, intent);

  // The model's decision, before the rule strategies.
  if (engine.advisor) {
    try {
      if ((await llmPass(engine, engine.advisor, byId)) === "halt") return "halt";
    } catch (error) {
      log.error("llm_pass_failed", { strategy: "llm_manager", error: errorText(error) });
    }
  }

  // 4. Mean reversion.
  if (config.meanReversion.enabled) {
    const settings = config.meanReversion;
    // One-minute candles while the window fits in one request (1,000 rows); five-minute beyond.
    const fine = settings.windowMin <= 1000;
    for (const poolId of settings.pools) {
      // A listed pool past the feed's last page is asked for by id.
      const pool = byId.get(poolId.toLowerCase()) ?? (await api.pool(poolId).catch(() => null));
      if (!pool) {
        log.warn("pool_not_found", { strategy: "mean_reversion", poolId });
        continue;
      }
      try {
        const coinIsCurrency0 = pool.poolKey.currency0.toLowerCase() === pool.coin.address.toLowerCase();
        const [candles, spot] = await Promise.all([
          api.ohlcv({ poolId: pool.poolId, timeframe: "minute", aggregate: fine ? 1 : 5, limit: fine ? settings.windowMin : Math.ceil(settings.windowMin / 5) }),
          reader.spotPrice(pool.poolId, coinIsCurrency0),
        ]);
        const intent = decideMeanReversion({
          settings,
          poolId: pool.poolId,
          coin: pool.coin.address,
          coinIsCurrency0,
          spot,
          candles,
          position: state.position(pool.coin.address),
          lastOrderAt: state.lastOrderAt(pool.coin.address),
          now: now(),
        });
        // What the strategy saw, so a dry run shows why it did or did not act.
        const average = vwap(candles, Math.floor(now() / 1000) - settings.windowMin * 60, coinIsCurrency0);
        log.info("checked", {
          strategy: "mean_reversion",
          poolId: pool.poolId,
          price: spot,
          average,
          gapPct: average === null || !(spot > 0) ? null : Math.round(((spot - average) / average) * 10_000) / 100,
          candles: candles.length,
          signal: intent ? intent.side : "none",
        });
        if (intent) await act(engine, intent);
      } catch (error) {
        log.warn("strategy_skipped", { strategy: "mean_reversion", poolId: pool.poolId, error: errorText(error) });
      }
    }
  }

  // 5. Launch momentum.
  if (config.launchMomentum.enabled) {
    const settings = config.launchMomentum;
    const since = now() - settings.windowMin * 60_000;
    const young = pools.filter((pool) => pool.createdAt !== null && Date.parse(pool.createdAt) >= since);
    log.info("checked", { strategy: "launch_momentum", windowMin: settings.windowMin, newPools: young.length });
    for (const pool of young) {
      if (state.wasEntered(pool.poolId) || state.position(pool.coin.address)) continue;
      const holders = pool.market?.holders ?? null;
      if (holders === null || holders < settings.minHolders) {
        log.info("watching", { strategy: "launch_momentum", poolId: pool.poolId, holders, minHolders: settings.minHolders });
        continue;
      }
      try {
        const launchedAtMs = Date.parse(pool.createdAt as string);
        const { trades } = await api.trades({ poolId: pool.poolId, limit: 1000 });
        const perMin = tradesPerMinute(trades.map((trade) => Date.parse(trade.at)), launchedAtMs, now());
        const intent = decideLaunchEntry({
          settings,
          poolId: pool.poolId,
          coin: pool.coin.address,
          launchedAtMs,
          holders,
          tradesPerMin: perMin,
          position: state.position(pool.coin.address),
          alreadyEntered: state.wasEntered(pool.poolId),
          now: now(),
        });
        if (intent) await act(engine, intent);
        else log.info("watching", { strategy: "launch_momentum", poolId: pool.poolId, holders, tradesPerMin: Math.round(perMin * 100) / 100 });
      } catch (error) {
        log.warn("strategy_skipped", { strategy: "launch_momentum", poolId: pool.poolId, error: errorText(error) });
      }
    }
  }

  state.save();
}

/**
 * The session begins on the first pass that has a total-loss stop to keep (or
 * the model to serve) and no session in the state file: from the wallet's
 * balance and the open positions' values just read. A dry run with no wallet
 * begins from zero BNB, which measures its losses all the same.
 */
async function ensureSession(engine: Engine): Promise<void> {
  const { config, state, trader, log, now } = engine;
  if (state.session() || (config.risk.maxTotalLossWei === 0n && !config.llmManager.enabled)) return;
  let cashWei = 0n;
  if (trader.wallet) {
    try {
      cashWei = await engine.reader.nativeBalance(trader.wallet);
    } catch (error) {
      log.warn("session_waiting", { note: "the wallet's balance could not be read; the session begins on a later pass", error: errorText(error) });
      return;
    }
  }
  const session = state.startSession({ at: now(), cashWei });
  state.save();
  log.info("session_start", {
    mode: trader.live ? "live" : "dry-run",
    startEquityWei: session.startEquityWei,
    cashWei: session.cashWei,
    maxTotalLossBnb: formatAmount(config.risk.maxTotalLossWei),
    note: "the total-loss stop is measured from here, across restarts, until run --new-session",
  });
}

function lossStopReached(engine: Engine): boolean {
  const cap = engine.config.risk.maxTotalLossWei;
  const loss = engine.state.sessionLossWei();
  return cap > 0n && loss !== null && loss >= cap;
}

/**
 * THE TOTAL-LOSS STOP. Nothing is sold: a stop that sells into a falling pool
 * would turn a paper loss into a real one at the worst price, and the owner
 * asked for a stop, not a liquidation. The STOP file is created so nothing
 * trades again until the owner deletes it, and the last line says why.
 */
function halt(engine: Engine): "halt" {
  const { config, state, log, now } = engine;
  state.save();
  const loss = state.sessionLossWei() ?? 0n;
  const at = new Date(now()).toISOString();
  let stopFile: string;
  try {
    (engine.writeFile ?? ((path: string, data: string) => writeFileSync(path, data, { mode: 0o600 })))(
      config.bot.stopFile,
      `${at} total-loss stop: the session is ${formatAmount(loss)} BNB down (limit ${formatAmount(config.risk.maxTotalLossWei)}). Nothing was sold. Delete this file, and start a new session with run --new-session, to trade again.\n`,
    );
    stopFile = "created";
  } catch (error) {
    stopFile = `could not be created: ${errorText(error)}`;
  }
  log.error("total_loss_stop", {
    mode: engine.trader.live ? "live" : "dry-run",
    lossWei: loss,
    lossBnb: formatAmount(loss),
    maxTotalLossBnb: formatAmount(config.risk.maxTotalLossWei),
    equityWei: state.equityWei(),
    startEquityWei: state.session()?.startEquityWei ?? null,
    positionsHeld: state.positions().length,
    stopFile: config.bot.stopFile,
    stopFileState: stopFile,
    note: "nothing was sold; the bot exits now",
  });
  return "halt";
}

/** The advisor's step: read, and when a decision is due, ask once and act on the answer. */
async function llmPass(engine: Engine, advisor: Advisor, feed: Map<string, ApiPool>): Promise<TickResult> {
  const { state, log, trader } = engine;
  await advisor.observe(feed);
  const due = advisor.due();
  if (!due) return;
  const session = state.session();
  const wallet = trader.wallet;
  if (!session || !wallet) {
    log.warn("llm_waiting", { strategy: "llm_manager", note: session ? "no wallet to decide for" : "no session yet to measure the total-loss stop against" });
    return;
  }
  const balanceWei = trader.live ? await walletBalance(engine) : session.cashWei;
  const decision = await advisor.decide({ state, balanceWei, wallet, early: due.early });
  const outcomes: IntentOutcome[] = [];
  let skipped: Skipped[] = [];
  if (decision.decisions) {
    const result = decideLlmManager({ decisions: decision.decisions, coins: advisor.coins(), position: (coin: Hex) => state.position(coin), balanceWei });
    skipped = result.skipped;
    for (const intent of result.intents) {
      if (lossStopReached(engine)) {
        advisor.record(decision, outcomes, skipped);
        return halt(engine);
      }
      const outcome = await act(engine, intent);
      outcomes.push({ coin: intent.coin, side: intent.side, amount: intent.side === "buy" ? formatAmount(intent.amountWei) : formatAmount(intent.coins), ...outcome });
    }
  }
  advisor.record(decision, outcomes, skipped);
  state.save();
  if (lossStopReached(engine)) return halt(engine);
}

/** What became of one intent: whether the risk gate let it through, and how it ended. */
export type ActOutcome = { approved: boolean; outcome: "placed" | "blocked" | "refused" | "unquoted" | "position_gone" | "failed" | "failed_after_send"; detail: string | null };

/** One proposed order, through the quote, the risk gate and the trader. */
export async function act(engine: Engine, intent: Intent): Promise<ActOutcome> {
  const { trader, risk, state, log, now } = engine;
  log.info("signal", { strategy: intent.strategy, side: intent.side, poolId: intent.poolId, coin: intent.coin, reason: intent.reason });

  let plan;
  try {
    plan = await trader.plan(intent);
  } catch (error) {
    if (error instanceof TradeRefusedError && error.refusal === NOTHING_HELD && intent.side === "sell") {
      // The coins left the wallet some other way: nothing to sell, so the
      // position is closed at nothing — a loss for the day, never a phantom.
      const resultWei = state.recordSell({ coin: intent.coin, strategy: intent.strategy, coins: intent.coins, proceedsWei: 0n, at: now() });
      state.save();
      log.warn("position_gone", { strategy: intent.strategy, poolId: intent.poolId, coin: intent.coin, resultWei });
      return { approved: false, outcome: "position_gone", detail: "the wallet holds none of this coin any more" };
    } else if (error instanceof TradeRefusedError) {
      log.warn("order_refused_by_chain", { strategy: intent.strategy, side: intent.side, poolId: intent.poolId, refusal: error.refusal, error: error.message });
      return { approved: false, outcome: "refused", detail: error.refusal ?? error.message };
    } else {
      log.warn("order_unquoted", { strategy: intent.strategy, side: intent.side, poolId: intent.poolId, error: errorText(error) });
      return { approved: false, outcome: "unquoted", detail: errorText(error) };
    }
  }

  const balance = trader.live ? await walletBalance(engine) : null;
  const verdict = risk.check(plan, state.view(now(), balance));
  if (!verdict.ok) {
    log.warn("order_blocked", { strategy: intent.strategy, side: intent.side, poolId: intent.poolId, rule: verdict.rule, reason: verdict.reason });
    return { approved: false, outcome: "blocked", detail: `${verdict.rule}: ${verdict.reason}` };
  }

  // COUNTED BEFORE IT IS SENT: an order that fails after going out still uses
  // up its place in the hour and starts the coin's cooldown.
  state.recordAttempt({ coin: intent.coin, side: intent.side, strategy: intent.strategy, at: now() });
  state.save();

  let outcome: ActOutcome;
  try {
    const result = await trader.execute(verdict.approval);
    outcome = { approved: true, outcome: "placed", detail: result.sent ? "sent" : "on paper (dry run)" };
    const at = now();
    if (intent.side === "buy") {
      state.recordBuy({ poolId: intent.poolId, coin: intent.coin, strategy: intent.strategy, coins: result.fill.coins, costWei: result.fill.bnbWei, at });
    } else {
      // A rule strategy's sale is the whole position. The model's may be a
      // share of it; but a live sale the wallet could not cover in full sold
      // everything the wallet held, and closes the whole position too.
      const short = result.sent && result.fill.coins < intent.coins;
      const coins = short ? (state.position(intent.coin)?.coins ?? intent.coins) : intent.coins;
      const resultWei = state.recordSell({ coin: intent.coin, strategy: intent.strategy, coins, proceedsWei: result.fill.bnbWei, at });
      log.info("closed", { mode: result.sent ? "live" : "dry-run", strategy: intent.strategy, poolId: intent.poolId, coin: intent.coin, resultWei });
    }
    await revalue(engine, intent.coin);
  } catch (error) {
    const at = now();
    if (error instanceof SentTxError) {
      state.recordCost({ coin: intent.coin, gasWei: error.gasWei, at });
      if (intent.side === "buy" && intent.strategy === "launch_momentum") state.markEntered(intent.poolId, at);
      if (error.outcome === "unknown" && intent.side === "buy") {
        // It may have landed. Booked at its floor, it is managed and sold like
        // any position; if it never landed, the next sale finds nothing held
        // and closes it at nothing.
        state.recordBuy({ poolId: intent.poolId, coin: intent.coin, strategy: intent.strategy, coins: plan.minOut, costWei: plan.amountIn, at });
      }
      log.error("order_failed_after_send", {
        strategy: intent.strategy,
        side: intent.side,
        poolId: intent.poolId,
        outcome: error.outcome,
        hashes: error.hashes,
        gasWei: error.gasWei,
        booked: error.outcome === "unknown" && intent.side === "buy" ? "position at its floor" : error.outcome === "unknown" ? "position kept" : "gas only",
      });
      outcome = { approved: true, outcome: "failed_after_send", detail: error.outcome };
    } else {
      const refusal = error instanceof TradeRefusedError ? error.refusal : null;
      log.error("order_failed", { strategy: intent.strategy, side: intent.side, poolId: intent.poolId, refusal, error: errorText(error) });
      outcome = { approved: true, outcome: "failed", detail: refusal ?? errorText(error) };
    }
  }
  state.save();
  return outcome;
}

/**
 * With a session open, a position is valued again right after a fill: a buy
 * otherwise counts at its cost until the next pass, and the stop, checked
 * before each of the model's orders, would not see what the fees and the
 * price impact of the last one took.
 */
async function revalue(engine: Engine, coin: Hex): Promise<void> {
  const { state, trader } = engine;
  const held = state.position(coin);
  if (!held || !state.session()) return;
  const value = await trader.exitValue(held.poolId, held.coin, held.coins);
  if (value !== null) state.markValue(held.coin, value, held.peakValueWei === null || value > held.peakValueWei ? value : null);
}

async function walletBalance(engine: Engine): Promise<bigint | null> {
  const wallet = engine.trader.wallet;
  if (!wallet) return null;
  try {
    return await engine.reader.nativeBalance(wallet);
  } catch {
    return null;
  }
}

/** Run ticks until stopped. `once` runs a single tick. "halted": the total-loss stop fired. */
export async function run(
  engine: Engine,
  options: { once: boolean; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> },
): Promise<"halted" | "done"> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    try {
      if ((await tick(engine)) === "halt") return "halted";
    } catch (error) {
      engine.log.error("tick_failed", { error: errorText(error), apiStatus: error instanceof ApiError ? error.status : undefined });
    }
    if (options.once || options.signal?.aborted) return "done";
    await untilAborted(sleep(engine.config.bot.pollSeconds * 1000), options.signal);
    if (options.signal?.aborted) return "done";
  }
}

/** The wait between passes, cut short by Ctrl-C: "stops after the current pass" means now, not after the next sleep. */
function untilAborted(wait: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return wait;
  if (signal.aborted) return Promise.resolve();
  return Promise.race([wait, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
}
