import { createHash } from "node:crypto";

import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { main, type CliDeps } from "../src/cli.js";
import type { ChainClient } from "../src/feast.js";
import { ModelCallError } from "../src/model.js";
import { State, type StateIo } from "../src/state.js";
import type { Sender } from "../src/trade.js";
import { BNB_POOL, TEST_KEY, TEST_KEY_ADDRESS, WALLET, fakeChain, fakeFetch, sqrtFor, type FakeChainOptions } from "./fixtures.js";
import { HAIKU_ID, MODELS, POOL_WORDS, answer, fakeModel, launches, reply, trades, wordyPool, type MessageBody } from "./llm-fixtures.js";

/**
 * `llm_manager` end to end, through the CLI: a model that is a fake, a Feast
 * API that is a fake, a chain that is a fake, and everything between them
 * real — the advisor, the packet, the strategy, the risk gate, the trader in
 * a dry run, the state file and the log.
 */

const NOW = Date.UTC(2026, 9, 14, 8, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const KEY = `sk-ant-api03-${"Zx9".repeat(30)}`;
const COIN = BNB_POOL.coin;
const PAYER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const PAYER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;
const OLDER_COIN = "0x4444444444444444444444444444444444444444" as Hex;

function configText(options: { risk?: string; llm?: string; wallet?: string } = {}) {
  return `
[bot]
wallet = "${options.wallet ?? WALLET}"
log_file = "/bot/feast-bot.jsonl"
state_file = "/bot/feast-bot.state.json"
stop_file = "/bot/STOP"
[risk]
max_total_loss_bnb = "0.05"
${options.risk ?? ""}
[llm_manager]
enabled = true
coins = ["${COIN}"]
${options.llm ?? ""}
`;
}

type World = ReturnType<typeof world>;

/**
 * The world for `run`: one configured coin, a pool three hours old with 40
 * holders, a price that rose over the last hour, three trades in it, and a
 * creator with one earlier coin. Its clock moves only when the bot sleeps.
 */
function world(options: {
  config?: string;
  replies?: Parameters<typeof fakeModel>[0];
  models?: Parameters<typeof fakeModel>[1];
  env?: Record<string, string | undefined>;
  chain?: FakeChainOptions;
  createdAgoMin?: number;
  /** Trades that appear after the first read: made at `atMin`, served from `appearsMin` (default: at once). */
  later?: Array<{ atMin: number; side: "buy" | "sell"; quote: bigint; appearsMin?: number }>;
  /** The history comes in two pages, and the second fails the first time it is asked for. */
  flakyHistory?: boolean;
  /** Write a state file before the run: (path, state) for the dry-run file and the live one. */
  seed?: (state: State) => void;
  seedPath?: string;
}) {
  const clock = { now: NOW };
  const flaky = { left: 1 };
  const out: string[] = [];
  const err: string[] = [];
  const logFile: string[] = [];
  const files = new Map<string, string>();
  const stopFiles = new Map<string, string>();
  const stateIo: StateIo = { exists: (p) => files.has(p), read: (p) => files.get(p) ?? "", write: (p, d) => void files.set(p, d) };
  const model = fakeModel(options.replies ?? [reply(answer([{ coin: COIN, action: "hold" }]))], options.models ?? MODELS);
  const createdAt = new Date(NOW - (options.createdAgoMin ?? 180) * 60_000).toISOString();
  const pool = wordyPool(BNB_POOL, { createdAt, holders: 40 });
  const s = (price: number) => sqrtFor(price, true).toString();
  const rows = [
    [NOW_S - 70 * 60, s(0.5e-6), s(0.5e-6), s(0.5e-6), s(0.5e-6), "100000000000000000"],
    [NOW_S - 30 * 60, s(0.8e-6), s(0.8e-6), s(0.8e-6), s(0.8e-6), "100000000000000000"],
    [NOW_S - 10 * 60, s(0.9e-6), s(0.9e-6), s(0.9e-6), s(0.9e-6), "100000000000000000"],
    [NOW_S - 3 * 60, s(1e-6), s(1e-6), s(1e-6), s(1e-6), "100000000000000000"],
  ];
  const history = trades(NOW, [
    { agoMin: 50, side: "buy", payer: PAYER_A, quote: 2n * 10n ** 16n },
    { agoMin: 12, side: "buy", payer: PAYER_B, quote: 3n * 10n ** 16n },
    { agoMin: 3, side: "sell", payer: PAYER_A, quote: 1n * 10n ** 16n },
  ]);
  const later = (options.later ?? []).map((t, i) => ({
    atMin: t.appearsMin ?? t.atMin,
    event: { ...trades(NOW + t.atMin * 60_000, [{ agoMin: 0, side: t.side, payer: PAYER_B, quote: t.quote }])[0]!, cursor: `later${i + 1}` },
  }));
  const fetch = fakeFetch({
    "/api/v1/pools": { body: { chainId: 56, pools: [pool], nextCursor: null } },
    [`/api/v1/pools/${BNB_POOL.poolId}`]: { body: { chainId: 56, pool } },
    "/api/v1/ohlcv": { body: { chainId: 56, rows } },
    "/api/v1/events": (url) => {
      const since = url.searchParams.get("since_cursor");
      if (!since && options.flakyHistory) return { body: { chainId: 56, events: history, nextCursor: "page2" } };
      if (since === "page2" && flaky.left-- > 0) return { status: 503, body: { error: { code: "unavailable", message: "try again" } } };
      if (!since || since === "page2") return { body: { chainId: 56, events: since ? [] : history, nextCursor: null } };
      const seen = since.startsWith("later") ? Number(since.slice(5)) : 0;
      const fresh = later.filter((t, i) => i >= seen && NOW + t.atMin * 60_000 <= clock.now).map((t) => t.event);
      return { body: { chainId: 56, events: fresh, nextCursor: null } };
    },
    "/api/v1/me/launches": {
      body: { chainId: 56, launches: launches([{ address: COIN, holders: 40, trades: 3 }, { address: OLDER_COIN, holders: 212, trades: 5_310 }]) },
    },
  });
  const chain = fakeChain({ spot: 1e-6, ...options.chain });
  const sent: unknown[] = [];
  const makeSender = vi.fn(
    (account: { address: Hex }): Sender => ({
      address: account.address,
      sendTransaction: async (tx) => {
        sent.push(tx);
        return `0x${String(sent.length).padStart(64, "0")}` as Hex;
      },
      signTypedData: async () => `0x${"cd".repeat(65)}` as Hex,
    }),
  );
  if (options.seed) {
    const state = State.load(options.seedPath ?? "/bot/feast-bot.state.dry.json", stateIo);
    options.seed(state);
    state.save();
  }
  const deps: CliDeps = {
    env: options.env ?? { ANTHROPIC_API_KEY: KEY },
    cwd: "/bot",
    readFile: (path) => {
      if (path === "/bot/bot.toml") return options.config ?? configText();
      if (path === "/bot/feast-bot.jsonl") return logFile.join("");
      throw new Error(`ENOENT ${path}`);
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    makeChainClient: () => chain,
    makeSender,
    makeModelClient: async () => model.client,
    fetch,
    stateIo,
    appendLog: (_path, data) => logFile.push(data),
    exists: (path) => stopFiles.has(path),
    writeFile: (path, data) => void stopFiles.set(path, data),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
  };
  const lines = () => out.map((line) => JSON.parse(line) as Record<string, unknown>);
  const events = (name: string) => lines().filter((line) => line.event === name);
  return { clock, deps, out, err, logFile, files, stopFiles, model, fetch, chain, makeSender, sent, lines, events };
}

/** Run until `minutes` have passed on the world's clock (one pass a minute), then stop as Ctrl-C would. */
async function runFor(w: World, minutes: number, args: string[] = []) {
  const controller = new AbortController();
  const end = w.clock.now + minutes * 60_000;
  w.deps.signal = controller.signal;
  w.deps.sleep = async (ms) => {
    w.clock.now += ms;
    if (w.clock.now >= end) controller.abort();
  };
  return main(["run", "--config", "bot.toml", ...args], w.deps);
}

function packetOf(request: MessageBody): Record<string, unknown> {
  const content = request.messages[0]?.content;
  if (typeof content !== "string") throw new Error("the packet is not one string");
  return JSON.parse(content) as Record<string, unknown>;
}

function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (value && typeof value === "object") for (const inner of Object.values(value)) allStrings(inner, out);
  return out;
}

describe("llm_manager: a dry run over fixtures", () => {
  it("asks the model it found, acts on its answer on paper, and records the decision with its reasons", async () => {
    const reason = "price +100% over 60m, 2 unique buyers, buy/sell 5; small entry";
    const w = world({ replies: [reply(answer([{ coin: COIN, action: "buy", amount_bnb: "0.01", reason }]))] });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
    expect(w.err).toEqual([]);

    // The model's id came from the Models API's list.
    expect(w.events("model")[0]).toMatchObject({ id: HAIKU_ID, displayName: "Claude Haiku 5.5" });
    expect(w.model.requests).toHaveLength(1);
    const request = w.model.requests[0]!;
    expect(request.model).toBe(HAIKU_ID);
    expect(request.system).toEqual([expect.objectContaining({ type: "text", cache_control: { type: "ephemeral", ttl: "1h" } })]);
    expect(request.output_config?.format?.type).toBe("json_schema");
    expect(request).not.toHaveProperty("temperature");
    expect(request.messages.at(-1)?.role).toBe("user");

    // The order went through the gate and the trader, on paper.
    const orders = w.events("order");
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ strategy: "llm_manager", side: "buy", sent: false, mode: "dry-run", amountIn: "10000000000000000", reason });

    // One decision record: hash, model, the whole answer with reasons, what the gate let through, tokens.
    const decision = w.logFile.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.event === "decision")!;
    expect(decision.packetHash).toBe(createHash("sha256").update(request.messages[0]!.content as string).digest("hex"));
    expect(decision).toMatchObject({
      level: "info",
      strategy: "llm_manager",
      pass: 1,
      early: false,
      model: HAIKU_ID,
      answer: [{ coin: COIN, action: "buy", amount_bnb: "0.01", fraction: 0, reason }],
      refusal: null,
      intents: [{ coin: COIN, side: "buy", amount: "0.01", approved: true, outcome: "placed", detail: "on paper (dry run)" }],
      usage: { inputTokens: 1_840, outputTokens: 312, cacheReadTokens: 1_402, cacheWriteTokens: 0 },
    });
    // The decision is the pass's last word: after the order it led to.
    const names = w.lines().map((line) => line.event);
    expect(names.indexOf("decision")).toBeGreaterThan(names.indexOf("order"));

    // The paper position is the model's, in the dry run's own file.
    const state = JSON.parse(w.files.get("/bot/feast-bot.state.dry.json")!) as { positions: Record<string, { strategy: string }>; session: { startEquityWei: string } };
    expect(state.positions[COIN]?.strategy).toBe("llm_manager");
    expect(state.session.startEquityWei).toBe(`${10n ** 18n}n`);
    expect(w.makeSender).not.toHaveBeenCalled();
  });

  it("explain prints the decision back in plain words", async () => {
    const w = world({ replies: [reply(answer([{ coin: COIN, action: "buy", amount_bnb: "0.01", reason: "volume up, buyers up" }]))] });
    await main(["run", "--config", "bot.toml", "--once"], w.deps);
    w.out.length = 0;
    expect(await main(["explain", "--config", "bot.toml", "--last", "5"], w.deps)).toBe(0);
    expect(w.out[0]).toMatch(/^2026-10-14 08:00 UTC {2}decision 1, on schedule, claude-haiku-5-5, 1840 tokens in \(1402 from the cache\), 312 out$/);
    expect(w.out[1]).toBe('  0x96b1…cfeed  buy 0.01 BNB: "volume up, buyers up" -> placed (on paper (dry run))');
  });
});

describe("llm_manager: the packet is numbers only", () => {
  it("carries hex ids and UTC times as its only strings, and none of a pool's words", async () => {
    const w = world({});
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
    const request = w.model.requests[0]!;
    const packet = packetOf(request);

    for (const value of allStrings(packet)) expect(value).toMatch(/^(?:0x[0-9a-f]+|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/);
    // Nothing the creator wrote, anywhere in what was sent — packet, prompt or schema.
    const sent = JSON.stringify(request);
    for (const words of [POOL_WORDS.name, POOL_WORDS.symbol, POOL_WORDS.description, POOL_WORDS.metadataCid, POOL_WORDS.links.x, POOL_WORDS.links.website, "An Older Dog Coin", "OLDDOG"]) {
      expect(sent).not.toContain(words);
    }
    expect(sent.toLowerCase()).not.toContain("dog");

    // And the figures are there, as numbers.
    const coin = (packet.coins as Array<Record<string, unknown>>)[0]!;
    expect(coin).toMatchObject({ coin: COIN, poolId: BNB_POOL.poolId, holders: 40, openingCapBinding: false, position: null, poolAgeMin: 180 });
    expect(coin.priceBnb).toBeCloseTo(1e-6, 12);
    const change = coin.priceChangePct as Record<string, number>;
    expect(change["60m"]).toBeCloseTo(100, 2);
    expect(change["15m"]).toBeCloseTo(25, 2);
    expect(change["5m"]).toBeCloseTo(11.1111, 2);
    expect(change["1m"]).toBeCloseTo(0, 6);
    expect(coin.volumeBnb).toEqual({ "1m": 0, "5m": 0.1, "15m": 0.2, "60m": 0.3 });
    expect(coin.trades).toEqual({
      "15m": { count: 2, perMin: 0.133333, buys: 1, sells: 1, uniqueBuyers: 1, buyBnb: 0.03, sellBnb: 0.01, buySellRatio: 3 },
      "60m": { count: 3, perMin: 0.05, buys: 2, sells: 1, uniqueBuyers: 2, buyBnb: 0.05, sellBnb: 0.01, buySellRatio: 5 },
    });
    expect(coin.creatorPriorCoins).toEqual({ count: 1, coins: [{ coin: OLDER_COIN, holders: 212, trades: 5_310 }] });
    expect(packet.account).toMatchObject({ wallet: WALLET, bnbBalance: 1, equityBnb: 1, startEquityBnb: 1, maxTotalLossBnb: 0.05, lossBudgetLeftBnb: 0.05, lastActionAt: null });
  });

  it("stops the call when a field that is not a number, hex or a time slips in", async () => {
    const { assertNumbersOnly, PacketError } = await import("../src/packet.js");
    expect(() => assertNumbersOnly({ coins: [{ coin: COIN, at: "2026-10-14T08:00:00.000Z", n: 1, ok: true, none: null }] })).not.toThrow();
    expect(() => assertNumbersOnly({ coins: [{ name: POOL_WORDS.name }] })).toThrow(PacketError);
    expect(() => assertNumbersOnly({ coins: [{ name: POOL_WORDS.name }] })).toThrow("packet.coins[0].name is a string that is neither hex nor a UTC timestamp");
    expect(() => assertNumbersOnly({ symbol: "WBNB" })).toThrow(PacketError);
    expect(() => assertNumbersOnly({ price: Number.POSITIVE_INFINITY })).toThrow(PacketError);
  });
});

describe("llm_manager: an answer off the schema is no answer", () => {
  const bad: Array<[string, string]> = [
    ["not JSON", "I would buy this one."],
    ["an extra field", JSON.stringify({ decisions: [{ coin: COIN, action: "buy", amount_bnb: "0.01", fraction: 0, reason: "x", leverage: 10 }] })],
    ["a coin not configured", answer([{ coin: "0x5555555555555555555555555555555555555555", action: "buy", amount_bnb: "0.01" }])],
    ["a reason over 200 characters", answer([{ coin: COIN, action: "buy", amount_bnb: "0.01", reason: "r".repeat(201) }])],
    ["a fraction over 1", answer([{ coin: COIN, action: "sell", fraction: 1.5 }])],
    ["an amount that is not a plain decimal", answer([{ coin: COIN, action: "buy", amount_bnb: "1e-2" }])],
    ["the same coin twice", JSON.stringify({ decisions: [JSON.parse(answer([{ coin: COIN, action: "hold" }])).decisions[0], JSON.parse(answer([{ coin: COIN, action: "buy", amount_bnb: "0.01" }])).decisions[0]] })],
  ];
  it.each(bad)("%s: no intent, and a logged refusal", async (_name, text) => {
    const w = world({ replies: [reply(text)] });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
    expect(w.events("order")).toEqual([]);
    expect(w.events("signal")).toEqual([]);
    const [decision] = w.events("decision");
    expect(decision).toMatchObject({ level: "warn", answer: null, intents: [], refusal: { kind: "schema" } });
    expect(typeof (decision!.refusal as { detail: string }).detail).toBe("string");
  });

  it("a refusal or a cut-off reply is no answer either", async () => {
    for (const stopReason of ["refusal", "max_tokens"] as const) {
      const w = world({ replies: [reply(answer([{ coin: COIN, action: "buy", amount_bnb: "0.01" }]), { stopReason })] });
      expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
      expect(w.events("order")).toEqual([]);
      expect(w.events("decision")[0]).toMatchObject({ refusal: { kind: "schema", detail: `the reply stopped with ${stopReason}` } });
    }
  });
});

describe("llm_manager: an API failure is no answer, and still a record", () => {
  it.each([
    ["a timeout", new ModelCallError("timeout", null, "Request timed out.")],
    ["an overloaded API", new ModelCallError("server", 529, "529 overloaded_error")],
    ["a refused key", new ModelCallError("auth", 401, "401 invalid x-api-key")],
  ])("%s: no intent; the decision line says what failed", async (_name, failure) => {
    const w = world({ replies: [failure] });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
    expect(w.events("order")).toEqual([]);
    const [decision] = w.events("decision");
    expect(decision).toMatchObject({ level: "warn", model: HAIKU_ID, answer: null, intents: [], usage: null, refusal: { kind: "model_error", status: failure.status } });
    expect((decision!.refusal as { detail: string }).detail).toContain(failure.kind);
    expect(decision!.packetHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never prints the API key, even when an error carries it", async () => {
    const w = world({ replies: [new ModelCallError("bad_request", 400, `400 key ${KEY} is malformed`)] });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
    const everything = [...w.out, ...w.err, ...w.logFile, ...w.files.values()].join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).toContain("[redacted]");
    expect(JSON.stringify(w.model.requests)).not.toContain(KEY);
  });
});

describe("llm_manager: the total-loss stop", () => {
  it("halts once the session is max_total_loss_bnb down: sells nothing, creates STOP, writes the last line, exits 3", async () => {
    const w = world({
      config: configText({ risk: "" }).replace('max_total_loss_bnb = "0.05"', 'max_total_loss_bnb = "0.005"'),
      replies: [reply(answer([{ coin: COIN, action: "buy", amount_bnb: "0.01" }])), reply(answer([{ coin: COIN, action: "buy", amount_bnb: "0.01" }]))],
    });
    // Pass one: the model buys 0.01 BNB on paper, at a quote worth what it cost.
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
    expect(w.events("order")).toHaveLength(1);
    expect(w.stopFiles.size).toBe(0);

    // Then the pool falls ninety percent: the position would sell for 0.001 BNB.
    w.deps.makeChainClient = () => fakeChain({ spot: 1e-7, feastRate: [10_000_000n, 1n] });
    w.clock.now += 11 * 60_000;
    w.out.length = 0;
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(3);

    // No order, no question to the model, nothing sold: the stop file and the last line.
    expect(w.events("order")).toEqual([]);
    expect(w.events("signal")).toEqual([]);
    expect(w.model.requests).toHaveLength(1);
    expect(w.stopFiles.get("/bot/STOP")).toMatch(/total-loss stop: the session is 0\.009 BNB down \(limit 0\.005\)\. Nothing was sold\./);
    const last = w.lines().at(-1)!;
    expect(last).toMatchObject({ event: "total_loss_stop", level: "error", lossBnb: "0.009", maxTotalLossBnb: "0.005", stopFileState: "created", positionsHeld: 1 });
    const state = JSON.parse(w.files.get("/bot/feast-bot.state.dry.json")!) as { positions: Record<string, unknown> };
    expect(Object.keys(state.positions)).toEqual([COIN]);

    // And after it, nothing: the STOP file holds every later pass.
    w.out.length = 0;
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
    expect(w.events("stopped")).toHaveLength(1);
    expect(w.model.requests).toHaveLength(1);

    // A restart without --new-session keeps the session: the stop fires again at once.
    w.stopFiles.clear();
    w.out.length = 0;
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(3);
    expect(w.model.requests).toHaveLength(1);

    // --new-session measures from here, and the model is asked again.
    w.stopFiles.clear();
    w.out.length = 0;
    expect(await main(["run", "--config", "bot.toml", "--once", "--new-session"], w.deps)).toBe(0);
    expect(w.events("session_start")).toHaveLength(1);
    expect(w.model.requests).toHaveLength(2);
  });

  it("sees what a buy cost in fees and impact before the next order, not a pass later", async () => {
    // A pool so thin that what was just bought would sell for half its cost.
    const base = fakeChain({ spot: 1e-6 });
    const thin: ChainClient = {
      ...base,
      simulateContract: async (args) => {
        const answer = (await base.simulateContract(args)) as { result: [bigint, bigint] };
        const selling = String((args.args as [Hex[]])[0][0]).toLowerCase() === COIN;
        return selling ? { result: [answer.result[0] / 2n, answer.result[1]] } : answer;
      },
    };
    const w = world({ replies: [reply(answer([{ coin: COIN, action: "buy", amount_bnb: "0.2" }]))] });
    w.deps.makeChainClient = () => thin;
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(3);
    // One order, then the stop, in the same pass: the decision's record, then the last line.
    expect(w.events("order")).toHaveLength(1);
    const names = w.lines().map((line) => line.event);
    expect(names.slice(-2)).toEqual(["decision", "total_loss_stop"]);
    expect(w.lines().at(-1)).toMatchObject({ lossBnb: "0.1" });
  });

  it("sells nothing in the pass the stop fires, not even another strategy's exit", async () => {
    const config = configText().replace("[llm_manager]", "[launch_momentum]\ntime_stop_min = 1\n[llm_manager]");
    const w = world({
      config,
      seed: (state) => {
        state.recordBuy({ poolId: BNB_POOL.poolId, coin: COIN, strategy: "launch_momentum", coins: 10n ** 22n, costWei: 10n ** 17n, at: NOW - 3_600_000 });
        state.startSession({ at: NOW - 3_600_000, cashWei: 9n * 10n ** 17n });
      },
      // The position, bought for 0.1 BNB, would sell for 0.001: 0.099 BNB down, past 0.05.
      chain: { feastRate: [10_000_000n, 1n] },
    });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(3);
    expect(w.events("signal")).toEqual([]);
    expect(w.events("order")).toEqual([]);
    expect(w.lines().at(-1)).toMatchObject({ event: "total_loss_stop", lossBnb: "0.099", positionsHeld: 1 });
  });

  it("books a live sale the wallet could not cover in full as closing the whole position", async () => {
    const w = world({
      config: configText({ wallet: "" }),
      env: { ANTHROPIC_API_KEY: KEY, BOT_PRIVATE_KEY: TEST_KEY },
      replies: [reply(answer([{ coin: COIN, action: "sell", fraction: 0.5 }]))],
      seedPath: "/bot/feast-bot.state.json",
      seed: (state) => {
        state.startSession({ at: NOW - 60_000, cashWei: 10n ** 18n });
        state.recordBuy({ poolId: BNB_POOL.poolId, coin: COIN, strategy: "llm_manager", coins: 1000n * 10n ** 18n, costWei: 10n ** 15n, at: NOW - 60_000 });
      },
      // The book says 1,000 coins; the wallet holds 300.
      chain: { coinBalance: 300n * 10n ** 18n, allowance: 10n ** 30n },
    });
    expect(await main(["run", "--config", "bot.toml", "--once", "--live"], w.deps)).toBe(0);
    expect(w.makeSender.mock.calls[0]![0].address).toBe(TEST_KEY_ADDRESS);
    expect(w.events("order").map((o) => [o.side, o.amountIn])).toEqual([["sell", "300000000000000000000"]]);
    const state = JSON.parse(w.files.get("/bot/feast-bot.state.json")!) as { positions: Record<string, unknown> };
    expect(state.positions).toEqual({});
  });

  it("is refused at start when [llm_manager] has no total-loss stop", async () => {
    const w = world({ config: configText().replace('max_total_loss_bnb = "0.05"', 'max_total_loss_bnb = "0"') });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(2);
    expect(w.err[0]).toMatch(/max_total_loss_bnb is 0; the total-loss stop is the model's only limit/);
    expect(w.model.requests).toEqual([]);
  });
});

describe("llm_manager: the model's orders answer to the total-loss stop alone", () => {
  const big = reply(answer([{ coin: COIN, action: "buy", amount_bnb: "0.04" }]));
  it("by default every other [risk] rule is off for them", async () => {
    const w = world({ config: configText({ risk: 'max_position_bnb = "0.01"\nmax_orders_per_hour = 1' }), replies: [big] });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
    expect(w.events("order_blocked")).toEqual([]);
    expect(w.events("order")).toHaveLength(1);
    expect(w.events("start")[0]).toMatchObject({ limits: { maxTotalLossBnb: "0.05", llmManager: expect.stringMatching(/every other limit above is off/) } });
  });

  it("with only_total_loss = false, they keep every rule", async () => {
    const w = world({ config: configText({ risk: 'max_position_bnb = "0.01"\nonly_total_loss = false' }), replies: [big] });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
    expect(w.events("order")).toEqual([]);
    expect(w.events("order_blocked")[0]).toMatchObject({ strategy: "llm_manager", rule: "max_position" });
    expect(w.events("decision")[0]).toMatchObject({ intents: [{ approved: false, outcome: "blocked", detail: expect.stringMatching(/^max_position: /) }] });
  });

  it("a buy larger than the wallet's BNB is not placed, and the record says why", async () => {
    const w = world({ replies: [reply(answer([{ coin: COIN, action: "buy", amount_bnb: "2" }]))] });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
    expect(w.events("order")).toEqual([]);
    expect(w.events("decision")[0]).toMatchObject({ intents: [], skipped: [{ coin: COIN, action: "buy", why: "more BNB than the wallet can spend" }] });
  });
});

describe("llm_manager: start", () => {
  it("refuses to start without ANTHROPIC_API_KEY, and never reads it from the config", async () => {
    const w = world({ env: {} });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(2);
    expect(w.err[0]).toMatch(/needs ANTHROPIC_API_KEY in the environment/);

    const leaky = world({ config: `${configText()}api_key = "${KEY}"\n` });
    expect(await main(["run", "--config", "bot.toml", "--once"], leaky.deps)).toBe(2);
    expect(leaky.err.join("\n")).toMatch(/never put a private key/);
    expect(leaky.err.join("\n")).not.toContain(KEY);
  });

  it("fails loudly when the key's model list has no Claude Haiku 5.5, naming what it has", async () => {
    const w = world({ models: MODELS.filter((model) => model.id !== HAIKU_ID) });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(2);
    expect(w.err[0]).toMatch(/^no Claude Haiku 5\.5 among the 2 models this API key can use; the Haiku models it can use: claude-haiku-4-5-20251001 \(Claude Haiku 4\.5\)/);
    expect(w.model.requests).toEqual([]);
    expect(w.fetch.urls).toEqual([]);
  });

  it("a dry run needs the wallet it decides for", async () => {
    const w = world({ config: configText({ wallet: "" }) });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(2);
    expect(w.err[0]).toMatch(/a dry run needs \[bot\] wallet/);
  });
});

describe("llm_manager: cadence", () => {
  it("decides every poll_minutes, and only then", async () => {
    const w = world({});
    expect(await runFor(w, 21)).toBe(0);
    expect(w.model.requests).toHaveLength(3);
    expect(w.events("decision").map((d) => [d.ts, d.early])).toEqual([
      ["2026-10-14T08:00:00.000Z", false],
      ["2026-10-14T08:10:00.000Z", false],
      ["2026-10-14T08:20:00.000Z", false],
    ]);
  });

  it("a large trade brings a decision forward, never sooner than five minutes after the last", async () => {
    const w = world({ later: [{ atMin: 2, side: "buy", quote: 10n ** 17n }] });
    expect(await runFor(w, 11)).toBe(0);
    const decisions = w.events("decision");
    expect(decisions.map((d) => [d.ts, d.early])).toEqual([
      ["2026-10-14T08:00:00.000Z", false],
      ["2026-10-14T08:05:00.000Z", true],
    ]);
    expect(decisions[1]!.triggers).toEqual([{ kind: "trade", coin: COIN, bnb: 0.1 }]);
  });

  it("a large trade the index serves late, after a decision, still brings the next one forward", async () => {
    // Made at 07:59:30, before the 08:00 decision; served only at 08:02.
    const w = world({ later: [{ atMin: -0.5, appearsMin: 2, side: "sell", quote: 2n * 10n ** 17n }] });
    expect(await runFor(w, 6)).toBe(0);
    expect(w.events("decision").map((d) => [d.ts, d.early, d.triggers])).toEqual([
      ["2026-10-14T08:00:00.000Z", false, []],
      ["2026-10-14T08:05:00.000Z", true, [{ kind: "trade", coin: COIN, bnb: 0.2 }]],
    ]);
  });

  it("a history page that fails keeps the pages before it, and the next pass reads on", async () => {
    const w = world({ flakyHistory: true });
    expect(await runFor(w, 11)).toBe(0);
    expect(w.events("llm_watch_failed")).toHaveLength(1);
    const [first, second] = w.model.requests.map((request) => (packetOf(request).coins as Array<{ trades: { "60m": { count: number } } | null }>)[0]!);
    // Not yet caught up: not known, rather than a partial count.
    expect(first!.trades).toBeNull();
    // The three trades of the page that came before the failure are all there.
    expect(second!.trades?.["60m"].count).toBe(3);
  });

  it("a coin listed twice, by address and by pool id, is decided on once", async () => {
    const w = world({ config: configText().replace(`coins = ["${COIN}"]`, `coins = ["${COIN}", "${BNB_POOL.poolId}"]`) });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
    expect(w.events("llm_coin_repeated")).toHaveLength(1);
    expect(w.model.requests[0]!.output_config?.format?.schema).toMatchObject({
      properties: { decisions: { items: { properties: { coin: { enum: [COIN] } } } } },
    });
    expect(w.events("decision")[0]).toMatchObject({ refusal: null });
  });

  it("a trade under event_trade_bnb does not", async () => {
    const w = world({ later: [{ atMin: 2, side: "buy", quote: 10n ** 16n }] });
    expect(await runFor(w, 9)).toBe(0);
    expect(w.model.requests).toHaveLength(1);
  });

  it("a young pool is decided on every five minutes while it is younger than event_new_pool_minutes, then every poll_minutes", async () => {
    const w = world({ createdAgoMin: 2, config: configText({ llm: "event_new_pool_minutes = 12" }) });
    expect(await runFor(w, 26)).toBe(0);
    const decisions = w.events("decision");
    expect(decisions.map((d) => [d.ts, d.early])).toEqual([
      ["2026-10-14T08:00:00.000Z", false],
      ["2026-10-14T08:05:00.000Z", true],
      // Still young at 08:09, so the next one comes five minutes on, not ten.
      ["2026-10-14T08:10:00.000Z", true],
      // Twelve minutes old at 08:10: back to every ten minutes.
      ["2026-10-14T08:20:00.000Z", false],
    ]);
    expect(decisions[1]!.triggers).toEqual([{ kind: "new_pool", coin: COIN, ageMin: 7 }]);
  });
});
