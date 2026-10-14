# feast-bot — a trading bot starter kit for Feast

A small program that trades Feast pools on BNB Smart Chain from your own
computer, with your own wallet and your own limits. It reads Feast's public
API and the chain, decides with one of two simple strategies, and checks every
order against a set of limits before anything happens.

**It sends nothing until you add `--live`.** Without it, every order is quoted
and printed — the transaction data, the quote and the expected slippage — and
that is all.

Every order can lose the BNB it spends. Start with the dry run, keep the limits
small, and read the rules for bots below before you go live.

## Quickstart (about 10 minutes)

You need Node.js 20 or newer and a BNB Smart Chain wallet you control.

**1. Install.** In this folder:

```sh
npm install
npm run build
```

**2. Write your config.**

```sh
cp bot.example.toml bot.toml
npx feast-bot pools
```

`pools` lists pool ids, newest first. Open `bot.toml`, set `enabled = true` for
one strategy, and for mean reversion paste the pool ids you want into `pools`.
Leave the limits as they are for now.

**3. Dry run.**

```sh
npx feast-bot run --config bot.toml --once
```

One pass, then it exits. Each `checked` line shows what a strategy saw; each
`order` line is an order it would have placed, with `"sent": false`. Drop
`--once` to keep it running (one pass every `poll_seconds`). Set `wallet` to
your public address and the dry run also simulates each buy as your wallet.

To see a single trade the way the bot would build it:

```sh
npx feast-bot quote <pool id> 0.01
npx feast-bot quote <pool id> 250000 --side sell
```

A quote is checked against the API's own simulation (`apiCheck.agrees`).

**4. Go live.** Put the private key in a file only you can read, outside this
folder, with nothing else in it:

```sh
mkdir -p ~/.feast-bot && chmod 700 ~/.feast-bot
nano ~/.feast-bot/key        # paste the key, save
chmod 600 ~/.feast-bot/key
```

In `bot.toml`, set `key_file = "~/.feast-bot/key"` and `wallet` to that
wallet's public address (the bot refuses to start if they do not match). Then:

```sh
npx feast-bot run --config bot.toml --live
```

Instead of `key_file` you can set `BOT_PRIVATE_KEY` in the environment; set one
or the other, not both.

**5. Stop.** `Ctrl-C` stops after the current pass. Creating the stop file
(`touch STOP` in the config's folder) stops all orders at once, even mid-pass,
while the process keeps running; delete it to allow orders again.

## How an order is made

1. A **strategy** looks at the numbers and proposes an order. It cannot send
   anything: it never sees the wallet, the trader or the limits.
2. The **trader** quotes the order on chain, exactly as the Feast site does:
   the venue's own quoter simulates the same pools the router will swap
   (between BNB and the pool's quote asset, then the Feast pool and its hook),
   as your wallet when the bot knows it. It builds the router transaction the
   site builds — the parity tests hold the bytes equal.
3. The **risk gate** (`src/risk.ts`) checks the quoted order against the
   limits below (a sale against the stop file alone). Only it can approve an
   order; an approval is good for one order, for one minute, and the stop file
   is checked again right before sending.
4. In a dry run the order is logged. With `--live` it is simulated once more
   as your wallet, signed and sent, and the fill is measured from your balances
   at the receipt's own block.

A buy is one transaction. The first sale of a coin also needs a one-time
approval transaction and a signature that lets the router move that coin for
thirty days; both happen automatically, live, and are shown in a dry run.

## The two strategies

**Mean reversion** (`[mean_reversion]`). For each pool you list, the bot
averages the pool's price over the last `window_min` minutes, weighted by
volume. When the price now is `entry_pct` below that average, it buys
`order_bnb`; when it is `exit_pct` above, it sells the whole position. One
position per coin, and at least `cooldown_min` minutes between two orders on
the same coin. A window with no trades has no average, and no order.

**Launch momentum** (`[launch_momentum]`). The bot watches pools opened in the
last `window_min` minutes. When a new pool has at least `min_holders` holders
and at least `min_trades_per_min` trades a minute since it opened, it buys
`order_bnb`, once per pool. It sells the whole position when what the position
would sell for falls `trailing_stop_pct` below the highest it has been since the
buy, or after `time_stop_min` minutes, whichever comes first.

In a pool's first two blocks with trades, the hook refuses any buy over the
per-wallet cap (`PurchaseCapExceeded`). The bot logs the refusal by name and
tries again on a later pass.

## Limits

Checked in this order:

| Limit | Applies to | Blocks an order when |
| --- | --- | --- |
| stop file | every order | the file named by `stop_file` exists |
| `max_orders_per_hour` | buys | that many orders (buys and sales) went out in the last 60 minutes |
| `min_cooldown_seconds` | buys | the last order on the same coin was more recent |
| `max_slippage_bps` | buys | the expected slippage is larger, or cannot be measured |
| `max_position_bnb` | buys | the coin's position would cost more than this |
| `daily_loss_cap_bnb` | buys | today's realized result plus open positions' paper loss is this far down (UTC day) |
| `gas_reserve_bnb` | buys, live | the order would leave less BNB than this for gas |

A sale is held to the stop file alone. It closes a position the bot already
holds, so no limit may trap it there: a stop that fires into a thin pool, or in
an hour that already had its orders, still gets out. Every transaction, sales
included, carries a floor `max_slippage_bps` below its quote, and the chain
reverts it if the price moved further before it landed.

An order is counted the moment the risk gate approves it. One that goes out and
then reverts still uses its place in the hour, starts the coin's cooldown, and
its gas counts against the day; a launch-momentum pool is not tried again. A
buy whose receipt never arrives is booked at its floor and managed like any
position; if it never landed, the next sale finds nothing held and closes it
at nothing. Fills are measured at the receipt's own block.

## Config reference

Every setting, its default, and what it does. An unknown setting is an error,
so a typo cannot leave a limit at its default.

### `[bot]`

| Setting | Default | What it does |
| --- | --- | --- |
| `api_base` | `"https://feast.meme"` | Where the public API is. |
| `rpc_url` | `"https://bsc-dataseed.bnbchain.org"` | Any BNB Smart Chain RPC. Only its host is ever printed. |
| `wallet` | `""` | Your public address. Optional in a dry run; when live, the key must belong to it. |
| `key_file` | `""` | Live only: a file holding the private key, readable only by you. |
| `referrer` | `""` | Optional: the address that referred you, sent with each trade. Never your own wallet. |
| `poll_seconds` | `60` | Seconds between passes (15 to 3600). |
| `api_requests_per_minute` | `30` | The bot's own ceiling on API requests (at most 60). |
| `log_file` | `"feast-bot.jsonl"` | Where the structured log is appended. |
| `state_file` | `"feast-bot.state.json"` | Positions and recent orders. A dry run uses `….dry.json` beside it. |
| `stop_file` | `"STOP"` | The kill switch: while this file exists, no orders. |

### `[risk]`

| Setting | Default | What it does |
| --- | --- | --- |
| `max_position_bnb` | `"0.05"` | Most BNB spent on any one coin's open position. |
| `daily_loss_cap_bnb` | `"0.05"` | No new buys once the day is this far down. |
| `max_slippage_bps` | `300` | Most expected slippage a buy may have, in basis points (300 = 3%); every transaction also carries a floor this far below its quote. |
| `min_cooldown_seconds` | `300` | Least time between an order on a coin and the next buy of it. |
| `max_orders_per_hour` | `6` | Most orders in any 60 minutes; once reached, buys wait and sales still go. |
| `gas_reserve_bnb` | `"0.005"` | BNB a live buy always leaves in the wallet for gas. |

### `[mean_reversion]`

| Setting | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Turns the strategy on. |
| `pools` | `[]` | Pool ids to trade (from `feast-bot pools`). |
| `window_min` | `60` | Minutes the average covers (5 to 1440). |
| `entry_pct` | `5` | Buy when the price is this many percent below the average. |
| `exit_pct` | `5` | Sell when the price is this many percent above the average. |
| `order_bnb` | `"0.01"` | BNB per buy. |
| `cooldown_min` | `30` | Least minutes between two orders on the same coin. |

### `[launch_momentum]`

| Setting | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Turns the strategy on. |
| `window_min` | `30` | How young a pool must be to be considered, in minutes. |
| `min_holders` | `20` | Least holders before a buy. |
| `min_trades_per_min` | `1` | Least trades a minute since launch before a buy. |
| `order_bnb` | `"0.005"` | BNB for the one buy. |
| `trailing_stop_pct` | `20` | Sell when the position's value falls this far below its highest. |
| `time_stop_min` | `120` | Sell after this many minutes, whatever happens. |

Amounts in BNB are written as quoted decimals (`"0.01"`), so no amount is ever
rounded on its way to wei.

## Commands

```
feast-bot run --config bot.toml [--once] [--live]
feast-bot quote <pool id> <amount> [--side buy|sell] [--config bot.toml]
feast-bot pools [--limit 50] [--config bot.toml]
```

## Logs

One JSON object per line, on screen and in `log_file`: `{ ts, level, event, … }`.
Amounts are strings of base units (wei, or the coin's 18 decimals). The events
you will see most: `start`, `tick`, `checked`, `signal`, `order`,
`order_blocked` (with the `rule` that blocked it), `order_refused_by_chain`
(with the contract's own error name), `tx_sent`, `tx_confirmed`, `filled`,
`closed`.

## Rules for bots

- **One person, one wallet.** Run one bot from one wallet. Several wallets
  run by one person — including naming another wallet of yours as the
  referrer — count as split wallets, and split wallets are removed from
  campaign lists at the team's judgement.
- **Campaign terms apply to bot trades** exactly as they apply to trades made
  on the site. The current terms are on the campaign's announcement page at
  feast.meme.
- **Same terms as everyone.** A bot gets the same pools, the same fees and the
  same opening cap as anyone trading on the site. There is no early access to
  launches and no exemption from any rule.
- **Respect the public API's rate limit**: 60 requests a minute per caller,
  across every endpoint. The bot stays at 30 by default and waits when the
  API asks it to.
- **Your key stays on your machine.** The bot reads it only with `--live`,
  keeps it in memory, and never logs, writes or sends it. Feast never asks for
  your key, and nobody from Feast will.

## What this kit does not do

- It does not bind a referrer in the Feast referral registry; a referrer in the
  config is paid for each trade only, and only if your wallet has not bound one.
- It does not hold positions it did not open: it tracks what it bought.
- It does not choose pools for mean reversion; you list them. A
  mean-reversion position is managed only while its pool stays in `pools`.

## Development

```sh
npm test            # vitest, no network
npm run typecheck
```

The bot runs on any Node 20 or newer. The tests need Node 20.19+ or 22.12+,
because the test runner's bundler does.

`test/parity.test.ts` compares this kit with the Feast app's own trade helpers
and address book when the folder sits inside the Feast repository, and skips
itself anywhere else.
