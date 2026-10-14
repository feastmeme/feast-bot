/**
 * The part of TOML a bot config needs, and a clear refusal for the rest.
 *
 * Written here rather than installed because this program holds a private
 * key, and every dependency it loads is code that runs next to that key. viem
 * is the one runtime dependency; a config parser is small enough to read.
 *
 * Supported: `#` comments, `[table]` and `[dotted.table]` headers, bare keys,
 * basic "strings" (with \" \\ \n \t \uXXXX escapes) and 'literal strings',
 * integers and decimals (with `_` separators), true/false, and arrays of those,
 * across several lines if you like. Anything else — inline tables, arrays of
 * tables, multi-line strings, dates, dotted keys — is refused with its line
 * number, never guessed at.
 */

export type TomlValue = string | number | boolean | TomlValue[];
export type TomlTable = { [key: string]: TomlValue | TomlTable };

export class TomlError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = "TomlError";
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function parseToml(source: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const definedTables = new Set<string>();
  const lines = source.replace(/\r\n?/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    const text = stripComment(lines[index] ?? "", lineNo).trim();
    if (text === "") continue;

    if (text.startsWith("[[")) throw new TomlError("arrays of tables ([[…]]) are not supported", lineNo);
    if (text.startsWith("[")) {
      if (!text.endsWith("]")) throw new TomlError("a table header must end with ]", lineNo);
      const name = text.slice(1, -1).trim();
      const parts = name.split(".").map((part) => part.trim());
      if (parts.some((part) => !BARE_KEY.test(part))) throw new TomlError(`bad table name ${shown(name)}`, lineNo);
      const path = parts.join(".");
      if (definedTables.has(path)) throw new TomlError(`table ${shown(path)} is defined twice`, lineNo);
      definedTables.add(path);
      current = root;
      for (const part of parts) {
        const existing = current[part];
        if (existing === undefined) {
          const table: TomlTable = {};
          current[part] = table;
          current = table;
        } else if (isTable(existing)) {
          current = existing;
        } else {
          throw new TomlError(`table ${shown(path)} collides with a value`, lineNo);
        }
      }
      continue;
    }

    const eq = text.indexOf("=");
    if (eq === -1) throw new TomlError("expected key = value", lineNo);
    const key = text.slice(0, eq).trim();
    if (key.includes(".")) throw new TomlError(`dotted keys (${shown(key)}) are not supported; use a [table]`, lineNo);
    if (!BARE_KEY.test(key)) throw new TomlError(`bad key ${shown(key)}`, lineNo);
    if (key in current) throw new TomlError(`${shown(key)} is set twice`, lineNo);

    // An array may run over several lines: keep reading until its brackets close.
    let raw = text.slice(eq + 1).trim();
    if (raw.startsWith("[")) {
      while (!bracketsClosed(raw, lineNo)) {
        index++;
        if (index >= lines.length) throw new TomlError(`the array for ${shown(key)} is never closed`, lineNo);
        raw += " " + stripComment(lines[index] ?? "", index + 1).trim();
      }
    }
    const reader = new ValueReader(raw, lineNo);
    const value = reader.value();
    reader.end();
    current[key] = value;
  }
  return root;
}

/**
 * Text from the file, for an error message — unless it holds a long run of
 * hex. A private key pasted into the config by mistake must not come back
 * out in the error that refuses it.
 */
export function shown(text: string): string {
  if (/[0-9a-fA-F]{32,}/.test(text)) return "(a long hex string, not shown)";
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text);
}

function isTable(value: TomlValue | TomlTable | undefined): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The line up to its first `#` that is not inside a string. */
function stripComment(line: string, lineNo: number): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"' && ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (line.startsWith(ch.repeat(3), i)) throw new TomlError("multi-line strings are not supported", lineNo);
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function bracketsClosed(raw: string, lineNo: number): boolean {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote === '"' && ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
  }
  if (quote) throw new TomlError("a string is never closed", lineNo);
  return depth <= 0;
}

class ValueReader {
  private at = 0;

  constructor(
    private readonly text: string,
    private readonly lineNo: number,
  ) {}

  value(): TomlValue {
    this.space();
    const ch = this.text[this.at];
    if (ch === undefined) throw this.fail("a value is missing");
    if (ch === '"') return this.basicString();
    if (ch === "'") return this.literalString();
    if (ch === "[") return this.array();
    if (ch === "{") throw this.fail("inline tables ({…}) are not supported; use a [table]");
    const word = /^[^\s,\]]+/.exec(this.text.slice(this.at))?.[0] ?? "";
    this.at += word.length;
    if (word === "true") return true;
    if (word === "false") return false;
    if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(word) && !/__|_\.|\._|_$|^[+-]?_/.test(word)) {
      if (/^[+-]?0\d/.test(word)) throw this.fail(`leading zeros are not allowed (${shown(word)})`);
      return Number(word.replace(/_/g, ""));
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(word)) throw this.fail("dates are not supported; write the value as a string");
    throw this.fail(`not a value: ${shown(word)} (strings need quotes)`);
  }

  end(): void {
    this.space();
    if (this.at < this.text.length) throw this.fail(`unexpected text after the value: ${shown(this.text.slice(this.at))}`);
  }

  private array(): TomlValue[] {
    this.at++; // [
    const items: TomlValue[] = [];
    for (;;) {
      this.space();
      if (this.text[this.at] === "]") {
        this.at++;
        return items;
      }
      items.push(this.value());
      this.space();
      const ch = this.text[this.at];
      if (ch === ",") {
        this.at++;
        continue;
      }
      if (ch === "]") {
        this.at++;
        return items;
      }
      throw this.fail("expected , or ] in an array");
    }
  }

  private basicString(): string {
    this.at++; // "
    let out = "";
    while (this.at < this.text.length) {
      const ch = this.text[this.at++];
      if (ch === '"') return out;
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const esc = this.text[this.at++];
      if (esc === '"' || esc === "\\") out += esc;
      else if (esc === "n") out += "\n";
      else if (esc === "t") out += "\t";
      else if (esc === "u") {
        const hex = this.text.slice(this.at, this.at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.fail("bad \\u escape");
        out += String.fromCharCode(parseInt(hex, 16));
        this.at += 4;
      } else throw this.fail(`unsupported escape \\${esc ?? ""}`);
    }
    throw this.fail("a string is never closed");
  }

  private literalString(): string {
    this.at++; // '
    const close = this.text.indexOf("'", this.at);
    if (close === -1) throw this.fail("a string is never closed");
    const out = this.text.slice(this.at, close);
    this.at = close + 1;
    return out;
  }

  private space(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at] ?? "")) this.at++;
  }

  private fail(message: string): TomlError {
    return new TomlError(message, this.lineNo);
  }
}
