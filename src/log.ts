/**
 * Structured logs: one JSON object per line, to stdout and to a JSONL file.
 *
 * Every line is `{ ts, level, event, ...fields }`. Amounts are decimal strings
 * of base units (bigints are written as strings, never rounded through a
 * float), so the file can be replayed exactly.
 *
 * THE KEY NEVER APPEARS. Nothing in this kit passes the key to the logger;
 * as a second line of defence, every string registered with `redact()` is
 * replaced by "[redacted]" in every line before it is written anywhere.
 */

import { appendFileSync } from "node:fs";

export type Level = "info" | "warn" | "error";

export type LogSink = (line: string) => void;

export class Logger {
  private readonly secrets: string[] = [];

  constructor(
    private readonly options: {
      /** Where human-visible lines go. Default: stdout. */
      out?: LogSink;
      /** The JSONL file, or null for none. */
      file?: string | null;
      append?: (path: string, data: string) => void;
      now?: () => Date;
    } = {},
  ) {}

  /** Never print this string, in any case, anywhere. */
  redact(secret: string): void {
    if (secret.length >= 16 && !this.secrets.includes(secret)) this.secrets.push(secret);
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.write("error", event, fields);
  }

  private write(level: Level, event: string, fields: Record<string, unknown>): void {
    const ts = (this.options.now?.() ?? new Date()).toISOString();
    let line = JSON.stringify({ ts, level, event, ...fields }, replacer);
    for (const secret of this.secrets) line = replaceAllCaseless(line, secret, "[redacted]");
    (this.options.out ?? ((text: string) => process.stdout.write(`${text}\n`)))(line);
    if (this.options.file) {
      (this.options.append ?? ((path: string, data: string) => appendFileSync(path, data, { mode: 0o600 })))(this.options.file, `${line}\n`);
    }
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

function replaceAllCaseless(haystack: string, needle: string, by: string): string {
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let out = "";
  let from = 0;
  for (;;) {
    const at = lowerHay.indexOf(lowerNeedle, from);
    if (at === -1) return out + haystack.slice(from);
    out += haystack.slice(from, at) + by;
    from = at + needle.length;
  }
}

/** A short message for an unknown thrown value, without its stack or its cause chain. */
export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    return typeof short === "string" && short ? short : error.message.split("\n")[0] ?? error.name;
  }
  return String(error);
}
