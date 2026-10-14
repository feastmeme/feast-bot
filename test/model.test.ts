import type { Hex } from "viem";
import { describe, expect, it } from "vitest";

import { MAX_REASON_CHARS, ModelNotFoundError, SYSTEM_PROMPT, answerSchema, decisionRequest, findModel, parseAnswer } from "../src/model.js";
import { BNB_POOL, ROUTED_POOL } from "./fixtures.js";
import { HAIKU_ID, MODELS, answer, fakeModel, reply, type ModelInfo } from "./llm-fixtures.js";

const COINS = [BNB_POOL.coin, ROUTED_POOL.coin] as Hex[];

describe("which model", () => {
  it("is read from the Models API by its name, never assumed", async () => {
    expect(await findModel(fakeModel([], MODELS).client)).toEqual({ id: HAIKU_ID, displayName: "Claude Haiku 5.5" });
  });

  it("takes whatever id the API gives Claude Haiku 5.5, the newest when there are two, and never a retired one", async () => {
    const renamed: ModelInfo[] = [
      { ...MODELS[1]!, id: "claude-haiku-5-5-20261007", created_at: "2026-10-07T00:00:00Z" },
      { ...MODELS[1]!, id: "claude-haiku-5-5-20261101", created_at: "2026-11-01T00:00:00Z", lifecycle: "retired" },
      { ...MODELS[1]!, id: "claude-haiku-5-5-20261020", created_at: "2026-10-20T00:00:00Z" },
    ];
    expect((await findModel(fakeModel([], renamed).client)).id).toBe("claude-haiku-5-5-20261020");
  });

  it("fails loudly without it, naming the Haiku models the key can use", async () => {
    const without = MODELS.filter((model) => model.id !== HAIKU_ID);
    await expect(findModel(fakeModel([], without).client)).rejects.toThrow(ModelNotFoundError);
    await expect(findModel(fakeModel([], without).client)).rejects.toThrow(/claude-haiku-4-5-20251001 \(Claude Haiku 4\.5\)/);
    await expect(findModel(fakeModel([], []).client)).rejects.toThrow(/^no Claude Haiku 5\.5 among the 0 models this API key can use\. /);
  });
});

describe("what it is told", () => {
  it("one fixed system prompt, cached for an hour, the same bytes on every decision", () => {
    const a = decisionRequest(HAIKU_ID, '{"at":"2026-10-14T08:00:00.000Z"}', COINS);
    const b = decisionRequest(HAIKU_ID, '{"at":"2026-10-14T08:10:00.000Z"}', COINS);
    expect(a.system).toEqual(b.system);
    expect(a.system).toEqual([{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } }]);
    // Nothing in it that changes: no figure from a pass, no clock.
    expect(SYSTEM_PROMPT).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(SYSTEM_PROMPT).toContain("Every trade pays the pool's hook 1% of its size");
    expect(SYSTEM_PROMPT).toContain("cost about 2% before anything else");
    expect(SYSTEM_PROMPT).toContain("Decide freely");
    expect(SYSTEM_PROMPT).toContain("Size freely within the wallet");
    // The packet is the user turn, the last message; no prefill, no sampling settings.
    expect(a.messages).toEqual([{ role: "user", content: '{"at":"2026-10-14T08:00:00.000Z"}' }]);
    for (const key of ["temperature", "top_p", "top_k", "thinking"]) expect(a).not.toHaveProperty(key);
  });

  it("an answer schema the API can enforce: the configured coins as an enum, every object closed", () => {
    const schema = answerSchema(COINS);
    const item = ((schema.properties as Record<string, { items: Record<string, unknown> }>).decisions!).items;
    expect(schema).toMatchObject({ type: "object", required: ["decisions"], additionalProperties: false });
    expect(item).toMatchObject({ type: "object", required: ["coin", "action", "amount_bnb", "fraction", "reason"], additionalProperties: false });
    expect((item.properties as Record<string, unknown>).coin).toMatchObject({ type: "string", enum: COINS });
    expect((item.properties as Record<string, unknown>).action).toEqual({ type: "string", enum: ["buy", "sell", "hold"] });
    // Limits the API does not take are not sent; parseAnswer holds them.
    expect(JSON.stringify(schema)).not.toMatch(/"(?:minimum|maximum|minLength|maxLength|pattern)"/);
    expect(decisionRequest(HAIKU_ID, "{}", COINS).output_config).toEqual({ format: { type: "json_schema", schema } });
  });
});

describe("what it may answer", () => {
  const coin = BNB_POOL.coin;
  const ok = (text: string) => parseAnswer(reply(text), COINS);

  it("reads the text blocks, not the thinking block before them", () => {
    const parsed = ok(answer([{ coin, action: "buy", amount_bnb: "0.015", reason: "r" }, { coin: ROUTED_POOL.coin, action: "sell", fraction: 0.5 }]));
    expect(parsed).toEqual({
      ok: true,
      decisions: [
        { coin, action: "buy", amountBnb: "0.015", amountWei: 15_000_000_000_000_000n, fraction: 0, reason: "r" },
        { coin: ROUTED_POOL.coin, action: "sell", amountBnb: "0", amountWei: 0n, fraction: 0.5, reason: "sell: test" },
      ],
    });
  });

  it("holds a coin the answer leaves out, and takes coins in any case", () => {
    expect(ok(answer([]))).toEqual({ ok: true, decisions: [] });
    const upper = ok(answer([{ coin: coin.toUpperCase().replace("0X", "0x"), action: "hold" }]));
    expect(upper.ok && upper.decisions[0]?.coin).toBe(coin);
  });

  it.each([
    ["{}", "the reply is not { decisions: [...] }"],
    [JSON.stringify({ decisions: [], note: "x" }), "the reply is not { decisions: [...] }"],
    [JSON.stringify({ decisions: "buy" }), "the reply is not { decisions: [...] }"],
    [answer([{ coin, action: "buy", amount_bnb: "0" }]), "decision 1 buys nothing"],
    [answer([{ coin, action: "sell", fraction: 0 }]), "decision 1 sells nothing"],
    [answer([{ coin, action: "sell", fraction: -0.1 }]), "decision 1 has a fraction outside 0 to 1"],
    [answer([{ coin, action: "buy", amount_bnb: "-1" }]), "decision 1 has an amount_bnb that is not a plain decimal"],
    [answer([{ coin, action: "buy", amount_bnb: "0.0000000000000000001" }]), "decision 1 has an amount_bnb that is not a plain decimal"],
    [answer([{ coin, action: "short" as "buy", amount_bnb: "1" }]), "decision 1 has an action that is not buy, sell or hold"],
    [answer([{ coin, action: "hold", reason: "r".repeat(MAX_REASON_CHARS + 1) }]), `decision 1 has a reason of ${MAX_REASON_CHARS + 1} characters (at most ${MAX_REASON_CHARS})`],
    [JSON.stringify({ decisions: [{ coin, action: "hold", amount_bnb: "0", fraction: 0 }] }), "decision 1 does not have exactly action, amount_bnb, coin, fraction, reason"],
  ])("refuses %s", (text, problem) => {
    expect(ok(text)).toEqual({ ok: false, problem });
  });

  it("a reason of exactly 200 characters is fine", () => {
    expect(ok(answer([{ coin, action: "hold", reason: "r".repeat(MAX_REASON_CHARS) }])).ok).toBe(true);
  });
});
