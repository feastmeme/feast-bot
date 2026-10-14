/**
 * THE KIT BUILDS THE SAME BYTES AS THE SITE.
 *
 * When this folder sits inside the Feast repository, these tests load the
 * app's own helpers (`src/lib/trade/universal-router.ts`,
 * `src/app/coin/[address]/links.ts`, the refusal ABIs) and the app's chain-56
 * address book, and hold the kit equal to them: the same inputs give the same
 * calldata, byte for byte; the same pool key gives the same pool id; every
 * error the app can decode, the kit can decode; every address and route
 * matches. Copied out of the repository, the folder has no app to compare
 * with, and these tests skip themselves.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { toFunctionSelector, type Abi, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { ERRORS } from "../src/abi.js";
import { CONTRACTS, QUOTE_ROUTES } from "../src/book.js";
import { ChainReader } from "../src/feast.js";
import { Logger } from "../src/log.js";
import { Risk } from "../src/risk.js";
import * as kit from "../src/router.js";
import { Trader } from "../src/trade.js";
import { BNB_POOL, OTHER, ROUTED_POOL, fakeChain } from "./fixtures.js";

const app = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const APP_PRESENT = existsSync(app("src/lib/trade/universal-router.ts"));

type AppRouter = Pick<typeof kit, "buyCommands" | "sellCommands" | "encodeExecute" | "poolIdOf" | "permitSingleTypedData">;

/** A path the compiler does not follow: the app is not part of this package. */
async function load<T>(path: string): Promise<T> {
  const url = new URL(`../../../${path}`, import.meta.url).href;
  return (await import(/* @vite-ignore */ url)) as T;
}

const BNB = 10n ** 18n;
const DEADLINE = 1_791_871_800n;
const SIGNATURE = `0x${"5a".repeat(65)}` as Hex;

describe.skipIf(!APP_PRESENT)("the kit against the Feast app's own helpers", () => {
  const usdtRoute = QUOTE_ROUTES[ROUTED_POOL.quote.toLowerCase()]!;

  const buys = [
    { name: "a wrapped-BNB pool, nobody referring", pool: BNB_POOL, hops: [], referrer: null, amountIn: BNB / 100n, minOut: 123_456_789n * BNB },
    { name: "a pool reached through USDT, with a referrer", pool: ROUTED_POOL, hops: usdtRoute.buy, referrer: OTHER, amountIn: 7n * BNB, minOut: 1n },
  ] as const;

  it.each(buys)("buy calldata is byte-identical: $name", async ({ pool, hops, referrer, amountIn, minOut }) => {
    const appRouter = await load<AppRouter>("src/lib/trade/universal-router.ts");
    const links = await load<{ hookDataFor: (r: string | null) => string }>("src/app/coin/[address]/links.ts");
    const input = {
      wrappedNative: CONTRACTS.wrappedNative,
      quote: pool.quote,
      coin: pool.coin,
      hops: [...hops],
      poolKey: pool.key,
      amountIn,
      minOut,
      hookData: links.hookDataFor(referrer) as Hex,
    };
    expect(kit.hookDataFor(referrer)).toBe(input.hookData);
    expect(kit.encodeExecute(kit.buyCommands(input), DEADLINE)).toBe(appRouter.encodeExecute(appRouter.buyCommands(input), DEADLINE));
  });

  const sells = [
    { name: "a wrapped-BNB pool, no permit", pool: BNB_POOL, hops: [], permit: false },
    { name: "a pool reached through USDT, with a permit riding inside", pool: ROUTED_POOL, hops: usdtRoute.sell, permit: true },
  ] as const;

  it.each(sells)("sale calldata is byte-identical: $name", async ({ pool, hops, permit }) => {
    const appRouter = await load<AppRouter>("src/lib/trade/universal-router.ts");
    const single: kit.PermitSingle = {
      details: { token: pool.coin, amount: kit.MAX_UINT160, expiration: DEADLINE + 2_592_000n, nonce: 4n },
      spender: CONTRACTS.router,
      sigDeadline: DEADLINE,
    };
    const input = {
      wrappedNative: CONTRACTS.wrappedNative,
      quote: pool.quote,
      coin: pool.coin,
      hops: [...hops],
      poolKey: pool.key,
      amountIn: 2_500_000n * BNB + 17n,
      minOut: BNB / 3n,
      hookData: kit.hookDataFor(OTHER),
      permit: permit ? { permit: single, signature: SIGNATURE } : null,
    };
    expect(kit.encodeExecute(kit.sellCommands(input), DEADLINE)).toBe(appRouter.encodeExecute(appRouter.sellCommands(input), DEADLINE));
    expect(kit.permitSingleTypedData({ chainId: 56, permit2: CONTRACTS.permit2, permit: single })).toEqual(
      appRouter.permitSingleTypedData({ chainId: 56, permit2: CONTRACTS.permit2, permit: single }),
    );
  });

  it("the trader's own planned buy is the calldata the app's helper builds from the same quote", async () => {
    const appRouter = await load<AppRouter>("src/lib/trade/universal-router.ts");
    const links = await load<{ hookDataFor: (r: string | null) => string }>("src/app/coin/[address]/links.ts");
    const trader = new Trader({
      reader: new ChainReader(fakeChain()),
      risk: new Risk({ maxPositionWei: BNB, dailyLossCapWei: BNB, maxSlippageBps: 300, minCooldownSeconds: 0, maxOrdersPerHour: 60, gasReserveWei: 0n, maxTotalLossWei: 0n, onlyTotalLoss: true, stopFile: "/nonexistent/STOP" }),
      log: new Logger({ out: () => {}, file: null }),
      wallet: null,
      sender: null,
      referrer: OTHER,
      maxSlippageBps: 300,
    });
    const plan = await trader.plan({ side: "buy", strategy: "manual", poolId: ROUTED_POOL.poolId, coin: ROUTED_POOL.coin, amountWei: BNB / 50n, reason: "parity" });
    const expected = appRouter.encodeExecute(
      appRouter.buyCommands({
        wrappedNative: CONTRACTS.wrappedNative,
        quote: ROUTED_POOL.quote,
        coin: ROUTED_POOL.coin,
        hops: usdtRoute.buy,
        poolKey: ROUTED_POOL.key,
        amountIn: BNB / 50n,
        minOut: plan.minOut,
        hookData: links.hookDataFor(OTHER) as Hex,
      }),
      plan.deadline,
    );
    expect(plan.steps[0]!.data).toBe(expected);
  });

  it("the same pool key hashes to the same pool id, and to the id the public API serves", async () => {
    const appRouter = await load<AppRouter>("src/lib/trade/universal-router.ts");
    for (const pool of [BNB_POOL, ROUTED_POOL]) {
      expect(kit.poolIdOf(pool.key)).toBe(appRouter.poolIdOf(pool.key));
      expect(kit.poolIdOf(pool.key)).toBe(pool.poolId);
    }
  });

  it("the referrer's hookData matches the app's for every shape of input", async () => {
    const links = await load<{ hookDataFor: (r: string | null) => string }>("src/app/coin/[address]/links.ts");
    for (const input of [null, "", "0x0000000000000000000000000000000000000000", OTHER, OTHER.toUpperCase().replace("0X", "0x"), "0x12", "not an address"]) {
      expect(kit.hookDataFor(input), String(input)).toBe(links.hookDataFor(input));
    }
  });

  it("decodes every error the app's trade path can decode", async () => {
    const { REFUSAL_ABI } = await load<{ REFUSAL_ABI: Abi }>("src/lib/chain/refusal-abi.ts");
    const tradeAbi = await load<{ universalRouterAbi: Abi; permit2Abi: Abi; mixedQuoterAbi: Abi }>("src/lib/trade/abi.ts");
    const signature = (entry: Abi[number]) =>
      entry.type === "error" ? `${entry.name}(${entry.inputs.map((input) => input.type).join(",")})` : null;
    // `infinity-refusal.ts` builds its set exactly so: the app's refusals, the venue's, and WrappedError.
    const appSet = new Set(
      [...REFUSAL_ABI, ...tradeAbi.universalRouterAbi, ...tradeAbi.permit2Abi, ...tradeAbi.mixedQuoterAbi]
        .map(signature)
        .filter((s): s is string => s !== null),
    );
    appSet.add("WrappedError(address,bytes4,bytes,bytes)");
    const kitSet = new Set(ERRORS.map(signature).filter((s): s is string => s !== null));
    expect([...appSet].filter((s) => !kitSet.has(s))).toEqual([]);
    expect([...kitSet].filter((s) => !appSet.has(s))).toEqual([]);
    expect(toFunctionSelector("function execute(bytes,bytes[],uint256)")).toBe("0x3593564c");
  });

  it("every contract address and every quote route is the app's chain-56 book", () => {
    const book = JSON.parse(readFileSync(app("sandbox/mainnet/addresses.json"), "utf8")) as {
      chainId: number;
      factory: string;
      hook: string;
      poolManager: string;
      infinityRouter: string;
      permit2: string;
      mixedQuoter: string;
      wrappedNative: string;
      symbols: string[];
      quotes: Record<string, { address: string; buyTokens: string[]; buyFees: number[]; sellTokens: string[]; sellFees: number[] }>;
    };
    expect(book.chainId).toBe(56);
    expect(CONTRACTS).toEqual({
      factory: book.factory,
      hook: book.hook,
      poolManager: book.poolManager,
      router: book.infinityRouter,
      permit2: book.permit2,
      mixedQuoter: book.mixedQuoter,
      wrappedNative: book.wrappedNative,
    });
    // `buildChainConfig` turns each listed quote into hops this way, and adds wrapped BNB with none.
    const hops = (tokens: string[], fees: number[]) => tokens.map((token, i) => ({ tokenOut: token, fee: fees[i] }));
    const expected: Record<string, { buy: unknown[]; sell: unknown[] }> = {};
    for (const symbol of book.symbols) {
      const quote = book.quotes[symbol];
      if (!quote) continue;
      expected[quote.address.toLowerCase()] = { buy: hops(quote.buyTokens, quote.buyFees), sell: hops(quote.sellTokens, quote.sellFees) };
    }
    expected[book.wrappedNative.toLowerCase()] = { buy: [], sell: [] };
    expect(QUOTE_ROUTES).toEqual(expected);
  });
});

describe("the hook's fee", () => {
  it("is 1% of what reaches the pool — amountIn / 101 — the figure the API documents for 0.01 BNB", async () => {
    const trader = new Trader({
      reader: new ChainReader(fakeChain()),
      risk: new Risk({ maxPositionWei: BNB, dailyLossCapWei: BNB, maxSlippageBps: 300, minCooldownSeconds: 0, maxOrdersPerHour: 60, gasReserveWei: 0n, maxTotalLossWei: 0n, onlyTotalLoss: true, stopFile: "/nonexistent/STOP" }),
      log: new Logger({ out: () => {}, file: null }),
      wallet: null,
      sender: null,
      referrer: null,
      maxSlippageBps: 300,
    });
    const plan = await trader.plan({ side: "buy", strategy: "manual", poolId: BNB_POOL.poolId, coin: BNB_POOL.coin, amountWei: BNB / 100n, reason: "fee" });
    expect(plan.quote.fee).toBe(99_009_900_990_099n);
  });
});
