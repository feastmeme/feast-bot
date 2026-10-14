import { describe, expect, it } from "vitest";

import { ApiError, ChainReader, FeastApi, PoolKeyMismatchError, RateLimitedError, RateLimiter, USER_AGENT } from "../src/feast.js";
import { BNB_POOL, ROUTED_POOL, apiPool, fakeChain, fakeFetch } from "./fixtures.js";

/** A clock that only moves when the limiter sleeps. */
function fakeClock() {
  let now = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
  };
}

describe("the rate limiter", () => {
  it("lets a full minute's allowance through, then spaces requests evenly", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(30, clock.now, clock.sleep);
    for (let i = 0; i < 30; i++) await limiter.take();
    expect(clock.slept).toEqual([]);
    await limiter.take();
    await limiter.take();
    // 30 a minute is one every two seconds.
    expect(clock.slept).toEqual([2000, 2000]);
  });

  it("never spends more than its rate over any minute", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(60, clock.now, clock.sleep);
    const times: number[] = [];
    for (let i = 0; i < 300; i++) {
      await limiter.take();
      times.push(clock.now());
    }
    for (let i = 0; i < times.length; i++) {
      const inWindow = times.filter((t) => t > (times[i] as number) - 60_000 && t <= (times[i] as number)).length;
      // The bucket starts full, so the first window may hold one burst of 60 plus refills.
      expect(inWindow).toBeLessThanOrEqual(120);
    }
    const lastMinute = times.filter((t) => t > clock.now() - 60_000).length;
    expect(lastMinute).toBeLessThanOrEqual(61);
  });

  it("waits out a pause the server asked for", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(60, clock.now, clock.sleep);
    limiter.pause(45);
    await limiter.take();
    expect(clock.slept[0]).toBe(45_000);
  });
});

describe("the API client", () => {
  const pools = { chainId: 56, source: "indexer", pools: [apiPool(BNB_POOL), apiPool(ROUTED_POOL)], nextCursor: null };

  it("names itself, checks the chain id, and reads the feed", async () => {
    const clock = fakeClock();
    const seen: Array<Record<string, string>> = [];
    const fetch = fakeFetch({ "/api/v1/pools": { body: pools } });
    const api = new FeastApi({
      base: "https://feast.meme",
      limiter: new RateLimiter(30, clock.now, clock.sleep),
      fetch: async (url, init) => {
        seen.push(init?.headers ?? {});
        return fetch(url);
      },
    });
    const answer = await api.pools();
    expect(answer.map((p) => p.poolId)).toEqual([BNB_POOL.poolId, ROUTED_POOL.poolId]);
    expect(fetch.urls[0]).toBe("https://feast.meme/api/v1/pools?order=created_desc&limit=200");
    expect(seen[0]?.["user-agent"]).toBe(USER_AGENT);
  });

  it("follows the cursor, up to the page cap", async () => {
    const clock = fakeClock();
    const fetch = fakeFetch({
      "/api/v1/pools": (url) => ({
        body: { chainId: 56, pools: [apiPool(BNB_POOL)], nextCursor: `c${(Number(url.searchParams.get("cursor")?.slice(1) ?? "0") + 1)}` },
      }),
    });
    const api = new FeastApi({ base: "https://feast.meme", limiter: new RateLimiter(30, clock.now, clock.sleep), fetch });
    expect(await api.pools({ maxPages: 3 })).toHaveLength(3);
    expect(fetch.urls.map((u) => new URL(u).searchParams.get("cursor"))).toEqual([null, "c1", "c2"]);
  });

  it("refuses an answer for another chain", async () => {
    const clock = fakeClock();
    const fetch = fakeFetch({ "/api/v1/pools": { body: { ...pools, chainId: 97 } } });
    const api = new FeastApi({ base: "https://feast.meme", limiter: new RateLimiter(30, clock.now, clock.sleep), fetch });
    await expect(api.pools()).rejects.toMatchObject({ code: "wrong-chain" });
  });

  it("stops asking for retry-after seconds when it is told 429", async () => {
    const clock = fakeClock();
    let calls = 0;
    const fetch = fakeFetch({
      "/api/v1/pools": () => {
        calls++;
        return calls === 1
          ? { status: 429, body: { error: { code: "rate-limited", message: "slow down" } }, headers: { "retry-after": "60" } }
          : { body: pools };
      },
    });
    const api = new FeastApi({ base: "https://feast.meme", limiter: new RateLimiter(30, clock.now, clock.sleep), fetch });
    await expect(api.pools()).rejects.toBeInstanceOf(RateLimitedError);
    const before = clock.now();
    await api.pools();
    expect(clock.now() - before).toBeGreaterThanOrEqual(60_000);
  });

  it("waits out the window when the server says nothing is left", async () => {
    const clock = fakeClock();
    const fetch = fakeFetch({ "/api/v1/pools": { body: pools, headers: { "x-ratelimit-remaining": "0" } } });
    const api = new FeastApi({ base: "https://feast.meme", limiter: new RateLimiter(30, clock.now, clock.sleep), fetch });
    await api.pools();
    const before = clock.now();
    await api.pools();
    expect(clock.now() - before).toBeGreaterThanOrEqual(60_000);
  });

  it("ignores a spent count on a copy the CDN served, which was somebody else's", async () => {
    const clock = fakeClock();
    const fetch = fakeFetch({ "/api/v1/pools": { body: pools, headers: { "x-ratelimit-remaining": "0", "x-vercel-cache": "HIT", age: "4" } } });
    const api = new FeastApi({ base: "https://feast.meme", limiter: new RateLimiter(30, clock.now, clock.sleep), fetch });
    await api.pools();
    const before = clock.now();
    await api.pools();
    expect(clock.now() - before).toBe(0);
  });

  it("passes the API's error code through", async () => {
    const clock = fakeClock();
    const fetch = fakeFetch({ "/api/v1/ohlcv": { status: 400, body: { error: { code: "bad-request", message: "unsupported bucket" } } } });
    const api = new FeastApi({ base: "https://feast.meme", limiter: new RateLimiter(30, clock.now, clock.sleep), fetch });
    const error = await api.ohlcv({ poolId: BNB_POOL.poolId, timeframe: "minute", aggregate: 3, limit: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: "bad-request" });
  });

  it("reads holders from the pool's market figures", async () => {
    const clock = fakeClock();
    const fetch = fakeFetch({ [`/api/v1/pools/${BNB_POOL.poolId}`]: { body: { chainId: 56, pool: apiPool(BNB_POOL, { holders: 42 }) } } });
    const api = new FeastApi({ base: "https://feast.meme", limiter: new RateLimiter(30, clock.now, clock.sleep), fetch });
    expect(await api.holders(BNB_POOL.poolId)).toBe(42);
  });
});

describe("the chain reader", () => {
  it("holds the factory's pool key to the pool id it was asked about", async () => {
    const reader = new ChainReader(fakeChain());
    expect(await reader.poolKey(BNB_POOL.coin, BNB_POOL.poolId)).toEqual(BNB_POOL.key);
    await expect(reader.poolKey(BNB_POOL.coin, ROUTED_POOL.poolId)).rejects.toBeInstanceOf(PoolKeyMismatchError);
  });

  it("reads the pool's price from getSlot0 in quote per coin, on either side of the pool", async () => {
    const reader = new ChainReader(fakeChain({ spot: 2.5e-6 }));
    expect(await reader.spotPrice(BNB_POOL.poolId, true)).toBeCloseTo(2.5e-6, 15);
    expect(await reader.spotPrice(ROUTED_POOL.poolId, false)).toBeCloseTo(2.5e-6, 15);
  });
});
