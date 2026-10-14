/**
 * The private key: where it comes from, and the only place it is held.
 *
 * It is read ONLY for `--live`. A dry run never opens the key file or reads
 * BOT_PRIVATE_KEY; it needs at most your public address (`[bot] wallet`).
 *
 * It is never logged, never written, never sent: the value goes into viem's
 * local account and nowhere else, and the logger is told to scrub it from any
 * line that might somehow contain it (`log.ts`). Errors here never include it.
 */

import { readFileSync, statSync } from "node:fs";

import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import type { Config } from "./config.js";

export class KeyError extends Error {
  override name = "KeyError";
}

export type LoadedKey = {
  account: PrivateKeyAccount;
  /** The strings the logger must never print: the key with and without 0x. */
  secrets: string[];
};

export type KeyDeps = {
  readFile: (path: string) => string;
  modeOf: (path: string) => number;
  platform: NodeJS.Platform;
};

const realDeps: KeyDeps = {
  readFile: (path) => readFileSync(path, "utf8"),
  modeOf: (path) => statSync(path).mode,
  platform: process.platform,
};

export function loadKey(config: Config, env: Record<string, string | undefined>, deps: KeyDeps = realDeps): LoadedKey {
  const fromEnv = env.BOT_PRIVATE_KEY;
  const file = config.bot.keyFile;
  if (fromEnv && file) {
    throw new KeyError("both BOT_PRIVATE_KEY and [bot] key_file are set; set exactly one, so there is no doubt which wallet trades");
  }
  if (!fromEnv && !file) {
    throw new KeyError("--live needs a key: set BOT_PRIVATE_KEY, or [bot] key_file pointing at a file that holds it");
  }

  let raw: string;
  if (file) {
    let mode: number;
    try {
      mode = deps.modeOf(file);
    } catch {
      throw new KeyError(`cannot read key_file ${file}`);
    }
    if (deps.platform !== "win32" && (mode & 0o077) !== 0) {
      throw new KeyError(`key_file ${file} can be read by other users; run: chmod 600 ${file}`);
    }
    try {
      raw = deps.readFile(file);
    } catch {
      throw new KeyError(`cannot read key_file ${file}`);
    }
  } else {
    raw = fromEnv ?? "";
    // Nothing this process starts should inherit it.
    delete env.BOT_PRIVATE_KEY;
  }

  const trimmed = raw.trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new KeyError(`the key ${file ? "in key_file" : "in BOT_PRIVATE_KEY"} is not 64 hex digits (with or without 0x); its content is not shown`);
  }
  const bare = trimmed.replace(/^0x/, "");
  const key = `0x${bare}` as const;
  const account = privateKeyToAccount(key);

  if (config.bot.wallet && config.bot.wallet.toLowerCase() !== account.address.toLowerCase()) {
    throw new KeyError(`the key is for ${account.address}, but [bot] wallet says ${config.bot.wallet}; refusing to trade from a wallet you did not name`);
  }
  if (config.bot.referrer && config.bot.referrer.toLowerCase() === account.address.toLowerCase()) {
    throw new KeyError("[bot] referrer is the wallet that trades; a referral to yourself does not count, so leave referrer empty");
  }
  return { account, secrets: [key, bare, bare.toLowerCase(), bare.toUpperCase()] };
}
