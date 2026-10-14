#!/usr/bin/env node
/**
 * feast-bot — the command line.
 *
 *   feast-bot run --config bot.toml [--live] [--once]
 *   feast-bot quote <poolId> <amount> [--side buy|sell] [--config bot.toml]
 *   feast-bot pools [--limit 50] [--config bot.toml]
 *
 * `run` is a DRY RUN unless `--live` is given: it reads, decides, quotes and
 * prints each order it would place — the calldata, the quote and the expected
 * slippage — and sends nothing. Only `--live` reads the key, and only `--live`
 * builds anything that can send.
 */

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { createPublicClient, createWalletClient, http } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { bsc } from "viem/chains";

import { CHAIN_ID, CONTRACTS, type Hex } from "./book.js";
import { ConfigError, configDir, defaultConfig, parseConfig, type Config } from "./config.js";
import { run } from "./engine.js";
import { ChainReader, FeastApi, RateLimiter, chainClientFrom, type ChainClient } from "./feast.js";
import { Logger, errorText } from "./log.js";
import { Risk } from "./risk.js";
import { KeyError, loadKey } from "./secret.js";
import { State, dryRunPath, type StateIo } from "./state.js";
import { Trader, TradeRefusedError, describe, type Sender } from "./trade.js";
import { formatAmount, parseAmount } from "./units.js";

export type CliDeps = {
  env: Record<string, string | undefined>;
  cwd: string;
  readFile: (path: string) => string;
  /** stdout, one line at a time. */
  out: (line: string) => void;
  /** stderr, one line at a time. */
  err: (line: string) => void;
  makeChainClient: (rpcUrl: string) => ChainClient;
  /** Builds the only thing that can send. Called for `--live` and never otherwise. */
  makeSender: (account: PrivateKeyAccount, rpcUrl: string) => Sender;
  fetch?: ConstructorParameters<typeof FeastApi>[0]["fetch"];
  loadKey?: typeof loadKey;
  stateIo?: StateIo;
  appendLog?: (path: string, data: string) => void;
  exists?: (path: string) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};

const USAGE = `feast-bot — a small trading bot for Feast pools on BNB Smart Chain

  feast-bot run --config bot.toml [--once] [--live]
      Run the strategies the config turns on. Without --live this is a dry
      run: every order is quoted and printed, and nothing is sent.
      --once runs a single pass and exits.

  feast-bot quote <poolId> <amount> [--side buy|sell] [--config bot.toml]
      Quote one trade the way the bot would place it: amount is BNB for a
      buy, coins for a sale. Prints the quote, the expected slippage and the
      calldata. Sends nothing.

  feast-bot pools [--limit 50] [--config bot.toml]
      List pools, newest first, with the pool ids the config asks for.

The key is read only for --live: from BOT_PRIVATE_KEY, or from the file
[bot] key_file names. It is never printed, logged or written anywhere.`;

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    deps.out(USAGE);
    return command ? 0 : 2;
  }
  try {
    if (command === "run") return await runCommand(rest, deps);
    if (command === "quote") return await quoteCommand(rest, deps);
    if (command === "pools") return await poolsCommand(rest, deps);
    deps.err(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof KeyError || error instanceof UsageError) {
      deps.err(error.message);
      return 2;
    }
    deps.err(`feast-bot: ${errorText(error)}`);
    return 1;
  }
}

class UsageError extends Error {
  override name = "UsageError";
}

function parse(args: string[], options: NonNullable<ParseArgsConfig["options"]>) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(`${errorText(error)}\n\n${USAGE}`);
  }
}

function readConfig(path: string | undefined, deps: CliDeps, required: boolean): Config {
  if (!path) {
    if (required) throw new UsageError("run needs --config <path>; start from bot.example.toml");
    return defaultConfig(deps.cwd);
  }
  const full = resolve(deps.cwd, path);
  let source: string;
  try {
    source = deps.readFile(full);
  } catch {
    throw new UsageError(`cannot read the config ${full}`);
  }
  return parseConfig(source, configDir(full));
}

/** The chain the RPC serves, held to 56 before anything else happens. */
async function chainFor(config: Config, deps: CliDeps): Promise<ChainClient> {
  const client = deps.makeChainClient(config.bot.rpcUrl);
  const id = await client.getChainId();
  if (id !== CHAIN_ID) throw new UsageError(`[bot] rpc_url serves chain ${id}, not BNB Smart Chain (${CHAIN_ID})`);
  return client;
}

/** What may be printed about the RPC: its host, never a path or query that might hold an API key. */
function rpcHost(rpcUrl: string): string {
  return new URL(rpcUrl).host;
}

async function runCommand(args: string[], deps: CliDeps): Promise<number> {
  const { values } = parse(args, {
    config: { type: "string" },
    live: { type: "boolean", default: false },
    once: { type: "boolean", default: false },
  });
  const config = readConfig(values.config as string | undefined, deps, true);
  const live = values.live === true;
  const now = deps.now ?? Date.now;

  const log = new Logger({ out: deps.out, file: config.bot.logFile, append: deps.appendLog, now: () => new Date(now()) });
  // A paid RPC URL carries its key in the path or the query: never print it.
  const rpc = new URL(config.bot.rpcUrl);
  if (rpc.pathname.length > 1) log.redact(rpc.pathname);
  if (rpc.search.length > 1) log.redact(rpc.search);

  const client = await chainFor(config, deps);

  let wallet: Hex | null = config.bot.wallet;
  let sender: Sender | null = null;
  if (live) {
    const key = (deps.loadKey ?? loadKey)(config, deps.env);
    for (const secret of key.secrets) log.redact(secret);
    wallet = key.account.address;
    sender = deps.makeSender(key.account, config.bot.rpcUrl);
  }

  const state = State.load(live ? config.bot.stateFile : dryRunPath(config.bot.stateFile), deps.stateIo);
  const risk = new Risk({ ...config.risk, stopFile: config.bot.stopFile }, { exists: deps.exists, now });
  const reader = new ChainReader(client);
  const api = new FeastApi({ base: config.bot.apiBase, limiter: new RateLimiter(config.bot.apiRequestsPerMinute, now, deps.sleep), fetch: deps.fetch });
  const trader = new Trader({ reader, risk, log, wallet, sender, referrer: config.bot.referrer, maxSlippageBps: config.risk.maxSlippageBps });

  log.info("start", {
    mode: live ? "live" : "dry-run",
    note: live ? "orders that pass every limit are signed and sent" : "nothing is sent; add --live to trade",
    wallet,
    rpc: rpcHost(config.bot.rpcUrl),
    api: config.bot.apiBase,
    strategies: {
      mean_reversion: config.meanReversion.enabled ? config.meanReversion.pools.length : "off",
      launch_momentum: config.launchMomentum.enabled ? "on" : "off",
    },
    limits: {
      maxPositionBnb: formatAmount(config.risk.maxPositionWei),
      dailyLossCapBnb: formatAmount(config.risk.dailyLossCapWei),
      maxSlippageBps: config.risk.maxSlippageBps,
      minCooldownSeconds: config.risk.minCooldownSeconds,
      maxOrdersPerHour: config.risk.maxOrdersPerHour,
    },
    stopFile: config.bot.stopFile,
  });

  await run({ config, api, reader, trader, risk, state, log, now }, { once: values.once === true, signal: deps.signal, sleep: deps.sleep });
  log.info("exit", { mode: live ? "live" : "dry-run" });
  return 0;
}

async function quoteCommand(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, {
    config: { type: "string" },
    side: { type: "string", default: "buy" },
  });
  const [poolIdRaw, amountRaw] = positionals;
  if (!poolIdRaw || !/^0x[0-9a-fA-F]{64}$/.test(poolIdRaw)) throw new UsageError("quote needs a pool id: 0x and 64 hex digits (feast-bot pools prints them)");
  if (!amountRaw) throw new UsageError("quote needs an amount: BNB for a buy, coins for a sale, like 0.01");
  const side = values.side;
  if (side !== "buy" && side !== "sell") throw new UsageError("--side is buy or sell");
  let amount: bigint;
  try {
    amount = parseAmount(amountRaw);
  } catch {
    throw new UsageError(`the amount must be a plain decimal, like 0.01`);
  }
  if (amount <= 0n) throw new UsageError("the amount must be more than zero");

  const config = readConfig(values.config as string | undefined, deps, false);
  const poolId = poolIdRaw.toLowerCase() as Hex;
  const now = deps.now ?? Date.now;
  const client = await chainFor(config, deps);
  const api = new FeastApi({ base: config.bot.apiBase, limiter: new RateLimiter(config.bot.apiRequestsPerMinute, now, deps.sleep), fetch: deps.fetch });
  const quiet = new Logger({ out: () => {}, file: null });
  const risk = new Risk({ ...config.risk, stopFile: config.bot.stopFile }, { exists: deps.exists, now });
  const reader = new ChainReader(client);
  const trader = new Trader({ reader, risk, log: quiet, wallet: config.bot.wallet, sender: null, referrer: config.bot.referrer, maxSlippageBps: config.risk.maxSlippageBps });

  const pool = await api.pool(poolId);
  let plan;
  try {
    plan = await trader.plan(
      side === "buy"
        ? { side, strategy: "manual", poolId, coin: pool.coin.address, amountWei: amount, reason: "feast-bot quote" }
        : { side, strategy: "manual", poolId, coin: pool.coin.address, coins: amount, reason: "feast-bot quote" },
    );
  } catch (error) {
    if (error instanceof TradeRefusedError) {
      deps.out(JSON.stringify({ poolId, side, amountIn: amount.toString(), refused: error.refusal, message: error.message, sent: false }, null, 2));
      return 1;
    }
    throw error;
  }

  // A SECOND OPINION: the API's own simulation of the Feast leg, which must agree with ours.
  const legIn = side === "buy" ? plan.quote.legQuote : amount;
  const legOut = side === "buy" ? plan.quote.out : plan.quote.legQuote;
  let apiCheck: Record<string, unknown>;
  try {
    const answer = await api.quote({ poolId, side, amountIn: legIn, referrer: config.bot.referrer });
    apiCheck = {
      endpoint: "/api/v1/quote",
      amountIn: legIn,
      amountOut: answer.amountOut,
      refusal: answer.refusal?.name ?? null,
      agrees: answer.amountOut === legOut.toString(),
      quotedAtBlock: answer.quotedAtBlock,
    };
  } catch (error) {
    apiCheck = { endpoint: "/api/v1/quote", error: errorText(error) };
  }

  const summary = {
    sent: false,
    note: "a quote only: nothing was signed or sent",
    ...describe(plan),
    minOutAtMaxSlippage: `${config.risk.maxSlippageBps} bps below the quote`,
    readable: {
      amountIn: formatAmount(amount),
      out: formatAmount(plan.quote.out),
      minOut: formatAmount(plan.minOut),
      expectedSlippagePercent: plan.impact === null ? null : Math.round(plan.impact * 10_000) / 100,
      unit: side === "buy" ? "BNB in, coins out" : "coins in, BNB out",
    },
    wallet: config.bot.wallet,
    router: CONTRACTS.router,
    apiCheck,
  };
  deps.out(JSON.stringify(summary, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
  return 0;
}

async function poolsCommand(args: string[], deps: CliDeps): Promise<number> {
  const { values } = parse(args, { config: { type: "string" }, limit: { type: "string", default: "50" } });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new UsageError("--limit is a whole number from 1 to 1000");
  const config = readConfig(values.config as string | undefined, deps, false);
  const now = deps.now ?? Date.now;
  const api = new FeastApi({ base: config.bot.apiBase, limiter: new RateLimiter(config.bot.apiRequestsPerMinute, now, deps.sleep), fetch: deps.fetch });
  const pools = (await api.pools({ order: "created_desc", limit: Math.min(limit, 200), maxPages: Math.ceil(limit / 200) })).slice(0, limit);

  deps.out(["pool id", "coin", "opened (UTC)", "holders", "trades 24h", "opening cap"].join("\t"));
  for (const pool of pools) {
    deps.out(
      [
        pool.poolId,
        pool.coin.address,
        pool.createdAt ? pool.createdAt.slice(0, 16).replace("T", " ") : "unknown",
        pool.market?.holders ?? "-",
        pool.market?.trades24h ?? "-",
        pool.opening.capBinding ? "binding" : "lifted",
      ].join("\t"),
    );
  }
  deps.out(`${pools.length} pools. A coin's page: ${config.bot.apiBase}/coin/<coin>`);
  return 0;
}

/** The real world: viem over HTTP, the real filesystem, the real clock. */
function realDeps(): CliDeps {
  const controller = new AbortController();
  process.once("SIGINT", () => {
    process.stderr.write("stopping after this pass…\n");
    controller.abort();
  });
  return {
    env: process.env,
    cwd: process.cwd(),
    readFile: (path) => readFileSync(path, "utf8"),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    makeChainClient: (rpcUrl) => chainClientFrom(createPublicClient({ chain: bsc, transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) })),
    makeSender: (account, rpcUrl) => {
      const wallet = createWalletClient({ account, chain: bsc, transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });
      return {
        address: account.address,
        sendTransaction: (tx) => wallet.sendTransaction({ account, chain: bsc, to: tx.to, data: tx.data, value: tx.value, gas: tx.gas }),
        signTypedData: (typedData) => account.signTypedData(typedData as Parameters<PrivateKeyAccount["signTypedData"]>[0]),
      };
    },
    signal: controller.signal,
  };
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2), realDeps()).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`feast-bot: ${errorText(error)}\n`);
      process.exit(1);
    },
  );
}
