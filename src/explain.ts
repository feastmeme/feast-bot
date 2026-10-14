/**
 * `feast-bot explain`: the model's last decisions, in plain words, read back
 * from the JSONL log. Every line it prints comes from a `decision` record the
 * advisor wrote (or the total-loss stop's last line): nothing is asked again.
 */

type Record = { [key: string]: unknown };

const OUTCOME_WORDS: { [outcome: string]: string } = {
  placed: "placed",
  blocked: "blocked by the risk gate",
  refused: "refused by the chain",
  unquoted: "could not be quoted",
  position_gone: "nothing left in the wallet to sell",
  failed: "failed",
  failed_after_send: "failed after it was sent",
};

const REFUSAL_WORDS: { [kind: string]: string } = {
  model_error: "the model could not be asked",
  schema: "the model's answer was refused",
  packet: "the packet was refused before sending",
  gather: "the figures could not be read",
};

/** The last `count` decisions (and any total-loss stop), oldest first, from a JSONL log's text. */
export function lastDecisions(logText: string, count: number): Record[] {
  const out: Record[] = [];
  for (const line of logText.split("\n")) {
    if (!line.includes('"event":"decision"') && !line.includes('"event":"total_loss_stop"')) continue;
    try {
      const parsed = JSON.parse(line) as Record;
      if (parsed.event === "decision" || parsed.event === "total_loss_stop") out.push(parsed);
    } catch {
      // A line cut off mid-write: skipped.
    }
  }
  return out.slice(-count);
}

/** One record as a few lines a person reads. */
export function explainRecord(record: Record): string[] {
  const when = typeof record.ts === "string" ? `${record.ts.slice(0, 16).replace("T", " ")} UTC` : "(no time)";
  if (record.event === "total_loss_stop") {
    return [`${when}  total-loss stop: the session was ${String(record.lossBnb)} BNB down (limit ${String(record.maxTotalLossBnb)}). Nothing was sold; the STOP file was ${String(record.stopFileState)}; the bot exited.`];
  }
  const usage = record.usage as { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null;
  const triggers = Array.isArray(record.triggers) ? (record.triggers as Array<{ kind: string; coin: string; bnb?: number; ageMin?: number }>) : [];
  const why = record.early
    ? `early: ${triggers.map((t) => (t.kind === "trade" ? `a ${t.bnb} BNB trade in ${short(t.coin)}` : `${short(t.coin)}'s pool is ${t.ageMin} minutes old`)).join(", ") || "an event"}`
    : "on schedule";
  const cost = usage ? `, ${usage.inputTokens} tokens in (${usage.cacheReadTokens} from the cache), ${usage.outputTokens} out` : "";
  const lines = [`${when}  decision ${String(record.pass)}, ${why}, ${String(record.model)}${cost}`];

  const refusal = record.refusal as { kind: string; detail: string } | null;
  if (refusal) {
    lines.push(`  no decision: ${REFUSAL_WORDS[refusal.kind] ?? refusal.kind} (${refusal.detail}). No order came of it.`);
    return lines;
  }
  const intents = (Array.isArray(record.intents) ? record.intents : []) as Array<{ coin: string; side: string; outcome: string; detail?: string | null }>;
  const skipped = (Array.isArray(record.skipped) ? record.skipped : []) as Array<{ coin: string; why: string }>;
  const answer = (Array.isArray(record.answer) ? record.answer : []) as Array<{ coin: string; action: string; amount_bnb: string; fraction: number; reason: string }>;
  if (answer.length === 0) lines.push("  the model held every coin");
  for (const item of answer) {
    const what = item.action === "buy" ? `buy ${item.amount_bnb} BNB` : item.action === "sell" ? `sell ${Math.round(item.fraction * 1000) / 10}% of the position` : "hold";
    const intent = intents.find((entry) => entry.coin === item.coin && entry.side === item.action);
    const skip = skipped.find((entry) => entry.coin === item.coin);
    const result = intent
      ? ` -> ${OUTCOME_WORDS[intent.outcome] ?? intent.outcome}${intent.detail ? ` (${intent.detail})` : ""}`
      : skip
        ? ` -> not placed: ${skip.why}`
        : "";
    lines.push(`  ${short(item.coin)}  ${what}: "${item.reason}"${result}`);
  }
  return lines;
}

/** An address shortened for reading: `0x96b1…cfeed`. */
function short(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-5)}` : address;
}
