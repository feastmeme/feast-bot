/**
 * THE MODEL: which one, what it is told, what it may answer.
 *
 * `llm_manager` asks Claude Haiku 5.5 through Anthropic's Messages API, with
 * Anthropic's own library (`anthropic.ts` holds the one place that builds a
 * client). This module holds everything around that call that can be checked
 * without a network: the model is FOUND, never assumed — its id is read from
 * the Models API at start and the bot refuses to start without one; the system
 * prompt is fixed text, cached for an hour; the answer has a JSON schema the
 * API holds the model to, and is checked again here, field by field, because
 * the API cannot hold a string's length or a number's range.
 *
 * Nothing here sends an order: an answer becomes intents in
 * `strategies/llmManager.ts`, and every intent still passes `risk.ts`.
 */

// The Feast app's own typecheck compiles this folder with the app's
// node_modules, which do not carry Anthropic's library; there this import
// resolves to nothing and the types below to `any`. The kit's own typecheck
// (`npm run typecheck`, with the kit installed) checks them in full. A type
// import only: nothing here loads the library at run time.
// @ts-ignore -- resolved by the kit's own install, absent from the Feast app's
import type Anthropic from "@anthropic-ai/sdk";

import type { Hex } from "./book.js";
import { parseAmount } from "./units.js";

/**
 * The two calls the advisor makes, narrowed from Anthropic's client so a test
 * can hand in a fake (as `ChainClient` is narrowed from viem's). Both throw a
 * `ModelCallError` and nothing else.
 */
export interface ModelClient {
  /** Every model the API key may use: `GET /v1/models`, every page. */
  listModels(): Promise<Anthropic.ModelInfo[]>;
  /** One Messages API call. */
  createMessage(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export type ModelErrorKind = "timeout" | "connection" | "auth" | "not_found" | "rate_limited" | "bad_request" | "server" | "api" | "unknown";

export class ModelCallError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    readonly status: number | null,
    message: string,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

// ── Which model ────────────────────────────────────────────────────────────

/** The model the owner chose, by the name the Models API gives it. */
export const MODEL_NAME = "Claude Haiku 5.5";
const MODEL_NAME_PATTERN = /^claude haiku 5\.5$/i;

export class ModelNotFoundError extends Error {
  override name = "ModelNotFoundError";
}

/**
 * Claude Haiku 5.5's id, read from the Models API by its name: never guessed.
 * Several matches (a dated snapshot beside its alias) resolve to the newest.
 * None is an error that names the Haiku models the key can see, so the owner
 * knows what is there instead.
 */
export async function findModel(client: ModelClient): Promise<{ id: string; displayName: string }> {
  const models: Anthropic.ModelInfo[] = await client.listModels();
  const matches = models
    .filter((model: Anthropic.ModelInfo) => MODEL_NAME_PATTERN.test(model.display_name.trim()) && model.lifecycle !== "retired")
    .sort((a: Anthropic.ModelInfo, b: Anthropic.ModelInfo) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const found: Anthropic.ModelInfo | undefined = matches[0];
  if (!found) {
    const haikus = models
      .filter((model: Anthropic.ModelInfo) => model.line === "haiku" || /haiku/i.test(model.display_name))
      .map((model: Anthropic.ModelInfo) => `${model.id} (${model.display_name})`);
    throw new ModelNotFoundError(
      `no ${MODEL_NAME} among the ${models.length} models this API key can use${haikus.length ? `; the Haiku models it can use: ${haikus.join(", ")}` : ""}. [llm_manager] runs on ${MODEL_NAME} only.`,
    );
  }
  return { id: found.id, displayName: found.display_name };
}

// ── What it is told ────────────────────────────────────────────────────────

/**
 * THE FIXED SYSTEM PROMPT. It never changes between passes — no clock, no
 * figure, no coin — so it is cached (one hour) and every pass after the first
 * reads it from the cache. The packet, which does change, goes in the user turn.
 */
export const SYSTEM_PROMPT = `You manage a small trading book on Feast for its owner. Every message you receive is one packet of numbers about a fixed list of coins and about the book. You answer with one decision per coin: buy, sell or hold.

## What Feast is
- Feast is a meme-coin factory on BNB Smart Chain. Every coin has one pool on PancakeSwap Infinity, paired with a quote asset: wrapped BNB, or a tokenized stock reached from BNB through one or two other pools.
- Every trade pays the pool's hook 1% of its size. A buy and a later sale of the same coins therefore cost about 2% before anything else.
- On top of the 1% each way: the price impact of the trade's own size (larger in a thin pool), the fees of the other pools a routed trade passes through (about 0.25% to 0.5% each way), and gas.
- In a pool's first two blocks with trades, each wallet's buy is capped (the opening cap). A buy over the cap is refused and costs nothing.
- Every order is quoted on chain before it is placed, and every transaction carries a floor a few percent below its quote: if the price moves further before it lands, the chain reverts it.

## The packet
It is JSON. Numbers are numbers, null means not known, addresses and ids are hex, times are UTC timestamps. All BNB figures are in whole BNB.
- at: when the packet was made. early: true when a large trade or a young pool woke this pass ahead of schedule. minutesSinceLastPass: null on the first pass.
- account.wallet: the wallet's address.
- account.bnbBalance: the BNB the wallet can spend now.
- account.equityBnb: BNB by the bot's own book plus what every open position would sell for now.
- account.startEquityBnb: the same, when the session began at account.sessionStartedAt.
- account.realizedBnb, account.unrealizedBnb: results since the session began, closed and still open.
- account.maxTotalLossBnb: how far below startEquityBnb equity may fall. account.lossBudgetLeftBnb: how much of that is left.
- account.lastActionAt, account.minutesSinceLastAction: the bot's last order on any coin.
- coins: one entry per coin you manage.
- coin, poolId, creator: the coin's address, its pool's id, its creator's address.
- createdAt, poolAgeMin: when the pool opened, and its age in minutes.
- priceBnb: the price now, in BNB per whole coin.
- priceChangePct: percent change of the price over the last 1m, 5m, 15m and 60m.
- volumeBnb: BNB traded over the same windows, buys and sales together.
- trades: over the last 15m and 60m, the count, perMin (trades a minute), buys, sells, uniqueBuyers (distinct buying wallets), buyBnb, sellBnb and buySellRatio (buyBnb divided by sellBnb; null with no sales). trades is null while the bot is still reading the pool's history.
- holders: wallets holding the coin now. holdersChange: the change over the last 15m and 60m.
- lastTradeAt: the pool's last trade.
- openingCapBinding: true while the opening cap applies.
- creatorPriorCoins: the creator's other coins: count, and for each one its holders and its trades since launch. Absent when not known.
- position: null when the book holds none of this coin. Otherwise coins (whole coins held), costBnb (BNB spent, gas included), valueBnb (what selling all of it would bring now, fees and impact included), unrealizedBnb (valueBnb minus costBnb), realizedBnb (this coin, this session), openedAt and minutesHeld.
- lastOrderAt, minutesSinceLastOrder: the bot's last order on this coin.

## Rules
- Decide freely for each coin, from the numbers.
- Size freely within the wallet. A buy spends amount_bnb from bnbBalance; keep at least 0.005 BNB unspent for gas. A buy larger than the balance is dropped.
- A sale sells fraction of the position (1 sells all of it). Without a position there is nothing to sell.
- The session stops for good when its loss reaches maxTotalLossBnb: the bot then sells nothing, stops trading and exits. Nothing else limits your orders.
- Every buy and every sale pays the costs above. Holding costs nothing.

## Your answer
- decisions: one entry for each coin in the packet, with coin copied exactly.
- action: buy, sell or hold.
- amount_bnb: for buy, the BNB to spend as a plain decimal string such as "0.01". "0" otherwise.
- fraction: for sell, the share of the position to sell, more than 0 and at most 1. 0 otherwise.
- reason: at most 200 characters of plain words, naming the numbers that decided it.`;

/** One answer field the API cannot hold the model to, held here. */
export const MAX_REASON_CHARS = 200;

/**
 * The answer's JSON schema, as the API enforces it. The coin is an enum of
 * the configured coins, so the model cannot name another one. The API does
 * not take length or range limits, so the reason's length and the fraction's
 * range are checked by `parseAnswer`.
 */
export function answerSchema(coins: readonly Hex[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      decisions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            coin: { type: "string", enum: [...coins], description: "The coin's address, copied from the packet." },
            action: { type: "string", enum: ["buy", "sell", "hold"] },
            amount_bnb: { type: "string", description: 'For buy: BNB to spend, a plain decimal such as "0.01". Otherwise "0".' },
            fraction: { type: "number", description: "For sell: share of the position to sell, more than 0 and at most 1. Otherwise 0." },
            reason: { type: "string", description: `At most ${MAX_REASON_CHARS} characters.` },
          },
          required: ["coin", "action", "amount_bnb", "fraction", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["decisions"],
    additionalProperties: false,
  };
}

/**
 * The request for one pass. The system prompt is the cached prefix (one hour:
 * a pass every ten minutes reads it back each time); the packet is the user
 * turn. No sampling parameters and no prefill: Claude Haiku 5.5 refuses both.
 * Thinking is left at the model's default, and counts toward `max_tokens`.
 */
export function decisionRequest(model: string, packetJson: string, coins: readonly Hex[]): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: 16_000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: packetJson }],
    output_config: { format: { type: "json_schema", schema: answerSchema(coins) } },
  };
}

// ── What it may answer ─────────────────────────────────────────────────────

export type ModelDecision = {
  coin: Hex;
  action: "buy" | "sell" | "hold";
  /** As the model wrote it. */
  amountBnb: string;
  /** Buys: `amount_bnb` in wei. */
  amountWei: bigint;
  fraction: number;
  reason: string;
};

export type ParsedAnswer = { ok: true; decisions: ModelDecision[] } | { ok: false; problem: string };

const ACTIONS = new Set(["buy", "sell", "hold"]);
const DECISION_KEYS = ["action", "amount_bnb", "coin", "fraction", "reason"];

/**
 * The model's reply, checked against the schema and the limits the schema
 * cannot carry. Anything off — a refusal, a cut-off reply, a reply that is not
 * JSON, an unknown or repeated coin, a field too long, out of range or missing,
 * a field the schema does not have — refuses the WHOLE answer: no intent this
 * pass. A coin the answer leaves out is held.
 */
export function parseAnswer(message: Pick<Anthropic.Message, "content" | "stop_reason" | "stop_details">, coins: readonly Hex[]): ParsedAnswer {
  if (message.stop_reason !== "end_turn") {
    const category = message.stop_reason === "refusal" ? message.stop_details?.category : null;
    return { ok: false, problem: `the reply stopped with ${String(message.stop_reason)}${category ? ` (${category})` : ""}` };
  }
  // Blocks by type, never by position: a thinking block comes first.
  const text = message.content
    .filter((block: Anthropic.ContentBlock): block is Anthropic.TextBlock => block.type === "text")
    .map((block: Anthropic.TextBlock) => block.text)
    .join("");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, problem: "the reply is not JSON" };
  }
  if (!isRecord(body) || Object.keys(body).join() !== "decisions" || !Array.isArray(body.decisions)) {
    return { ok: false, problem: "the reply is not { decisions: [...] }" };
  }
  const known = new Set(coins.map((coin) => coin.toLowerCase()));
  const seen = new Set<string>();
  const decisions: ModelDecision[] = [];
  for (const [index, item] of body.decisions.entries()) {
    const where = `decision ${index + 1}`;
    if (!isRecord(item) || Object.keys(item).sort().join() !== DECISION_KEYS.join()) return { ok: false, problem: `${where} does not have exactly ${DECISION_KEYS.join(", ")}` };
    const { coin, action, amount_bnb: amountBnb, fraction, reason } = item;
    if (typeof coin !== "string" || !known.has(coin.toLowerCase())) return { ok: false, problem: `${where} names a coin that is not configured` };
    if (seen.has(coin.toLowerCase())) return { ok: false, problem: `${where} repeats a coin` };
    seen.add(coin.toLowerCase());
    if (typeof action !== "string" || !ACTIONS.has(action)) return { ok: false, problem: `${where} has an action that is not buy, sell or hold` };
    if (typeof reason !== "string") return { ok: false, problem: `${where} has no reason` };
    if (reason.length > MAX_REASON_CHARS) return { ok: false, problem: `${where} has a reason of ${reason.length} characters (at most ${MAX_REASON_CHARS})` };
    if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return { ok: false, problem: `${where} has a fraction outside 0 to 1` };
    let amountWei: bigint;
    try {
      if (typeof amountBnb !== "string") throw new Error("not a string");
      amountWei = parseAmount(amountBnb);
    } catch {
      return { ok: false, problem: `${where} has an amount_bnb that is not a plain decimal` };
    }
    if (action === "buy" && amountWei === 0n) return { ok: false, problem: `${where} buys nothing` };
    if (action === "sell" && fraction === 0) return { ok: false, problem: `${where} sells nothing` };
    decisions.push({ coin: coin.toLowerCase() as Hex, action: action as ModelDecision["action"], amountBnb: amountBnb as string, amountWei, fraction, reason });
  }
  return { ok: true, decisions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
