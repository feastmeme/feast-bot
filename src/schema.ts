/**
 * Every setting the bot reads, with its default and its bounds.
 *
 * This module imports nothing, on purpose: `config.ts` validates against it,
 * `bot.example.toml` is checked against it by a test, and the site's
 * `/docs/bot` page renders its config table from it. One list, so the three
 * can never disagree about a name or a default.
 *
 * Amounts in BNB are decimal strings ("0.01"), never floats, because they
 * become wei and a float cannot hold every wei amount exactly.
 */

export type FieldKind = "bool" | "int" | "number" | "bnb" | "url" | "address" | "path" | "poolIds";

export type Field = {
  readonly kind: FieldKind;
  readonly default: boolean | number | string | readonly string[];
  /** Inclusive bounds for `int` and `number`; for `bnb`, the smallest amount allowed. */
  readonly min?: number;
  readonly max?: number;
  /** For `bnb`: refuse zero. */
  readonly positive?: boolean;
  /** For `address`, `path`: an empty string means "not set". */
  readonly optional?: boolean;
};

export const SCHEMA = {
  bot: {
    api_base: { kind: "url", default: "https://feast.meme" },
    rpc_url: { kind: "url", default: "https://bsc-dataseed.bnbchain.org" },
    wallet: { kind: "address", default: "", optional: true },
    key_file: { kind: "path", default: "", optional: true },
    referrer: { kind: "address", default: "", optional: true },
    poll_seconds: { kind: "int", default: 60, min: 15, max: 3600 },
    api_requests_per_minute: { kind: "int", default: 30, min: 1, max: 60 },
    log_file: { kind: "path", default: "feast-bot.jsonl" },
    state_file: { kind: "path", default: "feast-bot.state.json" },
    stop_file: { kind: "path", default: "STOP" },
  },
  risk: {
    max_position_bnb: { kind: "bnb", default: "0.05", positive: true },
    daily_loss_cap_bnb: { kind: "bnb", default: "0.05", positive: true },
    max_slippage_bps: { kind: "int", default: 300, min: 1, max: 3000 },
    min_cooldown_seconds: { kind: "int", default: 300, min: 0, max: 86400 },
    max_orders_per_hour: { kind: "int", default: 6, min: 1, max: 60 },
    gas_reserve_bnb: { kind: "bnb", default: "0.005" },
  },
  mean_reversion: {
    enabled: { kind: "bool", default: false },
    pools: { kind: "poolIds", default: [] },
    window_min: { kind: "int", default: 60, min: 5, max: 1440 },
    entry_pct: { kind: "number", default: 5, min: 0.1, max: 50 },
    exit_pct: { kind: "number", default: 5, min: 0.1, max: 100 },
    order_bnb: { kind: "bnb", default: "0.01", positive: true },
    cooldown_min: { kind: "int", default: 30, min: 0, max: 1440 },
  },
  launch_momentum: {
    enabled: { kind: "bool", default: false },
    window_min: { kind: "int", default: 30, min: 1, max: 1440 },
    min_holders: { kind: "int", default: 20, min: 0, max: 1000000 },
    min_trades_per_min: { kind: "number", default: 1, min: 0, max: 1000 },
    order_bnb: { kind: "bnb", default: "0.005", positive: true },
    trailing_stop_pct: { kind: "number", default: 20, min: 1, max: 99 },
    time_stop_min: { kind: "int", default: 120, min: 1, max: 10080 },
  },
} as const satisfies Record<string, Record<string, Field>>;

export type SectionName = keyof typeof SCHEMA;

export const SECTION_NAMES = Object.keys(SCHEMA) as SectionName[];

/** The keys of one section, in the order the schema lists them. */
export function keysOf<S extends SectionName>(section: S): Array<keyof (typeof SCHEMA)[S] & string> {
  return Object.keys(SCHEMA[section]) as Array<keyof (typeof SCHEMA)[S] & string>;
}

/** A default written the way it is written in a TOML file. */
export function tomlLiteral(value: Field["default"]): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
}
