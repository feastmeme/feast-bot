/**
 * THE ONE PLACE THAT LOADS ANTHROPIC'S LIBRARY, and only `run` with
 * `[llm_manager]` on loads this file (`cli.ts` imports it when it needs it),
 * so every other command, and every test, runs without it.
 *
 * The API key is handed in from `ANTHROPIC_API_KEY` in the environment —
 * never from the config — and the CLI registers it with the logger's
 * redaction before anything can print. Errors leave this module as
 * `ModelCallError`s, classified by the library's own error classes.
 */

// See model.ts: the Feast app's typecheck compiles this folder without the
// kit's node_modules; the kit's own typecheck checks this import in full.
// @ts-ignore -- resolved by the kit's own install, absent from the Feast app's
import Anthropic from "@anthropic-ai/sdk";

import { ModelCallError, type ModelClient } from "./model.js";

/** A pass is one call; a call that has not answered in a minute is retried once, then logged as a timeout. */
const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 1;

/** Where the key and the packets go: Anthropic's API, and nowhere else. */
const API_BASE = "https://api.anthropic.com";

/**
 * `options` are for the kit's own tests, which point it at a local stand-in
 * for the API. Otherwise the host is pinned: the library would read
 * ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN from the shell, and a shell set
 * up for some gateway would then send the key and every packet there. Its own
 * console logging is off: the bot's output is its JSONL log.
 */
export function anthropicClient(apiKey: string, options: { baseURL?: string; timeoutMs?: number; maxRetries?: number } = {}): ModelClient {
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: options.baseURL ?? API_BASE,
    timeout: options.timeoutMs ?? TIMEOUT_MS,
    maxRetries: options.maxRetries ?? MAX_RETRIES,
    logLevel: "off",
  });
  return {
    async listModels() {
      try {
        const models: Anthropic.ModelInfo[] = [];
        for await (const model of client.models.list()) models.push(model as Anthropic.ModelInfo);
        return models;
      } catch (error) {
        throw classify(error);
      }
    },
    async createMessage(body: Anthropic.MessageCreateParamsNonStreaming) {
      try {
        return (await client.messages.create(body)) as Anthropic.Message;
      } catch (error) {
        throw classify(error);
      }
    },
  };
}

/** Most specific first: a timeout is a connection error, and every one of these is an `APIError`. */
function classify(error: unknown): ModelCallError {
  // Read through a plain shape: where the library's types are absent (the Feast app's typecheck), `instanceof` cannot narrow.
  const api = error instanceof Anthropic.APIError ? (error as { requestID?: unknown; status?: unknown }) : null;
  const requestId = typeof api?.requestID === "string" ? api.requestID : null;
  const status = typeof api?.status === "number" ? api.status : null;
  const message = error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error);
  const kind =
    error instanceof Anthropic.APIConnectionTimeoutError
      ? "timeout"
      : error instanceof Anthropic.APIConnectionError
        ? "connection"
        : error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError
          ? "auth"
          : error instanceof Anthropic.NotFoundError
            ? "not_found"
            : error instanceof Anthropic.RateLimitError
              ? "rate_limited"
              : error instanceof Anthropic.BadRequestError
                ? "bad_request"
                : error instanceof Anthropic.InternalServerError
                  ? "server"
                  : error instanceof Anthropic.APIError
                    ? "api"
                    : "unknown";
  return new ModelCallError(kind, status, message, requestId);
}
