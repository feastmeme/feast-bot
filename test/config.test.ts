import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError, parseConfig } from "../src/config.js";
import { SCHEMA, SECTION_NAMES, keysOf, tomlLiteral } from "../src/schema.js";
import { parseToml } from "../src/toml.js";

const EXAMPLE = readFileSync(new URL("../bot.example.toml", import.meta.url), "utf8");
const BASE = "/home/someone/bot";

function problemsOf(source: string): string[] {
  try {
    parseConfig(source, BASE);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe("bot.example.toml", () => {
  it("parses, and leaves both strategies off until the reader picks one", () => {
    const config = parseConfig(EXAMPLE, BASE);
    expect(config.meanReversion.enabled).toBe(false);
    expect(config.launchMomentum.enabled).toBe(false);
    expect(config.bot.keyFile).toBeNull();
    expect(config.bot.wallet).toBeNull();
  });

  it("writes every setting the schema has, with the schema's default, and no other", () => {
    const parsed = parseToml(EXAMPLE) as Record<string, Record<string, unknown>>;
    expect(Object.keys(parsed).sort()).toEqual([...SECTION_NAMES].sort());
    for (const section of SECTION_NAMES) {
      expect(Object.keys(parsed[section] ?? {}).sort(), section).toEqual([...keysOf(section)].sort());
      for (const key of keysOf(section)) {
        const field = (SCHEMA[section] as Record<string, { default: Parameters<typeof tomlLiteral>[0] }>)[key];
        expect(tomlLiteral(parsed[section]?.[key] as Parameters<typeof tomlLiteral>[0]), `${section}.${key}`).toBe(tomlLiteral(field!.default));
      }
    }
  });

  it("sets no key, no wallet, no referrer and no real pool: no address or id at all, comments included", () => {
    expect(EXAMPLE).not.toMatch(/0x[0-9a-fA-F]{40,}/);
  });
});

describe("config checks", () => {
  it("fills every default and turns amounts into wei", () => {
    const config = parseConfig("", BASE);
    expect(config.risk.maxPositionWei).toBe(50_000_000_000_000_000n);
    expect(config.risk.maxSlippageBps).toBe(300);
    expect(config.meanReversion.orderWei).toBe(10_000_000_000_000_000n);
    expect(config.bot.apiBase).toBe("https://feast.meme");
    expect(config.bot.logFile).toBe(join(BASE, "feast-bot.jsonl"));
  });

  it("resolves ~ and relative paths", () => {
    const config = parseConfig(`[bot]\nkey_file = "~/.feast-bot/key"\nlog_file = "logs/bot.jsonl"`, BASE);
    expect(config.bot.keyFile).toBe(join(homedir(), ".feast-bot/key"));
    expect(config.bot.logFile).toBe(join(BASE, "logs/bot.jsonl"));
  });

  it("refuses an unknown setting by name, so a typo cannot leave a limit at its default", () => {
    expect(problemsOf(`[risk]\nmax_postion_bnb = "1"`)).toEqual(["unknown setting [risk] max_postion_bnb"]);
    expect(problemsOf(`[strategy]\nx = 1`)).toEqual(["unknown section [strategy]"]);
  });

  it("refuses a key or seed phrase in the config without echoing it", () => {
    const key = `0x${"cd".repeat(32)}`;
    const problems = [
      ...problemsOf(`[bot]\nprivate_key = "${key}"`),
      ...problemsOf(`[bot]\nwallet = "${key}"`),
      ...problemsOf(`[bot]\nkey_file = "${key}"`),
      ...problemsOf(`[bot]\nmnemonic = "word word word"`),
    ];
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/never put a private key/);
    expect(problems[1]).toMatch(/looks like a private key/);
    expect(problems[2]).toMatch(/never the key itself/);
    expect(problems[3]).toMatch(/never put a private key or seed phrase/);
    for (const problem of problems) expect(problem).not.toContain(key.slice(2, 34));
  });

  it("checks types and bounds, and reports every problem at once", () => {
    const problems = problemsOf(`
[bot]
poll_seconds = 5
api_requests_per_minute = 61
api_base = "http://feast.meme"
wallet = "0x123"
[risk]
max_slippage_bps = 1.5
max_position_bnb = "1e-3"
daily_loss_cap_bnb = "0"
[mean_reversion]
enabled = "yes"
pools = ["0x1234"]
`);
    expect(problems).toEqual([
      "[bot] poll_seconds must be at least 15",
      "[bot] api_requests_per_minute must be at most 60",
      "[bot] api_base must be https:// (plain http only for localhost)",
      "[bot] wallet must be a 0x address (40 hex digits)",
      "[risk] max_slippage_bps must be a whole number",
      '[risk] max_position_bnb must be a plain decimal amount of BNB, like "0.01"',
      "[risk] daily_loss_cap_bnb must be more than zero",
      "[mean_reversion] enabled must be true or false",
      "[mean_reversion] pools must hold pool ids: 0x and 64 hex digits each (feast-bot pools prints them)",
    ]);
  });

  it("refuses settings that are fine alone and wrong together", () => {
    expect(problemsOf(`[mean_reversion]\nenabled = true`)).toEqual([
      "[mean_reversion] is enabled but lists no pools; add pool ids (feast-bot pools prints them)",
    ]);
    expect(problemsOf(`[risk]\nmax_position_bnb = "0.001"`)).toEqual([
      "[mean_reversion] order_bnb is larger than [risk] max_position_bnb, so every buy would be refused",
      "[launch_momentum] order_bnb is larger than [risk] max_position_bnb, so every buy would be refused",
    ]);
    const me = "0x1111111111111111111111111111111111111111";
    expect(problemsOf(`[bot]\nwallet = "${me}"\nreferrer = "${me.toUpperCase().replace("0X", "0x")}"`)).toEqual([
      "[bot] referrer is your own wallet; a referral to yourself does not count, so leave referrer empty",
    ]);
  });

  it("allows plain http only for a local API or RPC", () => {
    const config = parseConfig(`[bot]\napi_base = "http://localhost:3000/"\nrpc_url = "http://127.0.0.1:8545"`, BASE);
    expect(config.bot.apiBase).toBe("http://localhost:3000");
  });
});
