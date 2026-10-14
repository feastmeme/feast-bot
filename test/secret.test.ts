import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";
import { KeyError, loadKey, type KeyDeps } from "../src/secret.js";
import { OTHER, TEST_KEY, TEST_KEY_ADDRESS, WALLET } from "./fixtures.js";

const config = (extra = "") => parseConfig(`[bot]\n${extra}`, "/home/someone/bot");

function files(content: string, mode = 0o100600): KeyDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    platform: "linux",
    modeOf: () => mode,
    readFile: (path) => {
      reads.push(path);
      return content;
    },
  };
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(KeyError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("loading the key, for --live only", () => {
  it("reads it from BOT_PRIVATE_KEY, and takes it out of the environment", () => {
    const env: Record<string, string | undefined> = { BOT_PRIVATE_KEY: TEST_KEY };
    const loaded = loadKey(config(), env, files(""));
    expect(loaded.account.address).toBe(TEST_KEY_ADDRESS);
    expect(env.BOT_PRIVATE_KEY).toBeUndefined();
    expect(loaded.secrets).toContain(TEST_KEY);
    expect(loaded.secrets).toContain(TEST_KEY.slice(2));
  });

  it("reads it from key_file, with or without 0x and with a trailing newline", () => {
    const deps = files(`${TEST_KEY.slice(2)}\n`);
    expect(loadKey(config('key_file = "~/.feast-bot/key"'), {}, deps).account.address).toBe(TEST_KEY_ADDRESS);
    expect(deps.reads).toHaveLength(1);
  });

  it("refuses a key file other users can read, and says how to fix it", () => {
    expect(refusal(() => loadKey(config('key_file = "/k"'), {}, files(TEST_KEY, 0o100644)))).toMatch(/chmod 600 \/k/);
  });

  it("refuses both sources at once, and neither", () => {
    expect(refusal(() => loadKey(config('key_file = "/k"'), { BOT_PRIVATE_KEY: TEST_KEY }, files(TEST_KEY)))).toMatch(/set exactly one/);
    expect(refusal(() => loadKey(config(), {}, files("")))).toMatch(/needs a key/);
  });

  it("refuses something that is not a key without showing it", () => {
    const junk = `${TEST_KEY.slice(0, 40)}zz`;
    const message = refusal(() => loadKey(config(), { BOT_PRIVATE_KEY: junk }, files("")));
    expect(message).toMatch(/not 64 hex digits/);
    expect(message).not.toContain(junk.slice(2, 20));
  });

  it("refuses to trade from a wallet the config did not name", () => {
    expect(refusal(() => loadKey(config(`wallet = "${WALLET}"`), { BOT_PRIVATE_KEY: TEST_KEY }, files("")))).toMatch(/did not name/);
    expect(loadKey(config(`wallet = "${TEST_KEY_ADDRESS}"`), { BOT_PRIVATE_KEY: TEST_KEY }, files("")).account.address).toBe(TEST_KEY_ADDRESS);
  });

  it("refuses a referrer that is the trading wallet itself", () => {
    expect(refusal(() => loadKey(config(`referrer = "${TEST_KEY_ADDRESS}"`), { BOT_PRIVATE_KEY: TEST_KEY }, files("")))).toMatch(/referral to yourself/);
    expect(loadKey(config(`referrer = "${OTHER}"`), { BOT_PRIVATE_KEY: TEST_KEY }, files("")).account.address).toBe(TEST_KEY_ADDRESS);
  });
});
