import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { main, type CliDeps } from "../src/cli.js";
import { loadKey as realLoadKey } from "../src/secret.js";
import type { StateIo } from "../src/state.js";
import type { Sender } from "../src/trade.js";
import { BNB_POOL, ROUTED_POOL, TEST_KEY, TEST_KEY_ADDRESS, WALLET, apiPool, fakeChain, fakeFetch, sqrtFor, type FakeChainOptions } from "./fixtures.js";

const NOW = Date.UTC(2026, 9, 13, 6, 0, 0);
const NOW_S = Math.floor(NOW / 1000);

/** A config that turns both strategies on, against the two fixture pools. */
function configText(wallet: string) {
  return `
[bot]
wallet = "${wallet}"
log_file = "/bot/feast-bot.jsonl"
state_file = "/bot/feast-bot.state.json"
stop_file = "/bot/STOP"
[mean_reversion]
enabled = true
pools = ["${ROUTED_POOL.poolId}"]
[launch_momentum]
enabled = true
min_holders = 5
`;
}

/**
 * The world for one `run --once`: the routed pool trades 20% above where the
 * chain says its price is now (so mean reversion buys), and the wrapped-BNB
 * pool opened ten minutes ago with ten holders and two trades a minute (so
 * launch momentum buys).
 */
function world(options: { config: string; stop?: boolean; env?: Record<string, string | undefined>; chain?: FakeChainOptions }) {
  const out: string[] = [];
  const err: string[] = [];
  const logFile: string[] = [];
  const files = new Map<string, string>();
  const stateIo: StateIo = { exists: (p) => files.has(p), read: (p) => files.get(p) ?? "", write: (p, d) => void files.set(p, d) };
  const chain = fakeChain({ spot: 1e-6, ...options.chain });
  const sent: unknown[] = [];
  const makeSender = vi.fn((account: { address: Hex }): Sender => ({
    address: account.address,
    sendTransaction: vi.fn(async (tx) => {
      sent.push(tx);
      return `0x${String(sent.length).padStart(64, "0")}` as Hex;
    }),
    signTypedData: vi.fn(async () => `0x${"cd".repeat(65)}` as Hex),
  }));
  const loadKey = vi.fn((...args: Parameters<NonNullable<CliDeps["loadKey"]>>) => realLoadKey(...args));
  const candle = (ago: number) => {
    const s = sqrtFor(1.2e-6, false).toString();
    return [NOW_S - ago * 60, s, s, s, s, "1000000000000000000"];
  };
  const fetch = fakeFetch({
    "/api/v1/pools": {
      body: {
        chainId: 56,
        pools: [
          apiPool(BNB_POOL, { createdAt: new Date(NOW - 10 * 60_000).toISOString(), holders: 10 }),
          apiPool(ROUTED_POOL, { createdAt: "2026-10-11T14:16:35.000Z", holders: 8 }),
        ],
        nextCursor: null,
      },
    },
    "/api/v1/ohlcv": { body: { chainId: 56, rows: [candle(30), candle(20), candle(10)] } },
    "/api/v1/events": {
      body: {
        chainId: 56,
        events: Array.from({ length: 20 }, (_, i) => ({ type: "trade", at: new Date(NOW - 9 * 60_000 + i * 25_000).toISOString() })),
        nextCursor: null,
      },
    },
  });
  const deps: CliDeps = {
    env: options.env ?? {},
    cwd: "/bot",
    readFile: (path) => {
      if (path === "/bot/bot.toml") return options.config;
      throw new Error(`ENOENT ${path}`);
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    makeChainClient: () => chain,
    makeSender,
    fetch,
    loadKey,
    stateIo,
    appendLog: (_path, data) => logFile.push(data),
    exists: (path) => options.stop === true && path === "/bot/STOP",
    now: () => NOW,
    sleep: async () => {},
  };
  const orders = () => out.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "order");
  return { deps, out, err, logFile, files, chain, fetch, sent, makeSender, loadKey, orders };
}

describe("feast-bot run", () => {
  it("is a dry run by default: both strategies place their orders on paper, and nothing can send", async () => {
    const w = world({ config: configText(WALLET) });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
    expect(w.err).toEqual([]);
    const orders = w.orders();
    expect(orders.map((o) => [o.strategy, o.side, o.sent, o.mode])).toEqual([
      ["mean_reversion", "buy", false, "dry-run"],
      ["launch_momentum", "buy", false, "dry-run"],
    ]);
    for (const order of orders) {
      expect(order.steps).toEqual([expect.objectContaining({ stage: "trade", data: expect.stringMatching(/^0x3593564c/) })]);
      expect(typeof order.expectedSlippageBps).toBe("number");
      expect(order.quote).toEqual(expect.objectContaining({ out: expect.any(String) }));
    }
    // No key was read and nothing that can send was built.
    expect(w.loadKey).not.toHaveBeenCalled();
    expect(w.makeSender).not.toHaveBeenCalled();
    expect(w.sent).toEqual([]);
    // Paper positions go to the dry-run file, never the live one.
    expect([...w.files.keys()]).toEqual(["/bot/feast-bot.state.dry.json"]);
    // Structured logs on stdout and in the JSONL file, line for line.
    expect(w.logFile.join("")).toBe(w.out.map((line) => `${line}\n`).join(""));
  });

  it("sends only with --live, from the key's wallet, and never prints the key", async () => {
    const w = world({ config: configText(""), env: { BOT_PRIVATE_KEY: TEST_KEY } });
    expect(await main(["run", "--config", "bot.toml", "--once", "--live"], w.deps)).toBe(0);
    expect(w.err).toEqual([]);
    expect(w.makeSender).toHaveBeenCalledTimes(1);
    expect(w.makeSender.mock.calls[0]![0].address).toBe(TEST_KEY_ADDRESS);
    expect(w.sent).toHaveLength(2);
    const everything = [...w.out, ...w.logFile, ...w.files.values()].join("\n").toLowerCase();
    expect(everything).not.toContain(TEST_KEY.slice(2).toLowerCase());
    expect(everything).not.toContain(TEST_KEY.slice(2, 20).toLowerCase());
    expect([...w.files.keys()]).toEqual(["/bot/feast-bot.state.json"]);
  });

  it("counts a live order that reverted after going out, books its gas, and does not send it again next pass", async () => {
    const w = world({ config: configText(""), env: { BOT_PRIVATE_KEY: TEST_KEY }, chain: { receipt: "reverted" } });
    expect(await main(["run", "--config", "bot.toml", "--once", "--live"], w.deps)).toBe(0);
    expect(w.sent).toHaveLength(2);
    w.deps.env = { BOT_PRIVATE_KEY: TEST_KEY };
    expect(await main(["run", "--config", "bot.toml", "--once", "--live"], w.deps)).toBe(0);
    // The cooldown and launch momentum's one entry per pool both hold: nothing new went out.
    expect(w.sent).toHaveLength(2);
    const state = JSON.parse(w.files.get("/bot/feast-bot.state.json")!) as {
      orders: unknown[];
      realized: Array<{ pnlWei: string }>;
      positions: Record<string, unknown>;
    };
    expect(state.orders).toHaveLength(2);
    expect(state.realized.map((r) => r.pnlWei)).toEqual(["-180000000000000n", "-180000000000000n"]);
    expect(state.positions).toEqual({});
    expect(w.out.filter((line) => line.includes('"event":"order_failed_after_send"'))).toHaveLength(2);
  });

  it("books a live buy whose receipt never came at its floor, so it is still managed and sold", async () => {
    const w = world({ config: configText(""), env: { BOT_PRIVATE_KEY: TEST_KEY }, chain: { receipt: "timeout" } });
    expect(await main(["run", "--config", "bot.toml", "--once", "--live"], w.deps)).toBe(0);
    const state = JSON.parse(w.files.get("/bot/feast-bot.state.json")!) as { positions: Record<string, { coins: string }> };
    expect(Object.keys(state.positions).sort()).toEqual([BNB_POOL.coin, ROUTED_POOL.coin].sort());
    const orders = w.out.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "order");
    for (const order of orders) expect(state.positions[order.coin as string]?.coins).toBe(`${order.minOut as string}n`);
  });

  it("does nothing at all while the STOP file exists", async () => {
    const w = world({ config: configText(WALLET), stop: true });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(0);
    expect(w.fetch.urls).toEqual([]);
    expect(w.orders()).toEqual([]);
    expect(w.out.some((line) => line.includes('"event":"stopped"'))).toBe(true);
  });

  it("refuses to start without a config, or with a key in it, without echoing the key", async () => {
    const missing = world({ config: "" });
    expect(await main(["run"], missing.deps)).toBe(2);
    expect(missing.err[0]).toMatch(/--config/);

    const key = `0x${"9f".repeat(32)}`;
    const leaky = world({ config: `[bot]\nprivate_key = "${key}"` });
    expect(await main(["run", "--config", "bot.toml"], leaky.deps)).toBe(2);
    expect(leaky.err.join("\n")).toMatch(/never put a private key/);
    expect(leaky.err.join("\n")).not.toContain("9f9f9f9f");
  });

  it("refuses --live without a key, and refuses a key that is not the configured wallet", async () => {
    const none = world({ config: configText("") });
    expect(await main(["run", "--config", "bot.toml", "--live", "--once"], none.deps)).toBe(2);
    expect(none.err[0]).toMatch(/needs a key/);
    expect(none.sent).toEqual([]);

    const wrong = world({ config: configText(WALLET), env: { BOT_PRIVATE_KEY: TEST_KEY } });
    expect(await main(["run", "--config", "bot.toml", "--live", "--once"], wrong.deps)).toBe(2);
    expect(wrong.err[0]).toMatch(/refusing to trade from a wallet you did not name/);
    expect(wrong.makeSender).not.toHaveBeenCalled();
  });

  it("refuses an RPC that serves another chain", async () => {
    const w = world({ config: configText(WALLET) });
    w.deps.makeChainClient = () => fakeChain({ chainId: 97 });
    expect(await main(["run", "--config", "bot.toml", "--once"], w.deps)).toBe(2);
    expect(w.err[0]).toMatch(/not BNB Smart Chain/);
  });
});

describe("feast-bot quote", () => {
  it("prints the quote, the expected slippage and the calldata, and checks the Feast leg against the API", async () => {
    const w = world({ config: configText(WALLET) });
    w.deps.fetch = fakeFetch({
      [`/api/v1/pools/${BNB_POOL.poolId}`]: { body: { chainId: 56, pool: apiPool(BNB_POOL) } },
      "/api/v1/quote": (url) => ({
        body: {
          chainId: 56,
          amountIn: url.searchParams.get("amountIn"),
          amountOut: (BigInt(url.searchParams.get("amountIn") ?? "0") * 1_000_000n).toString(),
          refusal: null,
          quotedAtBlock: 1,
          quotedVia: "clQuoter:0x",
        },
      }),
    });
    expect(await main(["quote", BNB_POOL.poolId, "0.01"], w.deps)).toBe(0);
    const printed = JSON.parse(w.out.join("\n"));
    expect(printed).toMatchObject({
      sent: false,
      side: "buy",
      amountIn: "10000000000000000",
      readable: { amountIn: "0.01", unit: "BNB in, coins out" },
      apiCheck: { endpoint: "/api/v1/quote", agrees: true },
    });
    expect(printed.steps[0].data).toMatch(/^0x3593564c/);
    expect(w.makeSender).not.toHaveBeenCalled();
  });

  it("refuses a malformed pool id or amount", async () => {
    const w = world({ config: "" });
    expect(await main(["quote", "0x12", "0.01"], w.deps)).toBe(2);
    expect(await main(["quote", BNB_POOL.poolId, "1e-3"], w.deps)).toBe(2);
  });
});

describe("feast-bot pools", () => {
  it("lists pool ids without names", async () => {
    const w = world({ config: "" });
    expect(await main(["pools", "--limit", "5"], w.deps)).toBe(0);
    expect(w.out[0]).toBe("pool id\tcoin\topened (UTC)\tholders\ttrades 24h\topening cap");
    expect(w.out[1]).toContain(BNB_POOL.poolId);
    expect(w.out.at(-1)).toMatch(/^2 pools\./);
  });
});
