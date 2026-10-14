/**
 * Reading `bot.toml` into a checked, typed config.
 *
 * Every problem in the file is reported at once, by setting name, and never
 * with the offending value when that value could be a key. A setting this kit
 * does not know is an error, not a silent no-op: a typo in a risk limit must
 * not leave the limit at its default without telling anybody.
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { Hex } from "./book.js";
import { SCHEMA, SECTION_NAMES, type Field, type SectionName } from "./schema.js";
import { parseToml, shown, type TomlTable, type TomlValue } from "./toml.js";
import { parseAmount } from "./units.js";

export type Config = {
  bot: {
    apiBase: string;
    rpcUrl: string;
    /** The wallet's public address. Read in a dry run; must match the key when live. */
    wallet: Hex | null;
    keyFile: string | null;
    referrer: Hex | null;
    pollSeconds: number;
    apiRequestsPerMinute: number;
    logFile: string;
    stateFile: string;
    stopFile: string;
  };
  risk: {
    maxPositionWei: bigint;
    dailyLossCapWei: bigint;
    maxSlippageBps: number;
    minCooldownSeconds: number;
    maxOrdersPerHour: number;
    gasReserveWei: bigint;
    /** The session's total-loss stop, wei; 0 is off. */
    maxTotalLossWei: bigint;
    /** With [llm_manager] on: the model's orders answer to the total-loss stop and STOP alone. */
    onlyTotalLoss: boolean;
  };
  meanReversion: {
    enabled: boolean;
    pools: Hex[];
    windowMin: number;
    entryPct: number;
    exitPct: number;
    orderWei: bigint;
    cooldownMin: number;
  };
  launchMomentum: {
    enabled: boolean;
    windowMin: number;
    minHolders: number;
    minTradesPerMin: number;
    orderWei: bigint;
    trailingStopPct: number;
    timeStopMin: number;
  };
  llmManager: {
    enabled: boolean;
    /** Coin addresses (40 hex digits) or pool ids (64), as the config lists them, lowercased. */
    coins: Hex[];
    pollMinutes: number;
    eventTradeWei: bigint;
    eventNewPoolMinutes: number;
  };
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`the config has ${problems.length === 1 ? "a problem" : `${problems.length} problems`}:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/** Names that suggest somebody put a secret in the config. */
const SECRET_NAME = /private|secret|mnemonic|seed|passphrase|^key$|_key$|^pk$/i;

type Raw = Record<string, unknown>;

/**
 * Parse and check a config. `baseDir` is where relative paths in it are
 * resolved from: the config file's own folder.
 */
export function parseConfig(source: string, baseDir: string): Config {
  let table: TomlTable;
  try {
    table = parseToml(source);
  } catch (error) {
    throw new ConfigError([error instanceof Error ? error.message : String(error)]);
  }

  const problems: string[] = [];
  const values: Record<SectionName, Raw> = { bot: {}, risk: {}, mean_reversion: {}, launch_momentum: {}, llm_manager: {} };

  for (const [name, section] of Object.entries(table)) {
    if (!SECTION_NAMES.includes(name as SectionName)) {
      problems.push(isSecretName(name) ? secretRefusal(name) : `unknown section [${shownName(name)}]`);
      continue;
    }
    if (!isTable(section)) {
      problems.push(`${shownName(name)} must be a [section], not a value`);
      continue;
    }
    const fields = SCHEMA[name as SectionName] as Record<string, Field>;
    for (const [key, value] of Object.entries(section)) {
      const field = fields[key];
      if (!field) {
        problems.push(isSecretName(key) ? secretRefusal(`${name}.${key}`) : `unknown setting [${name}] ${shownName(key)}`);
        continue;
      }
      if (isTable(value)) {
        problems.push(`[${name}] ${key} must be a value, not a section`);
        continue;
      }
      const checked = checkField(`[${name}] ${key}`, field, value, baseDir);
      if (typeof checked === "object" && checked !== null && "problem" in checked) problems.push(checked.problem);
      else values[name as SectionName][key] = checked;
    }
  }

  // Defaults for everything the file leaves out.
  for (const section of SECTION_NAMES) {
    const fields = SCHEMA[section] as Record<string, Field>;
    for (const [key, field] of Object.entries(fields)) {
      if (key in values[section]) continue;
      const checked = checkField(`[${section}] ${key}`, field, field.default as TomlValue, baseDir);
      values[section][key] = typeof checked === "object" && checked !== null && "problem" in checked ? undefined : checked;
    }
  }

  const bot = values.bot;
  const risk = values.risk;
  const mr = values.mean_reversion;
  const lm = values.launch_momentum;
  const llm = values.llm_manager;

  const config: Config = {
    bot: {
      apiBase: (bot.api_base as string).replace(/\/+$/, ""),
      rpcUrl: bot.rpc_url as string,
      wallet: (bot.wallet as Hex | null) ?? null,
      keyFile: (bot.key_file as string | null) ?? null,
      referrer: (bot.referrer as Hex | null) ?? null,
      pollSeconds: bot.poll_seconds as number,
      apiRequestsPerMinute: bot.api_requests_per_minute as number,
      logFile: bot.log_file as string,
      stateFile: bot.state_file as string,
      stopFile: bot.stop_file as string,
    },
    risk: {
      maxPositionWei: risk.max_position_bnb as bigint,
      dailyLossCapWei: risk.daily_loss_cap_bnb as bigint,
      maxSlippageBps: risk.max_slippage_bps as number,
      minCooldownSeconds: risk.min_cooldown_seconds as number,
      maxOrdersPerHour: risk.max_orders_per_hour as number,
      gasReserveWei: risk.gas_reserve_bnb as bigint,
      maxTotalLossWei: risk.max_total_loss_bnb as bigint,
      onlyTotalLoss: risk.only_total_loss as boolean,
    },
    meanReversion: {
      enabled: mr.enabled as boolean,
      pools: mr.pools as Hex[],
      windowMin: mr.window_min as number,
      entryPct: mr.entry_pct as number,
      exitPct: mr.exit_pct as number,
      orderWei: mr.order_bnb as bigint,
      cooldownMin: mr.cooldown_min as number,
    },
    launchMomentum: {
      enabled: lm.enabled as boolean,
      windowMin: lm.window_min as number,
      minHolders: lm.min_holders as number,
      minTradesPerMin: lm.min_trades_per_min as number,
      orderWei: lm.order_bnb as bigint,
      trailingStopPct: lm.trailing_stop_pct as number,
      timeStopMin: lm.time_stop_min as number,
    },
    llmManager: {
      enabled: llm.enabled as boolean,
      coins: llm.coins as Hex[],
      pollMinutes: llm.poll_minutes as number,
      eventTradeWei: llm.event_trade_bnb as bigint,
      eventNewPoolMinutes: llm.event_new_pool_minutes as number,
    },
  };

  // Settings that are each fine alone and wrong together.
  if (problems.length === 0) {
    if (config.meanReversion.enabled && config.meanReversion.pools.length === 0) {
      problems.push("[mean_reversion] is enabled but lists no pools; add pool ids (feast-bot pools prints them)");
    }
    if (config.meanReversion.orderWei > config.risk.maxPositionWei) {
      problems.push("[mean_reversion] order_bnb is larger than [risk] max_position_bnb, so every buy would be refused");
    }
    if (config.launchMomentum.orderWei > config.risk.maxPositionWei) {
      problems.push("[launch_momentum] order_bnb is larger than [risk] max_position_bnb, so every buy would be refused");
    }
    if (config.bot.referrer && config.bot.wallet && config.bot.referrer.toLowerCase() === config.bot.wallet.toLowerCase()) {
      problems.push("[bot] referrer is your own wallet; a referral to yourself does not count, so leave referrer empty");
    }
    if (config.llmManager.enabled && config.llmManager.coins.length === 0) {
      problems.push("[llm_manager] is enabled but lists no coins; add coin addresses or pool ids (feast-bot pools prints both)");
    }
    if (config.llmManager.enabled && config.risk.maxTotalLossWei === 0n) {
      problems.push(
        "[llm_manager] is enabled but [risk] max_total_loss_bnb is 0; the total-loss stop is the model's only limit, so set how much BNB the session may lose",
      );
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

type Checked = boolean | number | string | bigint | string[] | null | { problem: string };

function checkField(where: string, field: Field, value: TomlValue, baseDir: string): Checked {
  switch (field.kind) {
    case "bool":
      return typeof value === "boolean" ? value : { problem: `${where} must be true or false` };
    case "int":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return { problem: `${where} must be a number` };
      if (field.kind === "int" && !Number.isInteger(value)) return { problem: `${where} must be a whole number` };
      if (field.min !== undefined && value < field.min) return { problem: `${where} must be at least ${field.min}` };
      if (field.max !== undefined && value > field.max) return { problem: `${where} must be at most ${field.max}` };
      return value;
    }
    case "bnb": {
      if (typeof value !== "string" && typeof value !== "number") return { problem: `${where} must be an amount of BNB, like "0.01"` };
      let wei: bigint;
      try {
        wei = parseAmount(value);
      } catch {
        return { problem: `${where} must be a plain decimal amount of BNB, like "0.01"` };
      }
      if (field.positive && wei === 0n) return { problem: `${where} must be more than zero` };
      return wei;
    }
    case "url": {
      if (typeof value !== "string") return { problem: `${where} must be a URL in quotes` };
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return { problem: `${where} must be a URL` };
      }
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
        return { problem: `${where} must be https:// (plain http only for localhost)` };
      }
      return value;
    }
    case "address": {
      if (typeof value !== "string") return { problem: `${where} must be an address in quotes` };
      if (value === "" && field.optional) return null;
      if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
        return { problem: `${where} looks like a private key, not an address; never put a key in the config` };
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return { problem: `${where} must be a 0x address (40 hex digits)` };
      if (/^0x0{40}$/.test(value)) return { problem: `${where} cannot be the zero address` };
      return value.toLowerCase();
    }
    case "path": {
      if (typeof value !== "string") return { problem: `${where} must be a path in quotes` };
      if (value === "" && field.optional) return null;
      if (value === "") return { problem: `${where} cannot be empty` };
      if (/[0-9a-fA-F]{64}/.test(value)) return { problem: `${where} holds a long hex string; it must be a file path, never the key itself` };
      return resolvePath(value, baseDir);
    }
    case "coins": {
      if (!Array.isArray(value)) return { problem: `${where} must be a list of coin addresses or pool ids, like ["0x…"]` };
      const out: string[] = [];
      for (const item of value) {
        if (typeof item !== "string" || !/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(item)) {
          return { problem: `${where} must hold coin addresses (0x and 40 hex digits) or pool ids (0x and 64), as feast-bot pools prints them` };
        }
        if (/^0x0{40}$/.test(item)) return { problem: `${where} cannot hold the zero address` };
        if (!out.includes(item.toLowerCase())) out.push(item.toLowerCase());
      }
      if (field.maxItems !== undefined && out.length > field.maxItems) return { problem: `${where} may list at most ${field.maxItems} coins` };
      return out;
    }
    case "poolIds": {
      if (!Array.isArray(value)) return { problem: `${where} must be a list of pool ids, like ["0x…"]` };
      const out: string[] = [];
      for (const item of value) {
        if (typeof item !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(item)) {
          return { problem: `${where} must hold pool ids: 0x and 64 hex digits each (feast-bot pools prints them)` };
        }
        if (!out.includes(item.toLowerCase())) out.push(item.toLowerCase());
      }
      return out;
    }
  }
}

/** `~/x` → home; relative → from the config's folder. */
export function resolvePath(value: string, baseDir: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

export function configDir(configPath: string): string {
  return dirname(resolve(configPath));
}

/** The defaults alone, for commands that run without a config file. */
export function defaultConfig(baseDir: string): Config {
  return parseConfig("", baseDir);
}

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name) && name !== "key_file";
}

function secretRefusal(name: string): string {
  return `${shownName(name)}: never put a private key or seed phrase in the config. Use BOT_PRIVATE_KEY, or key_file pointing at a file only you can read`;
}

function shownName(name: string): string {
  return shown(name).replace(/^"|"$/g, "");
}
