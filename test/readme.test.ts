import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SCHEMA, SECTION_NAMES, keysOf, tomlLiteral, type Field } from "../src/schema.js";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const EXAMPLE = readFileSync(new URL("../bot.example.toml", import.meta.url), "utf8");

/** `| \`key\` | \`default\` | … |` rows under each `### \`[section]\`` heading. */
function readmeTables(): Record<string, Record<string, string>> {
  const tables: Record<string, Record<string, string>> = {};
  let section: string | null = null;
  for (const line of README.split("\n")) {
    const heading = /^### `\[([a-z_]+)\]`$/.exec(line);
    if (heading) {
      section = heading[1] ?? null;
      if (section) tables[section] = {};
      continue;
    }
    if (line.startsWith("## ")) section = null;
    const row = /^\| `([a-z_]+)` \| `([^`]*)` \|/.exec(line);
    if (section && row) (tables[section] as Record<string, string>)[row[1] as string] = row[2] as string;
  }
  return tables;
}

describe("README.md", () => {
  it("documents every setting, with the schema's own default, and nothing else", () => {
    const tables = readmeTables();
    expect(Object.keys(tables).sort()).toEqual([...SECTION_NAMES].sort());
    for (const section of SECTION_NAMES) {
      const fields = SCHEMA[section] as Record<string, Field>;
      expect(Object.keys(tables[section] ?? {}), section).toEqual(keysOf(section));
      for (const key of keysOf(section)) expect(tables[section]?.[key], `${section}.${key}`).toBe(tomlLiteral(fields[key]!.default));
    }
  });

  it.each([
    ["README.md", README],
    ["bot.example.toml", EXAMPLE],
  ])("%s keeps to the copy rules: no return language, no ticker, no dollar sign", (_name, text) => {
    expect(text).not.toMatch(/\bearn|profit|guarantee|\bAPY\b|\bAPR\b|\byield|\$/i);
    // The only symbols the kit's words may use.
    const symbols = (text.match(/\b[A-Z]{3,6}\b/g) ?? []).filter((word) => !["BNB", "USDT", "API", "RPC", "URL", "UTC", "JSON", "JSONL", "STOP", "TOML", "README"].includes(word));
    expect(symbols).toEqual([]);
  });

  const book = fileURLToPath(new URL("../../../sandbox/mainnet/addresses.json", import.meta.url));
  it.skipIf(!existsSync(book))("names none of the quote assets the Feast app's book lists", () => {
    const { symbols } = JSON.parse(readFileSync(book, "utf8")) as { symbols: string[] };
    for (const symbol of [...symbols, "WBNB", "FEAST"]) {
      expect(README, symbol).not.toMatch(new RegExp(`\\b${symbol}\\b`));
      expect(EXAMPLE, symbol).not.toMatch(new RegExp(`\\b${symbol}\\b`));
    }
  });
});
