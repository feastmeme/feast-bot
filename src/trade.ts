/**
 * THE ORDER PATH: quote, plan, and — only with `--live` and a risk approval —
 * send.
 *
 * It builds a trade exactly the way the Feast site's trade box does on BNB
 * Chain (`src/lib/trade/infinity-router.ts` in the Feast app):
 *
 *   THE QUOTE IS THE VENUE'S. PancakeSwap's MixedQuoter simulates the same
 *   pools the router will swap — the v3 hops between BNB and the pool's quote
 *   asset, and the Feast pool with its hook — as your wallet when the bot
 *   knows it, so the opening cap is asked of you. The Feast leg is quoted on
 *   its own so the expected slippage can be measured on it.
 *
 *   A BUY is one transaction: BNB goes in as `value`, is wrapped by the
 *   router, walked through the hops and spent whole on the Feast pool.
 *
 *   A SALE is one transaction once the coin is set up: the first sale of a
 *   coin also needs the coin's ERC-20 approval of Permit2 (a transaction,
 *   once per coin), and a Permit2 signature for the router — the largest
 *   allowance for thirty days, as PancakeSwap's own site signs it — which
 *   rides inside the sale.
 *
 *   THE REFERRER travels as the hook reads it: one 32-byte word, or nothing.
 *
 * DRY RUN IS THE DEFAULT. Without `--live` the trader is built with no sender
 * at all: it quotes, prints the calldata, the quote and the expected
 * slippage, records a paper fill, and has nothing it could send with.
 */

import { encodeFunctionData, maxUint256 } from "viem";

import { erc20Abi, mixedQuoterAbi, ERRORS } from "./abi.js";
import { CHAIN_ID, CONTRACTS, routeFor, type Hex, type Hop } from "./book.js";
import type { ChainReader } from "./feast.js";
import { errorText, type Logger } from "./log.js";
import { refusalName, REFUSAL_HINTS } from "./refusal.js";
import type { Approval, Risk } from "./risk.js";
import {
  MAX_UINT160,
  buyCommands,
  encodeExecute,
  feastQuoteArgs,
  hookDataFor,
  hopsQuoteArgs,
  permitSingleTypedData,
  sameAddress,
  sellCommands,
  type PermitSingle,
  type PoolKey,
} from "./router.js";
import type { Intent } from "./strategies/types.js";
import { asFloat, bpsOf } from "./units.js";

/** Thirty minutes: the trade's deadline and a new permit's signing deadline, on the chain's clock. */
const DEADLINE_SECONDS = 30n * 60n;
/** Thirty days: how long a Permit2 allowance lasts, as the venue's own site signs it. */
const PERMIT_SECONDS = 30n * 24n * 60n * 60n;
/** The hook's 1%: `FEE_PIPS / FEE_DENOMINATOR`. */
const HOOK_FEE_PIPS = 10_000n;
const HOOK_FEE_DENOMINATOR = 1_000_000n;
/** Gas estimates are padded: an estimate a few thousand short reverts out of gas. */
const GAS_PAD_PERCENT = 125n;
/** A stand-in signature for a dry run's sale calldata; a real one is made at send time. */
const UNSIGNED: Hex = `0x${"00".repeat(65)}`;

const QUOTER_ABI = [...mixedQuoterAbi, ...ERRORS];

export type TradeQuote = {
  /** What comes out: coins on a buy, wei of BNB on a sale. */
  out: bigint;
  /** The quote-asset amount going into (buy) or coming out of (sale) the Feast pool. */
  legQuote: bigint;
  /** The hook's fee on that leg, in the quote asset. */
  fee: bigint;
};

export type Step = { stage: "approval" | "trade"; to: Hex; data: Hex; value: bigint };

export type Plan = {
  id: string;
  side: "buy" | "sell";
  strategy: string;
  reason: string;
  poolId: Hex;
  coin: Hex;
  quoteAsset: Hex;
  /** Wei of BNB on a buy; coins on a sale. */
  amountIn: bigint;
  quote: TradeQuote;
  /** The floor the transaction carries: below it, the chain reverts the trade. */
  minOut: bigint;
  /** The pool's price, quote asset per coin, when the order was planned. */
  spot: number | null;
  /** Expected slippage against the pool's price, as a fraction, fee excluded. */
  impact: number | null;
  deadline: bigint;
  hookData: Hex;
  /** Sales: whether the coin still needs its one-time approval of Permit2. */
  approval: "needed" | "not-needed" | "unknown";
  /** Sales: the Permit2 allowance to sign at send time, or null when the current one covers the sale. */
  permit: PermitSingle | null;
  /** In order. A sale's trade step carries a stand-in signature until it is sent. */
  steps: Step[];
  /** Sales: what the trade step is built from, so it can be rebuilt with the real signature. */
  sell: { key: PoolKey; hops: Hop[] } | null;
};

/** What a live wallet can do. A dry run has none. */
export type Sender = {
  address: Hex;
  sendTransaction(tx: { to: Hex; data: Hex; value: bigint; gas: bigint }): Promise<Hex>;
  signTypedData(typedData: ReturnType<typeof permitSingleTypedData>): Promise<Hex>;
};

export type Fill = {
  /** Coins bought, or coins sold. */
  coins: bigint;
  /** BNB spent on a buy (gas included), or BNB received from a sale (gas taken off), in wei. */
  bnbWei: bigint;
  gasWei: bigint;
  hashes: Hex[];
};

export type ExecResult = { sent: false; plan: Plan; fill: Fill } | { sent: true; plan: Plan; fill: Fill };

export class TradeRefusedError extends Error {
  constructor(
    /** The contract's own error name, when the chain named one. */
    readonly refusal: string | null,
    message: string,
  ) {
    super(message);
    this.name = "TradeRefusedError";
  }
}

/** The refusal a live sale gets when the wallet no longer holds the coin at all. */
export const NOTHING_HELD = "NothingHeld";

/**
 * A transaction WENT OUT and then failed, or its outcome is not known. Unlike
 * a refusal, this cost gas and may even have landed, so the engine records it:
 * the order counts against the hourly cap and the cooldown, the gas counts
 * against the day, and a buy whose receipt never came is booked at its floor.
 */
export class SentTxError extends Error {
  constructor(
    readonly outcome: "reverted" | "unknown",
    readonly hashes: Hex[],
    /** Gas spent by the transactions that confirmed, in wei. */
    readonly gasWei: bigint,
    message: string,
  ) {
    super(message);
    this.name = "SentTxError";
  }
}

/** One order to quote: a strategy's intent, or a manual `feast-bot quote`. */
export type Ask =
  | Intent
  | { side: "buy"; strategy: "manual"; poolId: Hex; coin: Hex; amountWei: bigint; reason: string }
  | { side: "sell"; strategy: "manual"; poolId: Hex; coin: Hex; coins: bigint; reason: string };

let planCounter = 0;

export class Trader {
  constructor(
    private readonly deps: {
      reader: ChainReader;
      risk: Risk;
      log: Logger;
      /** The wallet's public address: the signer's when live, `[bot] wallet` (or none) in a dry run. */
      wallet: Hex | null;
      /** Null in a dry run, always. */
      sender: Sender | null;
      referrer: Hex | null;
      maxSlippageBps: number;
    },
  ) {
    if (deps.sender && deps.wallet && !sameAddress(deps.sender.address, deps.wallet)) {
      throw new Error("the sender's address is not the wallet this trader was built for");
    }
  }

  get live(): boolean {
    return this.deps.sender !== null;
  }

  /** The address quotes are simulated as, and (live) the address that trades. */
  get wallet(): Hex | null {
    return this.deps.wallet;
  }

  /** Quote and plan an intent. Reads only; sends nothing; throws `TradeRefusedError` when the chain refuses the quote. */
  async plan(intent: Ask): Promise<Plan> {
    const { reader } = this.deps;
    const key = await reader.poolKey(intent.coin, intent.poolId);
    const coinIsCurrency0 = sameAddress(key.currency0, intent.coin);
    const quoteAsset = coinIsCurrency0 ? key.currency1 : key.currency0;
    const route = routeFor(quoteAsset);
    if (!route) throw new TradeRefusedError(null, `no route to the quote asset ${quoteAsset}; this kit's book is out of date`);
    const hookData = hookDataFor(this.deps.referrer);
    const account = this.deps.wallet;
    let amountIn = intent.side === "buy" ? intent.amountWei : intent.coins;
    // A LIVE SALE SELLS WHAT THE WALLET HOLDS: never more than the position, never
    // more than is there. Coins that left the wallet another way are not the
    // bot's to sell, and a sale sized past them would revert every pass.
    if (intent.side === "sell" && this.live && account) {
      const held = await reader.coinBalance(intent.coin, account);
      if (held === 0n) throw new TradeRefusedError(NOTHING_HELD, "the wallet holds none of this coin any more");
      if (held < amountIn) amountIn = held;
    }
    if (amountIn <= 0n) throw new TradeRefusedError(null, "nothing to trade");

    const [quote, spot, now] = await Promise.all([
      intent.side === "buy"
        ? this.buyQuote(key, intent.coin, quoteAsset, route.buy, amountIn, hookData, account)
        : this.sellQuote(key, intent.coin, quoteAsset, route.sell, amountIn, hookData, account),
      reader.spotPrice(intent.poolId, coinIsCurrency0).catch(() => null),
      reader.chainNow(),
    ]);
    const impact = spot === null ? null : curveImpact(intent.side, amountIn, quote, spot);
    const minOut = bpsOf(quote.out, 10_000 - this.deps.maxSlippageBps);
    const deadline = now + DEADLINE_SECONDS;
    const id = `${intent.side}-${intent.poolId.slice(2, 10)}-${now}-${++planCounter}`;
    const base = {
      id,
      side: intent.side,
      strategy: intent.strategy,
      reason: intent.reason,
      poolId: intent.poolId,
      coin: intent.coin,
      quoteAsset,
      amountIn,
      quote,
      minOut,
      spot,
      impact,
      deadline,
      hookData,
    };

    if (intent.side === "buy") {
      const data = encodeExecute(
        buyCommands({ wrappedNative: CONTRACTS.wrappedNative, quote: quoteAsset, coin: intent.coin, hops: route.buy, poolKey: key, amountIn, minOut, hookData }),
        deadline,
      );
      return { ...base, approval: "not-needed", permit: null, sell: null, steps: [{ stage: "trade", to: CONTRACTS.router, data, value: amountIn }] };
    }

    // A SALE: the one-time approval of Permit2, then a signature only when the
    // current Permit2 allowance is short or ends before this sale could land.
    let approval: Plan["approval"] = "unknown";
    let permit: PermitSingle | null;
    if (account) {
      const [approved, allowed] = await Promise.all([
        reader.allowance(intent.coin, account, CONTRACTS.permit2),
        reader.permit2Allowance(account, intent.coin),
      ]);
      approval = approved < amountIn ? "needed" : "not-needed";
      permit =
        allowed.amount < amountIn || allowed.expiration < deadline
          ? permitFor(intent.coin, now, deadline, allowed.nonce)
          : null;
    } else {
      permit = permitFor(intent.coin, now, deadline, 0n);
    }
    const steps: Step[] = [];
    if (approval !== "not-needed") {
      steps.push({
        stage: "approval",
        to: intent.coin,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CONTRACTS.permit2, maxUint256] }),
        value: 0n,
      });
    }
    const sell = { key, hops: route.sell };
    steps.push({ stage: "trade", to: CONTRACTS.router, data: sellData(base, sell, permit, UNSIGNED), value: 0n });
    return { ...base, approval, permit, sell, steps };
  }

  /** What selling `coins` would bring now, in wei, or null when it cannot be quoted. */
  async exitValue(poolId: Hex, coin: Hex, coins: bigint): Promise<bigint | null> {
    if (coins <= 0n) return 0n;
    try {
      const key = await this.deps.reader.poolKey(coin, poolId);
      const quoteAsset = sameAddress(key.currency0, coin) ? key.currency1 : key.currency0;
      const route = routeFor(quoteAsset);
      if (!route) return null;
      const quote = await this.sellQuote(key, coin, quoteAsset, route.sell, coins, hookDataFor(this.deps.referrer), this.deps.wallet);
      return quote.out;
    } catch {
      return null;
    }
  }

  /**
   * What `amount` of a quote asset would sell for in BNB now, in wei, through
   * the same hops a sale takes; the amount itself for wrapped BNB. Null when it
   * cannot be quoted. It turns a pool's quote-asset figures into BNB.
   */
  async bnbValueOf(quoteAsset: Hex, amount: bigint): Promise<bigint | null> {
    if (amount <= 0n) return 0n;
    const route = routeFor(quoteAsset);
    if (!route) return null;
    if (route.sell.length === 0) return amount;
    try {
      return await this.mixed(hopsQuoteArgs(quoteAsset, route.sell, amount), this.deps.wallet);
    } catch {
      return null;
    }
  }

  /**
   * Carry out an approved plan. In a dry run: log it and return a paper fill.
   * Live: send each step, wait for each receipt, and measure the fill from
   * balances.
   */
  async execute(approval: Approval): Promise<ExecResult> {
    const plan = this.deps.risk.redeem(approval);
    const { log } = this.deps;
    const sender = this.deps.sender;

    if (!sender) {
      const simulated = await this.dryRunCheck(plan);
      log.info("order", { mode: "dry-run", sent: false, ...describe(plan), simulated });
      return {
        sent: false,
        plan,
        fill:
          plan.side === "buy"
            ? { coins: plan.quote.out, bnbWei: plan.amountIn, gasWei: 0n, hashes: [] }
            : { coins: plan.amountIn, bnbWei: plan.quote.out, gasWei: 0n, hashes: [] },
      };
    }

    const { reader } = this.deps;
    const me = sender.address;
    log.info("order", { mode: "live", sent: false, stage: "sending", ...describe(plan) });

    // FILLS ARE MEASURED AT THE RECEIPT'S OWN BLOCK, against the block before
    // it — never at "latest", which a public RPC may serve from a node a block
    // behind. When those reads fail, the fill is booked at the floor the
    // transaction carried, which is the least it can have been.
    if (plan.side === "buy") {
      const trade = plan.steps[0] as Step;
      const sent = await this.send(sender, trade, plan, { hashes: [], gasWei: 0n });
      let coins = await this.delta(() => reader.coinBalance(plan.coin, me, sent.block), () => reader.coinBalance(plan.coin, me, sent.block - 1n));
      if (coins === null || coins <= 0n) {
        log.warn("fill_estimated", { side: "buy", planId: plan.id, note: "the balance at the receipt's block could not be read; booked at the floor", minOut: plan.minOut });
        coins = plan.minOut;
      }
      const fill = { coins, bnbWei: plan.amountIn + sent.gasWei, gasWei: sent.gasWei, hashes: [sent.hash] };
      log.info("filled", { mode: "live", side: "buy", poolId: plan.poolId, coin: plan.coin, ...fill });
      return { sent: true, plan, fill };
    }

    const held = await reader.coinBalance(plan.coin, me);
    if (held < plan.amountIn) throw new TradeRefusedError(null, `the wallet holds fewer coins than the sale (${held} < ${plan.amountIn})`);
    const spent = { hashes: [] as Hex[], gasWei: 0n };

    const approvalStep = plan.steps.find((step) => step.stage === "approval");
    if (approvalStep && (await reader.allowance(plan.coin, me, CONTRACTS.permit2)) < plan.amountIn) {
      const sent = await this.send(sender, approvalStep, plan, spent);
      spent.hashes.push(sent.hash);
      spent.gasWei += sent.gasWei;
    }

    let data = (plan.steps.find((step) => step.stage === "trade") as Step).data;
    if (plan.permit && plan.sell) {
      this.deps.risk.assertNotStopped();
      const signature = await sender.signTypedData(permitSingleTypedData({ chainId: CHAIN_ID, permit2: CONTRACTS.permit2, permit: plan.permit }));
      data = sellData(plan, plan.sell, plan.permit, signature);
    }
    const sent = await this.send(sender, { stage: "trade", to: CONTRACTS.router, data, value: 0n }, plan, spent);
    spent.hashes.push(sent.hash);
    spent.gasWei += sent.gasWei;

    // The sale's block alone: its BNB in, its own gas already taken off.
    let proceeds = await this.delta(() => reader.nativeBalance(me, sent.block), () => reader.nativeBalance(me, sent.block - 1n));
    if (proceeds === null) {
      log.warn("fill_estimated", { side: "sell", planId: plan.id, note: "the balance at the receipt's block could not be read; booked at the floor", minOut: plan.minOut });
      proceeds = plan.minOut - sent.gasWei;
    }
    const fill = { coins: plan.amountIn, bnbWei: proceeds - (spent.gasWei - sent.gasWei), gasWei: spent.gasWei, hashes: spent.hashes };
    log.info("filled", { mode: "live", side: "sell", poolId: plan.poolId, coin: plan.coin, ...fill });
    return { sent: true, plan, fill };
  }

  /** `after − before`, or null when either read fails. */
  private async delta(after: () => Promise<bigint>, before: () => Promise<bigint>): Promise<bigint | null> {
    try {
      const [a, b] = await Promise.all([after(), before()]);
      return a - b;
    } catch {
      return null;
    }
  }

  /**
   * One live transaction: simulate (estimate), pad the gas, send, wait.
   * Before it is sent, a failure is a `TradeRefusedError`. After, it is a
   * `SentTxError` carrying every hash and all the gas this order has spent so
   * far (`spent`), so nothing that went out goes unrecorded.
   */
  private async send(
    sender: Sender,
    step: Step,
    plan: Plan,
    spent: { hashes: Hex[]; gasWei: bigint },
  ): Promise<{ hash: Hex; gasWei: bigint; block: bigint }> {
    const { reader, risk, log } = this.deps;
    risk.assertNotStopped();
    let estimate: bigint;
    try {
      estimate = await reader.client.estimateGas({ account: sender.address, to: step.to, data: step.data, value: step.value });
    } catch (error) {
      if (spent.hashes.length > 0) throw new SentTxError("reverted", [...spent.hashes], spent.gasWei, `${step.stage} would revert after an earlier step went out: ${errorText(error)}`);
      const name = refusalName(error);
      throw new TradeRefusedError(name, `${step.stage} would revert: ${name ? `${name}${REFUSAL_HINTS[name] ? ` (${REFUSAL_HINTS[name]})` : ""}` : errorText(error)}`);
    }
    const hash = await sender.sendTransaction({ to: step.to, data: step.data, value: step.value, gas: (estimate * GAS_PAD_PERCENT) / 100n });
    log.info("tx_sent", { stage: step.stage, planId: plan.id, hash });
    let receipt;
    try {
      receipt = await reader.client.waitForReceipt(hash);
    } catch (error) {
      log.error("tx_unconfirmed", { stage: step.stage, planId: plan.id, hash, error: errorText(error) });
      throw new SentTxError("unknown", [...spent.hashes, hash], spent.gasWei, `${step.stage} transaction ${hash} was sent, but no receipt came: ${errorText(error)}`);
    }
    const gasWei = receipt.gasUsed * receipt.effectiveGasPrice;
    if (receipt.status !== "success") {
      log.error("tx_reverted", { stage: step.stage, planId: plan.id, hash, block: receipt.blockNumber, gasWei });
      throw new SentTxError("reverted", [...spent.hashes, hash], spent.gasWei + gasWei, `${step.stage} transaction ${hash} reverted on chain`);
    }
    log.info("tx_confirmed", { stage: step.stage, planId: plan.id, hash, block: receipt.blockNumber, gasWei });
    return { hash, gasWei, block: receipt.blockNumber };
  }

  /**
   * In a dry run with a wallet address, a buy is also simulated as that wallet
   * — the whole transaction, not just the quote. Sales of paper positions are
   * not: the wallet does not hold the coins.
   */
  private async dryRunCheck(plan: Plan): Promise<string> {
    const wallet = this.deps.wallet;
    if (!wallet) return "skipped: no [bot] wallet set";
    if (plan.side === "sell") return "skipped: a paper position is not on chain";
    const trade = plan.steps[0] as Step;
    try {
      await this.deps.reader.client.estimateGas({ account: wallet, to: trade.to, data: trade.data, value: trade.value });
      return "ok";
    } catch (error) {
      const name = refusalName(error);
      return `would revert: ${name ?? errorText(error)}`;
    }
  }

  private async buyQuote(key: PoolKey, coin: Hex, quoteAsset: Hex, hops: Hop[], amountIn: bigint, hookData: Hex, account: Hex | null): Promise<TradeQuote> {
    const legQuote = hops.length > 0 ? await this.mixed(hopsQuoteArgs(CONTRACTS.wrappedNative, hops, amountIn), account) : amountIn;
    const out = await this.mixed(feastQuoteArgs(key, quoteAsset, coin, legQuote, hookData), account);
    // The hook takes 1% of what reaches the pool out of the leg: leg / 101.
    return { out, legQuote, fee: (legQuote * HOOK_FEE_PIPS) / (HOOK_FEE_DENOMINATOR + HOOK_FEE_PIPS) };
  }

  private async sellQuote(key: PoolKey, coin: Hex, quoteAsset: Hex, hops: Hop[], amountIn: bigint, hookData: Hex, account: Hex | null): Promise<TradeQuote> {
    const legQuote = await this.mixed(feastQuoteArgs(key, coin, quoteAsset, amountIn, hookData), account);
    const out = hops.length > 0 ? await this.mixed(hopsQuoteArgs(quoteAsset, hops, legQuote), account) : legQuote;
    // ≈: the hook took 1% of the gross leg, and the leg quoted is what was left.
    return { out, legQuote, fee: (legQuote * HOOK_FEE_PIPS) / (HOOK_FEE_DENOMINATOR - HOOK_FEE_PIPS) };
  }

  private async mixed(args: ReturnType<typeof hopsQuoteArgs>, account: Hex | null): Promise<bigint> {
    try {
      const { result } = await this.deps.reader.client.simulateContract({
        address: CONTRACTS.mixedQuoter,
        abi: QUOTER_ABI,
        functionName: "quoteMixedExactInput",
        args,
        account: account ?? undefined,
      });
      return (result as readonly [bigint, bigint])[0];
    } catch (error) {
      const name = refusalName(error);
      const hint = name ? REFUSAL_HINTS[name] : undefined;
      throw new TradeRefusedError(name, `the quote was refused: ${name ?? errorText(error)}${hint ? ` (${hint})` : ""}`);
    }
  }
}

function permitFor(coin: Hex, now: bigint, deadline: bigint, nonce: bigint): PermitSingle {
  return {
    details: { token: coin, amount: MAX_UINT160, expiration: now + PERMIT_SECONDS, nonce },
    spender: CONTRACTS.router,
    sigDeadline: deadline,
  };
}

function sellData(
  plan: Pick<Plan, "quoteAsset" | "coin" | "amountIn" | "minOut" | "hookData" | "deadline">,
  sell: { key: PoolKey; hops: Hop[] },
  permit: PermitSingle | null,
  signature: Hex,
): Hex {
  return encodeExecute(
    sellCommands({
      wrappedNative: CONTRACTS.wrappedNative,
      quote: plan.quoteAsset,
      coin: plan.coin,
      hops: sell.hops,
      poolKey: sell.key,
      amountIn: plan.amountIn,
      minOut: plan.minOut,
      hookData: plan.hookData,
      permit: permit ? { permit, signature } : null,
    }),
    plan.deadline,
  );
}

/**
 * The expected slippage: the curve's move for this size, net of the hook's
 * fee — the figure the site's trade box shows as "price impact". On a buy the
 * hook takes leg/101 before the swap, so the curve was paid `leg − fee` for
 * `out` coins; on a sale it takes 1% of what the curve paid out, so the curve
 * paid `leg + fee` for the coins in.
 */
export function curveImpact(side: "buy" | "sell", amountIn: bigint, quote: TradeQuote, spot: number): number | null {
  const leg = side === "buy" ? quote.legQuote - quote.fee : quote.legQuote + quote.fee;
  const coins = side === "buy" ? quote.out : amountIn;
  if (!(spot > 0) || leg <= 0n || coins <= 0n) return null;
  const exec = asFloat(leg) / asFloat(coins);
  return Math.abs(exec - spot) / spot;
}

/** A plan as a log line: every figure that decides the order, and the calldata. */
export function describe(plan: Plan): Record<string, unknown> {
  return {
    planId: plan.id,
    side: plan.side,
    strategy: plan.strategy,
    reason: plan.reason,
    poolId: plan.poolId,
    coin: plan.coin,
    quoteAsset: plan.quoteAsset,
    amountIn: plan.amountIn,
    quote: plan.quote,
    minOut: plan.minOut,
    expectedSlippageBps: plan.impact === null ? null : Math.round(plan.impact * 10_000),
    deadline: plan.deadline,
    hookData: plan.hookData,
    ...(plan.side === "sell"
      ? {
          approval: plan.approval,
          permit: plan.permit ? "a Permit2 signature is made at send time; the calldata below holds a stand-in" : "not needed",
        }
      : {}),
    steps: plan.steps.map((step) => ({ stage: step.stage, to: step.to, value: step.value, data: step.data })),
  };
}
