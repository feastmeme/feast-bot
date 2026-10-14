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
 */

import type { Config } from "./config.js";
import { ApiError, type ApiPool, type ChainReader, type FeastApi } from "./feast.js";
import { errorText, type Logger } from "./log.js";
import type { Risk } from "./risk.js";
import type { State } from "./state.js";
import { decideLaunchEntry, decideLaunchExit, tradesPerMinute } from "./strategies/launchMomentum.js";
import { decideMeanReversion, vwap } from "./strategies/meanReversion.js";
import type { Intent } from "./strategies/types.js";
import { NOTHING_HELD, SentTxError, TradeRefusedError, type Trader } from "./trade.js";

export type Engine = {
  config: Config;
  api: FeastApi;
  reader: ChainReader;
  trader: Trader;
  risk: Risk;
  state: State;
  log: Logger;
  now: () => number;
};

export async function tick(engine: Engine): Promise<void> {
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
  for (const position of state.positions()) {
    const value = await engine.trader.exitValue(position.poolId, position.coin, position.coins);
    if (position.strategy === "launch_momentum") {
      const decision = decideLaunchExit({ settings: config.launchMomentum, position, valueWei: value, now: now() });
      state.markValue(position.coin, value, decision.peakValueWei);
      if (decision.intent) await act(engine, decision.intent);
    } else {
      state.markValue(position.coin, value, value !== null && (position.peakValueWei === null || value > position.peakValueWei) ? value : null);
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

/** One proposed order, through the quote, the risk gate and the trader. */
export async function act(engine: Engine, intent: Intent): Promise<void> {
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
    } else if (error instanceof TradeRefusedError) {
      log.warn("order_refused_by_chain", { strategy: intent.strategy, side: intent.side, poolId: intent.poolId, refusal: error.refusal, error: error.message });
    } else {
      log.warn("order_unquoted", { strategy: intent.strategy, side: intent.side, poolId: intent.poolId, error: errorText(error) });
    }
    return;
  }

  const balance = trader.live ? await walletBalance(engine) : null;
  const verdict = risk.check(plan, state.view(now(), balance));
  if (!verdict.ok) {
    log.warn("order_blocked", { strategy: intent.strategy, side: intent.side, poolId: intent.poolId, rule: verdict.rule, reason: verdict.reason });
    return;
  }

  // COUNTED BEFORE IT IS SENT: an order that fails after going out still uses
  // up its place in the hour and starts the coin's cooldown.
  state.recordAttempt({ coin: intent.coin, side: intent.side, strategy: intent.strategy, at: now() });
  state.save();

  try {
    const result = await trader.execute(verdict.approval);
    const at = now();
    if (intent.side === "buy") {
      state.recordBuy({ poolId: intent.poolId, coin: intent.coin, strategy: intent.strategy, coins: result.fill.coins, costWei: result.fill.bnbWei, at });
    } else {
      // A strategy's sale is always the whole position, so it closes the whole position.
      const resultWei = state.recordSell({ coin: intent.coin, strategy: intent.strategy, coins: intent.coins, proceedsWei: result.fill.bnbWei, at });
      log.info("closed", { mode: result.sent ? "live" : "dry-run", strategy: intent.strategy, poolId: intent.poolId, coin: intent.coin, resultWei });
    }
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
    } else {
      const refusal = error instanceof TradeRefusedError ? error.refusal : null;
      log.error("order_failed", { strategy: intent.strategy, side: intent.side, poolId: intent.poolId, refusal, error: errorText(error) });
    }
  }
  state.save();
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

/** Run ticks until stopped. `once` runs a single tick. */
export async function run(engine: Engine, options: { once: boolean; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> }): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    try {
      await tick(engine);
    } catch (error) {
      engine.log.error("tick_failed", { error: errorText(error), apiStatus: error instanceof ApiError ? error.status : undefined });
    }
    if (options.once || options.signal?.aborted) return;
    await untilAborted(sleep(engine.config.bot.pollSeconds * 1000), options.signal);
    if (options.signal?.aborted) return;
  }
}

/** The wait between passes, cut short by Ctrl-C: "stops after the current pass" means now, not after the next sleep. */
function untilAborted(wait: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return wait;
  if (signal.aborted) return Promise.resolve();
  return Promise.race([wait, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
}
