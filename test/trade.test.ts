import { decodeFunctionData, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { erc20Abi, universalRouterAbi } from "../src/abi.js";
import { CONTRACTS } from "../src/book.js";
import { parseConfig } from "../src/config.js";
import { ChainReader } from "../src/feast.js";
import { Logger } from "../src/log.js";
import { Risk } from "../src/risk.js";
import { buyCommands, encodeExecute, hookDataFor, sellCommands } from "../src/router.js";
import { NOTHING_HELD, SentTxError, Trader, TradeRefusedError, curveImpact, type Sender } from "../src/trade.js";
import { BNB_POOL, OTHER, ROUTED_POOL, WALLET, capRefusal, fakeChain, revertWith, type FakeChainOptions } from "./fixtures.js";

const BNB = 10n ** 18n;
const NOW = 1_791_870_000_000;
const limits = { ...parseConfig("", "/tmp").risk, stopFile: "/tmp/STOP" };

function setup(options: { chain?: FakeChainOptions; wallet?: Hex | null; sender?: Sender | null; referrer?: Hex | null; stop?: () => boolean } = {}) {
  const chain = fakeChain(options.chain);
  const lines: string[] = [];
  const log = new Logger({ out: (line) => lines.push(line), file: null });
  const risk = new Risk(limits, { exists: options.stop ?? (() => false), now: () => NOW });
  const trader = new Trader({
    reader: new ChainReader(chain),
    risk,
    log,
    wallet: options.wallet === undefined ? null : options.wallet,
    sender: options.sender ?? null,
    referrer: options.referrer ?? null,
    maxSlippageBps: limits.maxSlippageBps,
  });
  return { chain, trader, risk, lines };
}

function spySender(address: Hex = WALLET): Sender & { sent: unknown[]; signed: unknown[] } {
  const sent: unknown[] = [];
  const signed: unknown[] = [];
  return {
    address,
    sent,
    signed,
    sendTransaction: vi.fn(async (tx) => {
      sent.push(tx);
      return `0x${String(sent.length).padStart(64, "0")}` as Hex;
    }),
    signTypedData: vi.fn(async (typedData) => {
      signed.push(typedData);
      return `0x${"ab".repeat(65)}` as Hex;
    }),
  };
}

const buy = (pool = BNB_POOL, amountWei = BNB / 100n) =>
  ({ side: "buy", strategy: "mean_reversion", poolId: pool.poolId, coin: pool.coin, amountWei, reason: "test" }) as const;
const sell = (pool = BNB_POOL, coins = 1000n * BNB) =>
  ({ side: "sell", strategy: "mean_reversion", poolId: pool.poolId, coin: pool.coin, coins, reason: "test" }) as const;

describe("planning a buy", () => {
  it("quotes the Feast pool directly when the quote asset is wrapped BNB, and builds the router's calldata", async () => {
    const { trader, chain } = setup();
    const plan = await trader.plan(buy());
    // No hops: one quoter call, the Feast leg, with the whole BNB amount.
    expect(chain.calls.simulate).toHaveLength(1);
    expect(plan.quote).toEqual({ out: (BNB / 100n) * 1_000_000n, legQuote: BNB / 100n, fee: BNB / 100n / 101n });
    expect(plan.minOut).toBe((plan.quote.out * 9_700n) / 10_000n);
    expect(plan.steps).toHaveLength(1);
    const [step] = plan.steps;
    expect(step).toMatchObject({ stage: "trade", to: CONTRACTS.router, value: BNB / 100n });
    expect(step!.data).toBe(
      encodeExecute(
        buyCommands({
          wrappedNative: CONTRACTS.wrappedNative,
          quote: BNB_POOL.quote,
          coin: BNB_POOL.coin,
          hops: [],
          poolKey: BNB_POOL.key,
          amountIn: BNB / 100n,
          minOut: plan.minOut,
          hookData: "0x",
        }),
        plan.deadline,
      ),
    );
    expect(plan.deadline).toBe(1_791_870_000n + 1800n);
  });

  it("walks the v3 hops to the quote asset first when the pool is paired with one", async () => {
    const { trader, chain } = setup();
    const plan = await trader.plan(buy(ROUTED_POOL));
    expect(chain.calls.simulate).toHaveLength(2);
    // Hops: BNB → USDT → quote asset; the quoter is handed the full path.
    const [paths, actions] = chain.calls.simulate[0] as [Hex[], Hex];
    expect(paths.map((p) => p.toLowerCase())).toEqual(
      [CONTRACTS.wrappedNative, "0x55d398326f99059fF775485246999027B3197955", ROUTED_POOL.quote].map((p) => p.toLowerCase()),
    );
    expect(actions).toBe("0x0303");
    expect(plan.quote.legQuote).toBe((BNB / 100n) * 2n);
    const { functionName, args } = decodeFunctionData({ abi: universalRouterAbi, data: plan.steps[0]!.data });
    expect(functionName).toBe("execute");
    // WRAP_ETH, V3_SWAP_EXACT_IN, INFI_SWAP.
    expect(args[0]).toBe("0x0b0010");
  });

  it("carries the referrer as one 32-byte word, and nothing when there is none", async () => {
    const referred = await setup({ referrer: OTHER }).trader.plan(buy());
    expect(referred.hookData).toBe(hookDataFor(OTHER));
    expect(referred.hookData).toBe(`0x${OTHER.slice(2).padStart(64, "0")}`);
    expect((await setup().trader.plan(buy())).hookData).toBe("0x");
  });

  it("simulates the quote as the wallet when it knows one, so the opening cap is asked of that wallet", async () => {
    const { trader, chain } = setup({ wallet: WALLET });
    await trader.plan(buy());
    expect(chain.calls.simulate[0]!.at(-1)).toBe(WALLET);
  });

  it("names the hook's refusal when the quote is refused", async () => {
    const { trader } = setup({ chain: { quoteError: revertWith(capRefusal()) } });
    const error = await trader.plan(buy()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TradeRefusedError);
    expect((error as TradeRefusedError).refusal).toBe("PurchaseCapExceeded");
    expect((error as Error).message).toMatch(/opening cap/);
  });

  it("measures the expected slippage net of the hook's fee, as the site does", () => {
    // 0.01 in, fee 0.01/101, 1000 coins out: the curve was paid 0.0099009… for 1000.
    const impact = curveImpact("buy", BNB / 100n, { out: 1000n * BNB, legQuote: BNB / 100n, fee: BNB / 100n / 101n }, 0.0099 / 1000);
    expect(impact).toBeCloseTo(0.0001, 4);
    expect(curveImpact("buy", 1n, { out: 0n, legQuote: 1n, fee: 0n }, 1)).toBeNull();
  });
});

describe("planning a sale", () => {
  it("adds the one-time approval of Permit2 and a permit when the wallet has neither", async () => {
    const { trader } = setup({ wallet: WALLET });
    const plan = await trader.plan(sell());
    expect(plan.approval).toBe("needed");
    expect(plan.steps.map((s) => s.stage)).toEqual(["approval", "trade"]);
    const approve = decodeFunctionData({ abi: erc20Abi, data: plan.steps[0]!.data });
    expect(approve.functionName).toBe("approve");
    expect(approve.args[0]).toBe(CONTRACTS.permit2);
    expect(plan.steps[0]!.to).toBe(BNB_POOL.coin);
    expect(plan.permit).toMatchObject({ spender: CONTRACTS.router, sigDeadline: plan.deadline });
    // The trade step holds a stand-in signature until the real one is made at send time.
    expect(plan.steps[1]!.data).toContain("00".repeat(65));
  });

  it("needs neither when the wallet's approval and Permit2 allowance already cover the sale", async () => {
    const { trader } = setup({
      wallet: WALLET,
      chain: { allowance: 2n ** 255n, permit2: { amount: 2n ** 150n, expiration: 1_791_870_000n + 86_400n, nonce: 3n } },
    });
    const plan = await trader.plan(sell());
    expect(plan.approval).toBe("not-needed");
    expect(plan.permit).toBeNull();
    expect(plan.steps.map((s) => s.stage)).toEqual(["trade"]);
    expect(plan.steps[0]!.data).toBe(
      encodeExecute(
        sellCommands({
          wrappedNative: CONTRACTS.wrappedNative,
          quote: BNB_POOL.quote,
          coin: BNB_POOL.coin,
          hops: [],
          poolKey: BNB_POOL.key,
          amountIn: 1000n * BNB,
          minOut: plan.minOut,
          hookData: "0x",
          permit: null,
        }),
        plan.deadline,
      ),
    );
  });

  it("quotes the Feast leg first and the hops back to BNB second", async () => {
    const { trader, chain } = setup();
    const plan = await trader.plan(sell(ROUTED_POOL));
    expect((chain.calls.simulate[0] as [Hex[], Hex])[1]).toBe("0x04");
    expect((chain.calls.simulate[1] as [Hex[], Hex])[1]).toBe("0x0303");
    expect(plan.quote.out).toBe(plan.quote.legQuote * 2n);
    // Without a wallet the approval is unknown, and planned for.
    expect(plan.approval).toBe("unknown");
  });
});

describe("dry run is the default, and a dry run cannot send", () => {
  it("logs the order with its calldata, quote and expected slippage, returns a paper fill, and sends nothing", async () => {
    const { trader, risk, lines } = setup({ wallet: WALLET });
    expect(trader.live).toBe(false);
    const plan = await trader.plan(buy());
    const verdict = risk.check(plan, { now: NOW, positionCostWei: () => 0n, lastOrderAt: () => null, ordersSince: () => 0, realizedTodayWei: 0n, openLossWei: 0n, balanceWei: null });
    if (!verdict.ok) throw new Error(verdict.reason);
    const result = await trader.execute(verdict.approval);
    expect(result.sent).toBe(false);
    expect(result.fill).toEqual({ coins: plan.quote.out, bnbWei: plan.amountIn, gasWei: 0n, hashes: [] });
    const order = JSON.parse(lines.find((line) => line.includes('"event":"order"'))!);
    expect(order).toMatchObject({ mode: "dry-run", sent: false, side: "buy", expectedSlippageBps: expect.any(Number), simulated: "ok" });
    expect(order.steps[0].data).toBe(plan.steps[0]!.data);
    expect(order.quote.out).toBe(plan.quote.out.toString());
  });

  it("never calls sendTransaction, even when a sender object exists elsewhere in the process", async () => {
    const sender = spySender();
    const { trader, risk } = setup({ wallet: WALLET });
    for (const intent of [buy(), sell()]) {
      const plan = await trader.plan(intent);
      const verdict = risk.check(plan, { now: NOW, positionCostWei: () => 0n, lastOrderAt: () => null, ordersSince: () => 0, realizedTodayWei: 0n, openLossWei: 0n, balanceWei: null });
      if (!verdict.ok) throw new Error(verdict.reason);
      await trader.execute(verdict.approval);
    }
    expect(sender.sendTransaction).not.toHaveBeenCalled();
    expect(sender.signTypedData).not.toHaveBeenCalled();
  });

  it("refuses to execute anything the risk gate did not approve", async () => {
    const { trader } = setup();
    await expect(trader.execute(Object.freeze({ id: 1, planId: "x" }))).rejects.toThrow(/not approved/);
  });
});

describe("live", () => {
  const openView = { now: NOW, positionCostWei: () => 0n, lastOrderAt: () => null, ordersSince: () => 0, realizedTodayWei: 0n, openLossWei: 0n, balanceWei: null };

  it("sends a buy once, with padded gas, and measures the fill from the coin balance", async () => {
    const sender = spySender();
    const { trader, risk, chain } = setup({ wallet: WALLET, sender });
    const plan = await trader.plan(buy());
    const verdict = risk.check(plan, openView);
    if (!verdict.ok) throw new Error(verdict.reason);
    const result = await trader.execute(verdict.approval);
    expect(sender.sendTransaction).toHaveBeenCalledTimes(1);
    expect(sender.sent[0]).toEqual({ to: CONTRACTS.router, data: plan.steps[0]!.data, value: BNB / 100n, gas: 250_000n });
    expect(chain.calls.estimate).toHaveLength(1);
    expect(result).toMatchObject({ sent: true, fill: { coins: 5n * BNB, gasWei: 180_000n * 1_000_000_000n } });
  });

  it("does not send a buy the chain would refuse", async () => {
    const sender = spySender();
    const { trader, risk } = setup({ wallet: WALLET, sender, chain: { estimateError: revertWith(capRefusal()) } });
    const plan = await trader.plan(buy());
    const verdict = risk.check(plan, openView);
    if (!verdict.ok) throw new Error(verdict.reason);
    await expect(trader.execute(verdict.approval)).rejects.toThrow(/PurchaseCapExceeded/);
    expect(sender.sendTransaction).not.toHaveBeenCalled();
  });

  it("sends the approval, signs the permit, and sends the sale with the real signature", async () => {
    const sender = spySender();
    const { trader, risk } = setup({ wallet: WALLET, sender, chain: { coinBalance: 2000n * BNB } });
    const plan = await trader.plan(sell());
    const verdict = risk.check(plan, openView);
    if (!verdict.ok) throw new Error(verdict.reason);
    await trader.execute(verdict.approval);
    expect(sender.sendTransaction).toHaveBeenCalledTimes(2);
    expect((sender.sent[0] as { to: Hex }).to).toBe(BNB_POOL.coin);
    expect(sender.signTypedData).toHaveBeenCalledTimes(1);
    const tradeData = (sender.sent[1] as { data: Hex }).data;
    expect(tradeData).toContain("ab".repeat(65));
    expect(tradeData).not.toContain("00".repeat(65));
  });

  it("stops before the sale when the STOP file appears after the approval", async () => {
    const sender = spySender();
    let stop = false;
    const { trader, risk } = setup({ wallet: WALLET, sender, chain: { coinBalance: 2000n * BNB }, stop: () => stop });
    const plan = await trader.plan(sell());
    const verdict = risk.check(plan, openView);
    if (!verdict.ok) throw new Error(verdict.reason);
    (sender.sendTransaction as ReturnType<typeof vi.fn>).mockImplementationOnce(async (tx: unknown) => {
      sender.sent.push(tx);
      stop = true;
      return `0x${"01".repeat(32)}` as Hex;
    });
    await expect(trader.execute(verdict.approval)).rejects.toThrow(/STOP/);
    expect(sender.sendTransaction).toHaveBeenCalledTimes(1);
    expect(sender.signTypedData).not.toHaveBeenCalled();
  });

  it("measures a sale's BNB at the receipt's own block, its gas and the approval's taken off", async () => {
    const sender = spySender();
    const { trader, risk } = setup({ wallet: WALLET, sender, chain: { coinBalance: 2000n * BNB } });
    const plan = await trader.plan(sell());
    const verdict = risk.check(plan, openView);
    if (!verdict.ok) throw new Error(verdict.reason);
    const result = await trader.execute(verdict.approval);
    const gas = 180_000n * 1_000_000_000n;
    // The sale's block: +0.002 BNB in, its own gas already off; then the approval's gas.
    expect(result.fill).toMatchObject({ coins: 1000n * BNB, bnbWei: 2n * 10n ** 15n - gas - gas, gasWei: 2n * gas });
    expect(result.fill.hashes).toHaveLength(2);
  });

  it("books a fill at its floor when the receipt's block cannot be read", async () => {
    const sender = spySender();
    const { trader, risk, lines } = setup({ wallet: WALLET, sender, chain: { pinnedReadsFail: true } });
    const plan = await trader.plan(buy());
    const verdict = risk.check(plan, openView);
    if (!verdict.ok) throw new Error(verdict.reason);
    const result = await trader.execute(verdict.approval);
    expect(result.fill.coins).toBe(plan.minOut);
    expect(lines.some((line) => line.includes('"event":"fill_estimated"'))).toBe(true);
  });

  it.each([
    ["reverted", "reverted", 180_000n * 1_000_000_000n],
    ["timeout", "unknown", 0n],
  ] as const)("reports a buy that went out and then %s, with its hash and the gas it burned", async (receipt, outcome, gasWei) => {
    const sender = spySender();
    const { trader, risk } = setup({ wallet: WALLET, sender, chain: { receipt } });
    const plan = await trader.plan(buy());
    const verdict = risk.check(plan, openView);
    if (!verdict.ok) throw new Error(verdict.reason);
    const error = await trader.execute(verdict.approval).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SentTxError);
    expect(error).toMatchObject({ outcome, gasWei, hashes: [expect.stringMatching(/^0x/)] });
  });

  it("sells only what the wallet still holds, and says so when it holds none", async () => {
    const sender = spySender();
    const short = setup({ wallet: WALLET, sender, chain: { coinBalance: 400n * BNB } });
    expect((await short.trader.plan(sell(BNB_POOL, 1000n * BNB))).amountIn).toBe(400n * BNB);
    const none = setup({ wallet: WALLET, sender: spySender(), chain: { coinBalance: 0n } });
    await expect(none.trader.plan(sell())).rejects.toMatchObject({ refusal: NOTHING_HELD });
    // A dry run's paper position is not held on chain, and is not clamped.
    const paper = setup({ wallet: WALLET, chain: { coinBalance: 0n } });
    expect((await paper.trader.plan(sell(BNB_POOL, 1000n * BNB))).amountIn).toBe(1000n * BNB);
  });

  it("refuses a sender whose address is not the wallet it was built for", () => {
    expect(() => setup({ wallet: WALLET, sender: spySender(OTHER) })).toThrow(/not the wallet/);
  });
});
