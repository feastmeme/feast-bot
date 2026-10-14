import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ModelCallError, decisionRequest, findModel, parseAnswer } from "../src/model.js";
import { BNB_POOL } from "./fixtures.js";
import { HAIKU_ID, MODELS, answer, reply } from "./llm-fixtures.js";

/**
 * The adapter with Anthropic's real library, against a LOCAL stand-in for the
 * API on 127.0.0.1: what the library actually sends for a decision, and how
 * its errors come out. Nothing here reaches Anthropic. Skipped when the kit's
 * own packages are not installed (the Feast app's root run).
 */

const installed = existsSync(new URL("../node_modules/@anthropic-ai/sdk/package.json", import.meta.url));
const KEY = `sk-ant-api03-${"Lq7".repeat(30)}`;

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: unknown };

describe.skipIf(!installed)("the Anthropic adapter, against a local stand-in", () => {
  const seen: Seen[] = [];
  let mode: "ok" | "400" | "401" | "529" | "hang" = "ok";
  let baseURL = "";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "request-id": "req_local_1" });
        res.end(JSON.stringify(body));
      };
      if (req.url?.startsWith("/v1/models")) return send(200, { data: MODELS, has_more: false, first_id: MODELS[0]!.id, last_id: MODELS.at(-1)!.id });
      if (mode === "hang") return;
      if (mode === "400") return send(400, { type: "error", error: { type: "invalid_request_error", message: "output_config.format: bad schema" } });
      if (mode === "401") return send(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      if (mode === "529") return send(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
      return send(200, reply(answer([{ coin: BNB_POOL.coin, action: "buy", amount_bnb: "0.01", reason: "local" }])));
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  async function client(options: { timeoutMs?: number } = {}) {
    const { anthropicClient } = await import("../src/anthropic.js");
    return anthropicClient(KEY, { baseURL, maxRetries: 0, ...options });
  }

  it("lists the models and finds Claude Haiku 5.5 among them", async () => {
    expect(await findModel(await client())).toEqual({ id: HAIKU_ID, displayName: "Claude Haiku 5.5" });
    expect(seen.at(-1)).toMatchObject({ method: "GET" });
    expect(seen.at(-1)!.url).toMatch(/^\/v1\/models/);
  });

  it("sends the decision as built: the key in its header, the cached system prompt, the schema, the packet", async () => {
    mode = "ok";
    const body = decisionRequest(HAIKU_ID, '{"coins":[]}', [BNB_POOL.coin]);
    const message = await (await client()).createMessage(body);
    const request = seen.at(-1)!;
    expect(request).toMatchObject({ method: "POST", url: "/v1/messages" });
    expect(request.headers["x-api-key"]).toBe(KEY);
    expect(request.headers["anthropic-version"]).toBeTruthy();
    expect(request.body).toEqual(JSON.parse(JSON.stringify(body)));
    expect(request.body).toMatchObject({
      model: HAIKU_ID,
      system: [{ type: "text", cache_control: { type: "ephemeral", ttl: "1h" } }],
      output_config: { format: { type: "json_schema" } },
      messages: [{ role: "user", content: '{"coins":[]}' }],
    });
    expect(parseAnswer(message, [BNB_POOL.coin])).toMatchObject({ ok: true, decisions: [{ action: "buy", reason: "local" }] });
  });

  it.each([
    ["400", "bad_request", 400],
    ["401", "auth", 401],
    ["529", "server", 529],
  ] as const)("an HTTP %s comes out as a ModelCallError of kind %s, never with the key in it", async (status, kind, code) => {
    mode = status;
    const error = await (await client()).createMessage(decisionRequest(HAIKU_ID, "{}", [BNB_POOL.coin])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error).toMatchObject({ kind, status: code, requestId: "req_local_1" });
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it("goes to Anthropic's API and nowhere else, whatever ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN the shell has", async () => {
    const seenHere: Array<{ url: string; apiKey: string | null; authorization: string | null }> = [];
    const realFetch = globalThis.fetch;
    const saved = { base: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN };
    process.env.ANTHROPIC_BASE_URL = "http://gateway.invalid";
    process.env.ANTHROPIC_AUTH_TOKEN = "gateway-token-0123456789abcdef";
    // The library's own fetch, answered here: nothing leaves this machine.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      seenHere.push({ url: input instanceof Request ? input.url : String(input), apiKey: headers.get("x-api-key"), authorization: headers.get("authorization") });
      return new Response(JSON.stringify({ data: MODELS, has_more: false, first_id: MODELS[0]!.id, last_id: MODELS.at(-1)!.id }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const { anthropicClient } = await import("../src/anthropic.js");
      await anthropicClient(KEY, { maxRetries: 0 }).listModels();
    } finally {
      globalThis.fetch = realFetch;
      if (saved.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved.base;
      if (saved.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
    expect(seenHere).toHaveLength(1);
    expect(seenHere[0]!.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
    expect(seenHere[0]!.apiKey).toBe(KEY);
    expect(seenHere[0]!.authorization).toBeNull();
  });

  it("a reply that does not come in time is a timeout", async () => {
    mode = "hang";
    const error = await (await client({ timeoutMs: 300 })).createMessage(decisionRequest(HAIKU_ID, "{}", [BNB_POOL.coin])).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ModelCallError", kind: "timeout", status: null });
  });
});
