import { describe, expect, it } from "vitest";

import { parseToml, TomlError } from "../src/toml.js";

describe("the TOML subset", () => {
  it("reads tables, scalars, arrays and comments", () => {
    const parsed = parseToml(`
# a comment
top = "x" # trailing comment
[bot]
name = "a # not a comment"
literal = 'C:\\path'
count = 1_000
ratio = -0.25
on = true
[mean_reversion]
pools = [
  "0xaa", # first
  "0xbb",
]
empty = []
[deep.table]
n = 1e3
`);
    expect(parsed).toEqual({
      top: "x",
      bot: { name: "a # not a comment", literal: "C:\\path", count: 1000, ratio: -0.25, on: true },
      mean_reversion: { pools: ["0xaa", "0xbb"], empty: [] },
      deep: { table: { n: 1000 } },
    });
  });

  it("decodes escapes in basic strings", () => {
    expect(parseToml(`s = "a\\"b\\\\c\\n\\u00e9"`)).toEqual({ s: 'a"b\\c\né' });
  });

  it.each([
    ["inline tables", `x = { a = 1 }`, /inline tables/],
    ["arrays of tables", `[[x]]`, /arrays of tables/],
    ["multi-line strings", `x = """a"""`, /multi-line/],
    ["dotted keys", `a.b = 1`, /dotted keys/],
    ["dates", `x = 2026-10-13`, /dates/],
    ["bare words", `x = hello`, /strings need quotes/],
    ["a key set twice", `x = 1\nx = 2`, /set twice/],
    ["a table defined twice", `[a]\n[a]`, /defined twice/],
    ["an unclosed array", `x = [1,\n2`, /never closed/],
    ["leading zeros", `x = 007`, /leading zeros/],
    ["text after a value", `x = 1 2`, /unexpected text/],
  ])("refuses %s, naming the line", (_what, source, message) => {
    let caught: unknown;
    try {
      parseToml(source);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TomlError);
    expect(String((caught as Error).message)).toMatch(message);
    expect(String((caught as Error).message)).toMatch(/^line \d+: /);
  });

  it("never echoes a long hex string from the file, so a pasted key does not come back out", () => {
    const key = "ab".repeat(32);
    for (const source of [`wallet = 0x${key}`, `x = 1 ${key}`, `${key} x = 1`]) {
      let message = "";
      try {
        parseToml(source);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(key);
      expect(message).not.toContain(key.slice(0, 32));
    }
  });
});
