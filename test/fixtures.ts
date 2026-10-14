/**
 * Test doubles. No test touches the network: the chain is `fakeChain`, the
 * API is `fakeFetch`, and both record what they were asked.
 *
 * The two pool keys are real BNB Chain pools as the public feed served them
 * on 2026-10-13: one paired with wrapped BNB (no hops), one with a quote asset
 * reached through USDT (two hops each way).
 */

import { BaseError, encodeErrorResult, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { ERRORS } from "../src/abi.js";
import type { ChainClient } from "../src/feast.js";
import { poolIdOf, type PoolKey } from "../src/router.js";

export const BNB_POOL = {
  poolId: "0xa83f080ba2091ac3c25815389abd40ef85c9ef2cf1393bcdcb7867cd76d5e278" as Hex,
  coin: "0x96b1188367ed76d1a81d46407e226462314cfeed" as Hex,
  quote: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as Hex,
  key: {
    currency0: "0x96B1188367ED76D1A81d46407E226462314CfEed",
    currency1: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    hooks: "0xABFB955e4582f49dc741DCf5354fbB0edaD0A7c5",
    poolManager: "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b",
    fee: 100,
    parameters: "0x0000000000000000000000000000000000000000000000000000000000c80cc1",
  } as PoolKey,
};

export const ROUTED_POOL = {
  poolId: "0x5bf998f6e9696f4f3e9330ea644ccf874b968a2167e217d9c10885afce4e9462" as Hex,
  coin: "0xd9c78728dfb7595955e72c2c576de6a7b7eafeed" as Hex,
  quote: "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A" as Hex,
  key: {
    currency0: "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A",
    currency1: "0xD9c78728DFb7595955E72C2C576De6A7b7EAFEEd",
    hooks: "0xABFB955e4582f49dc741DCf5354fbB0edaD0A7c5",
    poolManager: "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b",
    fee: 100,
    parameters: "0x0000000000000000000000000000000000000000000000000000000000c80cc1",
  } as PoolKey,
};

export const WALLET = "0x1111111111111111111111111111111111111111" as Hex;
export const OTHER = "0x2222222222222222222222222222222222222222" as Hex;
/** A key made fresh for each test run: no key is ever written into this folder. */
export const TEST_KEY = generatePrivateKey();
export const TEST_KEY_ADDRESS = privateKeyToAccount(TEST_KEY).address;

/** sqrtPriceX96 for a price in quote per coin, in the pool's orientation. */
export function sqrtFor(price: number, coinIsCurrency0: boolean): bigint {
  const p = coinIsCurrency0 ? price : 1 / price;
  return BigInt(Math.round(Math.sqrt(p) * 2 ** 96));
}

/** A revert the way viem carries one up from an RPC: bytes on a nested `data`. */
export function revertWith(data: Hex): Error {
  const inner = Object.assign(new Error("execution reverted"), { data });
  return new BaseError("execution reverted", { cause: inner });
}

/** The quoter's envelope around the hook's opening-cap refusal. */
export function capRefusal(): Hex {
  const cap = encodeErrorResult({ abi: ERRORS, errorName: "PurchaseCapExceeded" });
  return encodeErrorResult({ abi: ERRORS, errorName: "UnexpectedRevertBytes", args: [cap] });
}

/** The block every fake receipt lands in. */
export const RECEIPT_BLOCK = 127_345_001n;

export type FakeChainOptions = {
  pools?: Array<{ key: PoolKey; coin: Hex }>;
  /** Pool price, quote per coin. */
  spot?: number;
  /** Feast leg: out = in × num / den. */
  feastRate?: [bigint, bigint];
  /** Each v3 hop leg (all hops at once): out = in × num / den. */
  hopRate?: [bigint, bigint];
  coinBalance?: bigint;
  nativeBalance?: bigint;
  allowance?: bigint;
  permit2?: { amount: bigint; expiration: bigint; nonce: bigint };
  quoteError?: Error;
  estimateError?: Error;
  /** What the receipt says: landed (default), reverted, or never came. */
  receipt?: "success" | "reverted" | "timeout";
  /** Reads pinned to a block fail, as on a node without that state. */
  pinnedReadsFail?: boolean;
  chainId?: number;
  now?: bigint;
};

export type FakeChain = ChainClient & {
  calls: { simulate: unknown[][]; estimate: unknown[]; reads: string[] };
};

export function fakeChain(options: FakeChainOptions = {}): FakeChain {
  const pools = options.pools ?? [BNB_POOL, ROUTED_POOL];
  const calls: FakeChain["calls"] = { simulate: [], estimate: [], reads: [] };
  const [feastNum, feastDen] = options.feastRate ?? [1_000_000n, 1n];
  const [hopNum, hopDen] = options.hopRate ?? [2n, 1n];
  let coinBalance = options.coinBalance ?? 0n;
  let nativeBalance = options.nativeBalance ?? 10n ** 18n;
  // Balances as they stood at the block before the last receipt's.
  let coinBefore = coinBalance;
  let nativeBefore = nativeBalance;
  const pinned = (blockNumber: bigint | undefined, now: bigint, before: bigint) => {
    if (blockNumber === undefined) return now;
    if (options.pinnedReadsFail) throw new Error("header not found");
    return blockNumber < RECEIPT_BLOCK ? before : now;
  };
  const chain: FakeChain = {
    calls,
    getChainId: async () => options.chainId ?? 56,
    async readContract({ address, functionName, args, blockNumber }) {
      calls.reads.push(functionName);
      if (functionName === "poolKeyFor") {
        const coin = String(args?.[0]).toLowerCase();
        const pool = pools.find((p) => p.coin.toLowerCase() === coin);
        if (!pool) throw new Error(`no pool for ${coin}`);
        return pool.key;
      }
      if (functionName === "getSlot0") {
        const id = String(args?.[0]).toLowerCase();
        const pool = pools.find((p) => poolIdOf(p.key).toLowerCase() === id);
        const coinIsCurrency0 = pool ? pool.key.currency0.toLowerCase() === pool.coin.toLowerCase() : true;
        return [sqrtFor(options.spot ?? 1e-6, coinIsCurrency0), 0, 0, 100];
      }
      if (functionName === "balanceOf") return pinned(blockNumber, coinBalance, coinBefore);
      if (functionName === "allowance" && (args?.length ?? 0) === 2) return options.allowance ?? 0n;
      if (functionName === "allowance") {
        const p = options.permit2 ?? { amount: 0n, expiration: 0n, nonce: 0n };
        return [p.amount, Number(p.expiration), Number(p.nonce)];
      }
      throw new Error(`fakeChain: unexpected read ${functionName} on ${address}`);
    },
    async simulateContract({ args, account }) {
      calls.simulate.push([...(args ?? []), account]);
      if (options.quoteError) throw options.quoteError;
      const [paths, actions, , amountIn] = args as [Hex[], Hex, Hex[], bigint];
      // The Feast leg prices coins per quote asset: a buy multiplies by the rate, a sale divides.
      const selling = pools.some((p) => p.coin.toLowerCase() === paths[0]?.toLowerCase());
      const out =
        actions !== "0x04"
          ? (amountIn * hopNum) / hopDen
          : selling
            ? (amountIn * feastDen) / feastNum
            : (amountIn * feastNum) / feastDen;
      return { result: [out, 150_000n] };
    },
    getBlock: async () => ({ timestamp: options.now ?? 1_791_870_000n, number: 127_345_000n }),
    getBalance: async (_address, blockNumber) => pinned(blockNumber, nativeBalance, nativeBefore),
    async estimateGas(args) {
      calls.estimate.push(args);
      if (options.estimateError) throw options.estimateError;
      return 200_000n;
    },
    async waitForReceipt() {
      if (options.receipt === "timeout") throw new Error("Timed out while waiting for transaction");
      coinBefore = coinBalance;
      nativeBefore = nativeBalance;
      if (options.receipt === "reverted") {
        nativeBalance -= 180_000n * 1_000_000_000n;
        return { status: "reverted", gasUsed: 180_000n, effectiveGasPrice: 1_000_000_000n, blockNumber: RECEIPT_BLOCK };
      }
      // A live trade lands. Both balances move, so a buy's fill (coins) and a
      // sale's (BNB, gas already off) can each be measured at this block.
      coinBalance += 5n * 10n ** 18n;
      nativeBalance += 2n * 10n ** 15n - 180_000n * 1_000_000_000n;
      return { status: "success", gasUsed: 180_000n, effectiveGasPrice: 1_000_000_000n, blockNumber: RECEIPT_BLOCK };
    },
  };
  return chain;
}

type FakeResponse = { status?: number; body: unknown; headers?: Record<string, string> };

/** A fake `fetch` answering by path; every URL it was asked for is in `.urls`. */
export function fakeFetch(routes: Record<string, FakeResponse | ((url: URL) => FakeResponse)>) {
  const urls: string[] = [];
  const fetch = async (input: string) => {
    urls.push(input);
    const url = new URL(input);
    const route = routes[url.pathname];
    if (!route) return respond({ status: 404, body: { error: { code: "not-found", message: `no fake for ${url.pathname}` } } });
    return respond(typeof route === "function" ? route(url) : route);
  };
  return Object.assign(fetch, { urls });
}

function respond(answer: FakeResponse) {
  const headers = new Map(Object.entries(answer.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: answer.status ?? 200,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: async () => answer.body,
  };
}

/** One pool as `/api/v1/pools` serves it. */
export function apiPool(pool: { poolId: Hex; coin: Hex; quote: Hex; key: PoolKey }, extra: { createdAt?: string; holders?: number } = {}) {
  return {
    poolId: pool.poolId,
    coin: { address: pool.coin, decimals: 18 },
    quote: { address: pool.quote, decimals: 18, isStock: pool.quote !== BNB_POOL.quote },
    poolKey: pool.key,
    hookFeeBps: 100,
    opening: { openAtSecond: 0, servedBlocks: 2, perWalletCap: "5000000000000000000000000", capBinding: false, open: true },
    createdAt: extra.createdAt ?? "2026-10-11T14:22:23.000Z",
    createdAtBlock: 127_034_000,
    market: { lastPriceSqrtX96: null, lastTradeAt: null, volume24h: "0", trades24h: 0, holders: extra.holders ?? 0 },
  };
}
