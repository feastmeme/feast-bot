/**
 * READING FEAST: the public API, and the chain reads the site itself makes.
 *
 * THE API (`/api/v1`, documented at https://feast.meme/api/v1):
 *   pools    GET /api/v1/pools            the launch feed, cursor-paged
 *   pool     GET /api/v1/pools/{poolId}   one pool, with live state
 *   quote    GET /api/v1/quote            a simulation of the Feast leg alone
 *   ohlcv    GET /api/v1/ohlcv            candles, prices as sqrtPriceX96
 *   trades   GET /api/v1/events?types=trade
 *   launches GET /api/v1/me/launches     a creator's coins (public: no session)
 *   holders  a pool's `market.holders` (there is no separate holders endpoint)
 *
 * Every answer carries `chainId`, and every answer is checked against 56: a
 * client that does not check it is a client that will trade the wrong chain.
 *
 * THE RATE LIMIT is 60 requests a minute per caller across the whole of v1,
 * shared by every endpoint. This client spends at most
 * `[bot] api_requests_per_minute` (30 by default, 60 at most) from a token
 * bucket, and when the server answers 429 it stops asking for the
 * `retry-after` it was given.
 *
 * THE CHAIN READS are the ones the site makes for the same purpose: the pool
 * key from the Feast factory (held to the pool id the API gave), the pool's
 * price from the pool manager's `getSlot0`, balances and allowances.
 */

import type { Abi, PublicClient } from "viem";

import { erc20Abi, factoryAbi, permit2Abi, poolManagerAbi } from "./abi.js";
import { CHAIN_ID, CONTRACTS, type Hex } from "./book.js";
import { poolIdOf, type PoolKey } from "./router.js";
import type { Candle } from "./strategies/types.js";
import { priceFromSqrt } from "./units.js";

export const USER_AGENT = "feast-bot-starter/0.1.0";

// ── The API ─────────────────────────────────────────────────────────────────

export type ApiPool = {
  poolId: Hex;
  coin: { address: Hex; decimals: number };
  quote: { address: Hex; decimals: number; isStock: boolean };
  poolKey: PoolKey;
  hookFeeBps: number;
  opening: {
    openAtSecond: number;
    servedBlocks: number;
    perWalletCap: string | null;
    capBinding: boolean;
    open: boolean;
  };
  /** The coin's creator. */
  creator?: Hex;
  createdAt: string | null;
  createdAtBlock: number | null;
  market: {
    lastPriceSqrtX96: string | null;
    lastTradeAt: string | null;
    volume24h: string;
    trades24h: number;
    holders: number;
  } | null;
};

export type ApiQuote = {
  amountIn: string;
  amountOut: string | null;
  refusal: { name: string; message: string; retryAfterBlock: number | null } | null;
  hookFee?: { amount: string };
  quotedAtBlock: number;
  quotedVia: string;
};

export type ApiTrade = {
  /** Opaque: where to read on from (`since_cursor`, exclusive). */
  cursor: string;
  at: string;
  blockNumber: number;
  txHash: Hex;
  side: "buy" | "sell";
  /** Who traded: the transaction's sender. */
  payer: Hex;
  coinAmount: string;
  /** Quote-asset base units, the hook's fee included. */
  quoteAmount: string;
  sqrtPriceX96After: string;
};

/** One coin a creator launched, as `/api/v1/me/launches` serves it: its figures, and words this kit never reads. */
export type ApiLaunch = {
  coin: { address: Hex };
  holders: number;
  /** Every fill since launch. */
  trades: number;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class RateLimitedError extends ApiError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, "rate-limited", `the API asked us to wait ${retryAfterSeconds} s`);
    this.name = "RateLimitedError";
  }
}

/** A token bucket: `perMinute` requests a minute, refilled continuously. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private pausedUntil = 0;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.tokens = perMinute;
    this.last = now();
  }

  /** Wait until one request may be made, then spend it. */
  async take(): Promise<void> {
    for (;;) {
      const now = this.now();
      if (now < this.pausedUntil) {
        await this.sleep(this.pausedUntil - now);
        continue;
      }
      this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) * this.perMinute) / 60_000);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute));
    }
  }

  /** Stop all requests for `seconds`: the server said so. */
  pause(seconds: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + seconds * 1000);
    this.tokens = 0;
  }
}

type Fetch = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export class FeastApi {
  private readonly fetch: Fetch;

  constructor(
    private readonly options: {
      base: string;
      limiter: RateLimiter;
      fetch?: Fetch;
      timeoutMs?: number;
    },
  ) {
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  }

  /** The launch feed, newest first by default; walks `nextCursor` up to `maxPages` pages. */
  async pools(options: { order?: "created_desc" | "created_asc"; limit?: number; createdAfter?: Date; maxPages?: number } = {}): Promise<ApiPool[]> {
    const out: ApiPool[] = [];
    let cursor: string | null = null;
    const maxPages = options.maxPages ?? 5;
    for (let page = 0; page < maxPages; page++) {
      const body = (await this.get("/api/v1/pools", {
        order: options.order ?? "created_desc",
        limit: options.limit ?? 200,
        created_after: options.createdAfter?.toISOString(),
        cursor: cursor ?? undefined,
      })) as { pools: ApiPool[]; nextCursor: string | null };
      out.push(...body.pools);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async pool(poolId: Hex): Promise<ApiPool> {
    const body = (await this.get(`/api/v1/pools/${poolId}`, {})) as { pool: ApiPool };
    return body.pool;
  }

  /** The Feast leg alone, simulated by the server: quote asset in on a buy, coins in on a sale. */
  async quote(input: { poolId: Hex; side: "buy" | "sell"; amountIn: bigint; referrer?: Hex | null }): Promise<ApiQuote> {
    return (await this.get("/api/v1/quote", {
      poolId: input.poolId,
      side: input.side,
      amountIn: input.amountIn.toString(),
      referrer: input.referrer ?? undefined,
    })) as ApiQuote;
  }

  async ohlcv(input: { poolId: Hex; timeframe: "minute" | "hour" | "day"; aggregate: number; limit: number }): Promise<Candle[]> {
    const body = (await this.get("/api/v1/ohlcv", {
      poolId: input.poolId,
      timeframe: input.timeframe,
      aggregate: input.aggregate,
      limit: input.limit,
    })) as { rows: Candle[] };
    return body.rows;
  }

  /** One pool's trades, oldest first, from `sinceCursor` (exclusive) when given. */
  async trades(input: { poolId: Hex; sinceCursor?: string | null; limit?: number }): Promise<{ trades: ApiTrade[]; nextCursor: string | null }> {
    const body = (await this.get("/api/v1/events", {
      poolId: input.poolId,
      types: "trade",
      limit: input.limit ?? 1000,
      since_cursor: input.sinceCursor ?? undefined,
    })) as { events: ApiTrade[]; nextCursor: string | null };
    return { trades: body.events, nextCursor: body.nextCursor };
  }

  /** Every coin `wallet` has launched: a public read, no session needed. */
  async launches(wallet: Hex): Promise<ApiLaunch[]> {
    const body = (await this.get("/api/v1/me/launches", { wallet })) as { launches: ApiLaunch[] };
    return body.launches;
  }

  /** A pool's holder count, from its market figures; null when the index has none. */
  async holders(poolId: Hex): Promise<number | null> {
    const pool = await this.pool(poolId);
    return pool.market?.holders ?? null;
  }

  private async get(path: string, params: Record<string, string | number | undefined>): Promise<Record<string, unknown>> {
    const url = new URL(path, `${this.options.base}/`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));

    await this.options.limiter.take();
    const response = await this.fetch(url.toString(), {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "60");
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
      this.options.limiter.pause(seconds);
      throw new RateLimitedError(seconds);
    }
    // The server's own count: when it says nothing is left, wait out the window.
    // Not from a CDN copy, though: `/pools` is cached at the edge for a few
    // seconds, headers and all, and a cached count is somebody else's.
    const fromCache = /hit|stale/i.test(response.headers.get("x-vercel-cache") ?? "") || Number(response.headers.get("age") ?? "0") > 0;
    if (response.headers.get("x-ratelimit-remaining") === "0" && !fromCache) this.options.limiter.pause(60);

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.status < 200 || response.status >= 300) {
      const error = (body?.error ?? {}) as { code?: string; message?: string };
      throw new ApiError(response.status, error.code ?? "http-error", error.message ?? `HTTP ${response.status} from ${url.pathname}`);
    }
    if (!body || typeof body !== "object") throw new ApiError(response.status, "bad-body", `${url.pathname} did not answer JSON`);
    if (body.chainId !== CHAIN_ID) {
      throw new ApiError(response.status, "wrong-chain", `${url.pathname} answered for chain ${String(body.chainId)}, not ${CHAIN_ID}`);
    }
    return body;
  }
}

// ── The chain ───────────────────────────────────────────────────────────────

/**
 * The few chain calls this kit makes, narrowed from viem's client so a test
 * can hand in a fake. `chainClientFrom` adapts a real viem `PublicClient`.
 */
export interface ChainClient {
  getChainId(): Promise<number>;
  readContract(args: { address: Hex; abi: Abi; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown>;
  simulateContract(args: { address: Hex; abi: Abi; functionName: string; args?: readonly unknown[]; account?: Hex }): Promise<{ result: unknown }>;
  getBlock(): Promise<{ timestamp: bigint; number: bigint }>;
  getBalance(address: Hex, blockNumber?: bigint): Promise<bigint>;
  estimateGas(args: { account: Hex; to: Hex; data: Hex; value?: bigint }): Promise<bigint>;
  waitForReceipt(hash: Hex): Promise<{ status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice: bigint; blockNumber: bigint }>;
}

export function chainClientFrom(client: PublicClient): ChainClient {
  return {
    getChainId: () => client.getChainId(),
    readContract: (args) => client.readContract(args as never) as Promise<unknown>,
    simulateContract: (args) => client.simulateContract(args as never) as Promise<{ result: unknown }>,
    getBlock: async () => {
      const block = await client.getBlock({ blockTag: "latest" });
      return { timestamp: block.timestamp, number: block.number ?? 0n };
    },
    getBalance: (address, blockNumber) => client.getBalance(blockNumber === undefined ? { address } : { address, blockNumber }),
    estimateGas: (args) => client.estimateGas(args),
    waitForReceipt: async (hash) => {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      return {
        status: receipt.status,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        blockNumber: receipt.blockNumber,
      };
    },
  };
}

export class PoolKeyMismatchError extends Error {
  override name = "PoolKeyMismatchError";
}

export class ChainReader {
  private readonly keys = new Map<string, Promise<PoolKey>>();

  constructor(readonly client: ChainClient) {}

  /**
   * The coin's pool key from the Feast factory, held to the pool id the API
   * gave: a key that hashes to anything else is refused before any quote.
   */
  async poolKey(coin: Hex, poolId: Hex): Promise<PoolKey> {
    const cacheKey = coin.toLowerCase();
    let pending = this.keys.get(cacheKey);
    if (!pending) {
      pending = this.client
        .readContract({ address: CONTRACTS.factory, abi: factoryAbi, functionName: "poolKeyFor", args: [coin] })
        .then((key) => key as PoolKey);
      this.keys.set(cacheKey, pending);
      pending.catch(() => this.keys.delete(cacheKey));
    }
    const key = await pending;
    if (poolIdOf(key).toLowerCase() !== poolId.toLowerCase()) {
      throw new PoolKeyMismatchError(`the factory's pool key for ${coin} hashes to ${poolIdOf(key)}, not ${poolId}`);
    }
    return key;
  }

  /** A coin's pool id, from the Feast factory's pool key: how a coin address in the config finds its pool. */
  async poolIdOfCoin(coin: Hex): Promise<Hex> {
    const key = (await this.client.readContract({ address: CONTRACTS.factory, abi: factoryAbi, functionName: "poolKeyFor", args: [coin] })) as PoolKey;
    return poolIdOf(key);
  }

  /** The pool's price now, quote asset per coin. */
  async spotPrice(poolId: Hex, coinIsCurrency0: boolean): Promise<number> {
    const slot0 = (await this.client.readContract({
      address: CONTRACTS.poolManager,
      abi: poolManagerAbi,
      functionName: "getSlot0",
      args: [poolId],
    })) as readonly [bigint, number, number, number];
    return priceFromSqrt(slot0[0], coinIsCurrency0);
  }

  /** At `blockNumber` when given: a fill is measured at its own block, never at whatever "latest" a node has. */
  nativeBalance(owner: Hex, blockNumber?: bigint): Promise<bigint> {
    return this.client.getBalance(owner, blockNumber);
  }

  async coinBalance(coin: Hex, owner: Hex, blockNumber?: bigint): Promise<bigint> {
    return (await this.client.readContract({ address: coin, abi: erc20Abi, functionName: "balanceOf", args: [owner], ...(blockNumber === undefined ? {} : { blockNumber }) })) as bigint;
  }

  async allowance(coin: Hex, owner: Hex, spender: Hex): Promise<bigint> {
    return (await this.client.readContract({ address: coin, abi: erc20Abi, functionName: "allowance", args: [owner, spender] })) as bigint;
  }

  /** Permit2's allowance of `coin` from `owner` to the router: amount, expiry (unix s) and nonce. */
  async permit2Allowance(owner: Hex, coin: Hex): Promise<{ amount: bigint; expiration: bigint; nonce: bigint }> {
    const [amount, expiration, nonce] = (await this.client.readContract({
      address: CONTRACTS.permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [owner, coin, CONTRACTS.router],
    })) as readonly [bigint, number | bigint, number | bigint];
    return { amount, expiration: BigInt(expiration), nonce: BigInt(nonce) };
  }

  /** The chain's clock: the router refuses a deadline behind its own. */
  async chainNow(): Promise<bigint> {
    return (await this.client.getBlock()).timestamp;
  }
}
