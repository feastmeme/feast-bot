import { describe, expect, it } from "vitest";

import { explainRecord, lastDecisions } from "../src/explain.js";

const COIN = "0x96b1188367ed76d1a81d46407e226462314cfeed";
const OTHER = "0xd9c78728dfb7595955e72c2c576de6a7b7eafeed";

describe("feast-bot explain", () => {
  it("keeps the last N decisions and the stop line, skipping every other line and any cut-off one", () => {
    const lines = [
      JSON.stringify({ ts: "2026-10-14T08:00:00.000Z", event: "tick" }),
      JSON.stringify({ ts: "2026-10-14T08:00:01.000Z", event: "decision", pass: 1 }),
      JSON.stringify({ ts: "2026-10-14T08:10:01.000Z", event: "decision", pass: 2 }),
      '{"ts":"2026-10-14T08:20:01.000Z","event":"decision","pass":3',
      JSON.stringify({ ts: "2026-10-14T08:21:00.000Z", event: "total_loss_stop" }),
    ];
    expect(lastDecisions(lines.join("\n"), 2).map((r) => [r.event, r.pass])).toEqual([
      ["decision", 2],
      ["total_loss_stop", undefined],
    ]);
  });

  it("says what was decided, why, and what became of it", () => {
    const lines = explainRecord({
      ts: "2026-10-14T08:05:00.000Z",
      event: "decision",
      pass: 2,
      early: true,
      triggers: [{ kind: "trade", coin: COIN, bnb: 0.12 }],
      model: "claude-haiku-5-5",
      usage: { inputTokens: 2_000, outputTokens: 400, cacheReadTokens: 1_500, cacheWriteTokens: 0 },
      refusal: null,
      answer: [
        { coin: COIN, action: "sell", amount_bnb: "0", fraction: 0.5, reason: "a large sale, buyers thinning" },
        { coin: OTHER, action: "buy", amount_bnb: "0.02", fraction: 0, reason: "volume rising" },
      ],
      intents: [
        { coin: COIN, side: "sell", amount: "500", approved: true, outcome: "placed", detail: "sent" },
        { coin: OTHER, side: "buy", amount: "0.02", approved: false, outcome: "refused", detail: "PurchaseCapExceeded" },
      ],
      skipped: [],
    });
    expect(lines).toEqual([
      "2026-10-14 08:05 UTC  decision 2, early: a 0.12 BNB trade in 0x96b1…cfeed, claude-haiku-5-5, 2000 tokens in (1500 from the cache), 400 out",
      '  0x96b1…cfeed  sell 50% of the position: "a large sale, buyers thinning" -> placed (sent)',
      '  0xd9c7…afeed  buy 0.02 BNB: "volume rising" -> refused by the chain (PurchaseCapExceeded)',
    ]);
  });

  it("says when there was no decision, and why no order came of it", () => {
    expect(
      explainRecord({
        ts: "2026-10-14T08:10:00.000Z",
        event: "decision",
        pass: 3,
        early: false,
        triggers: [],
        model: "claude-haiku-5-5",
        usage: null,
        refusal: { kind: "model_error", detail: "timeout: Request timed out." },
        answer: null,
        intents: [],
        skipped: [],
      }),
    ).toEqual([
      "2026-10-14 08:10 UTC  decision 3, on schedule, claude-haiku-5-5",
      "  no decision: the model could not be asked (timeout: Request timed out.). No order came of it.",
    ]);
  });

  it("explains the total-loss stop", () => {
    expect(explainRecord({ ts: "2026-10-14T09:00:00.000Z", event: "total_loss_stop", lossBnb: "0.21", maxTotalLossBnb: "0.2", stopFileState: "created" })).toEqual([
      "2026-10-14 09:00 UTC  total-loss stop: the session was 0.21 BNB down (limit 0.2). Nothing was sold; the STOP file was created; the bot exited.",
    ]);
  });
});
