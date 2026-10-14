/**
 * PancakeSwap Infinity's Universal Router, as bytes — the same bytes the Feast
 * site sends.
 *
 * A port of the app's `src/lib/trade/universal-router.ts` (pure functions, no
 * chain, no wallet, no clock) plus the two pieces of `infinity-router.ts` and
 * `coin/[address]/links.ts` that shape a trade: the MixedQuoter call and the
 * referrer's `hookData`. `test/parity.test.ts` encodes the same inputs through
 * the app's helpers and this file and holds the calldata equal, byte for byte.
 *
 * TWO LAYERS. A COMMAND is one byte of `commands` with one `inputs[i]` beside
 * it; `INFI_SWAP`'s input is itself a list of ACTIONS run inside one vault
 * lock. The Feast pool is always one CL action; the v3 hops between BNB and
 * the pool's quote asset are a `V3_SWAP_EXACT_IN` command beside it.
 */

import { concat, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, type AbiParameter, type TypedData } from "viem";

import { universalRouterAbi } from "./abi.js";
import type { Hex, Hop } from "./book.js";

/** `Commands.sol`. */
export const COMMAND = {
  V3_SWAP_EXACT_IN: 0x00,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  INFI_SWAP: 0x10,
} as const;

/** `Actions.sol`. */
export const ACTION = {
  CL_SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
} as const;

/** `ActionConstants.sol`: "whatever the open delta is". */
export const OPEN_DELTA = 0n;
/** `ActionConstants.sol`: "the router's whole balance of this token". */
export const CONTRACT_BALANCE = 1n << 255n;
/** `ActionConstants.sol`: the recipient flag for whoever called `execute`. */
export const MSG_SENDER: Hex = "0x0000000000000000000000000000000000000001";
/** `ActionConstants.sol`: the recipient flag for the router itself. */
export const ADDRESS_THIS: Hex = "0x0000000000000000000000000000000000000002";
/** The largest Permit2 allowance, `uint160` max: what the venue's own site signs. */
export const MAX_UINT160 = (1n << 160n) - 1n;

/** `MixedQuoterActions.sol`. */
const MIXED_V3_EXACT_INPUT_SINGLE = 0x03;
const MIXED_INFI_CL_EXACT_INPUT_SINGLE = 0x04;

export type PoolKey = {
  currency0: Hex;
  currency1: Hex;
  hooks: Hex;
  poolManager: Hex;
  fee: number;
  parameters: Hex;
};

export type PermitSingle = {
  details: { token: Hex; amount: bigint; expiration: bigint; nonce: bigint };
  spender: Hex;
  sigDeadline: bigint;
};

export type Action =
  | { action: "CL_SWAP_EXACT_IN_SINGLE"; poolKey: PoolKey; zeroForOne: boolean; amountIn: bigint; amountOutMinimum: bigint; hookData: Hex }
  | { action: "SETTLE"; currency: Hex; amount: bigint; payerIsUser: boolean }
  | { action: "SETTLE_ALL"; currency: Hex; maxAmount: bigint }
  | { action: "TAKE"; currency: Hex; recipient: Hex; amount: bigint }
  | { action: "TAKE_ALL"; currency: Hex; minAmount: bigint };

export type Command =
  | { command: "V3_SWAP_EXACT_IN"; recipient: Hex; amountIn: bigint; amountOutMin: bigint; path: Hex; payerIsUser: boolean }
  | { command: "PERMIT2_PERMIT"; permit: PermitSingle; signature: Hex }
  | { command: "WRAP_ETH"; recipient: Hex; amount: bigint }
  | { command: "UNWRAP_WETH"; recipient: Hex; amountMin: bigint }
  | { command: "INFI_SWAP"; actions: Action[] };

const POOL_KEY = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "hooks", type: "address" },
    { name: "poolManager", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "parameters", type: "bytes32" },
  ],
} as const;

const CL_SWAP_EXACT_IN_SINGLE_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "poolKey", ...POOL_KEY },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

/** Widened on purpose, not `as const`: the `uint48` fields travel as bigints. */
const PERMIT_SINGLE: AbiParameter = {
  type: "tuple",
  components: [
    {
      name: "details",
      type: "tuple",
      components: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
    },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
};

export function encodeAction(step: Action): Hex {
  switch (step.action) {
    case "CL_SWAP_EXACT_IN_SINGLE":
      return encodeAbiParameters(CL_SWAP_EXACT_IN_SINGLE_PARAMS, [
        {
          poolKey: step.poolKey,
          zeroForOne: step.zeroForOne,
          amountIn: step.amountIn,
          amountOutMinimum: step.amountOutMinimum,
          hookData: step.hookData,
        },
      ]);
    case "SETTLE":
      return encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [step.currency, step.amount, step.payerIsUser]);
    case "SETTLE_ALL":
      return encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [step.currency, step.maxAmount]);
    case "TAKE":
      return encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [step.currency, step.recipient, step.amount]);
    case "TAKE_ALL":
      return encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [step.currency, step.minAmount]);
  }
}

export function encodeActions(actions: readonly Action[]): Hex {
  const bytes = actions.length === 0 ? "0x" : concat(actions.map((step) => numberToHex(ACTION[step.action], { size: 1 })));
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [bytes, actions.map(encodeAction)]);
}

export function encodeCommandInput(step: Command): Hex {
  switch (step.command) {
    case "V3_SWAP_EXACT_IN":
      return encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }],
        [step.recipient, step.amountIn, step.amountOutMin, step.path, step.payerIsUser],
      );
    case "PERMIT2_PERMIT":
      return encodeAbiParameters([PERMIT_SINGLE, { type: "bytes" }], [step.permit, step.signature]);
    case "WRAP_ETH":
      return encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [step.recipient, step.amount]);
    case "UNWRAP_WETH":
      return encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [step.recipient, step.amountMin]);
    case "INFI_SWAP":
      return encodeActions(step.actions);
  }
}

export function encodeCommands(steps: readonly Command[]): { commands: Hex; inputs: Hex[] } {
  return {
    commands: steps.length === 0 ? "0x" : concat(steps.map((step) => numberToHex(COMMAND[step.command], { size: 1 }))),
    inputs: steps.map(encodeCommandInput),
  };
}

/** The whole calldata: `execute(commands, inputs, deadline)`. */
export function encodeExecute(steps: readonly Command[], deadline: bigint): Hex {
  const { commands, inputs } = encodeCommands(steps);
  return encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, deadline] });
}

/** A v3 route as the router's `path`: `token ‖ fee (3 bytes) ‖ token …`. */
export function v3Path(tokenIn: Hex, hops: readonly Hop[]): Hex {
  return concat([tokenIn, ...hops.flatMap((hop) => [numberToHex(hop.fee, { size: 3 }), hop.tokenOut])]).toLowerCase() as Hex;
}

/** `PoolIdLibrary.toId`: the keccak of the key's six words. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters([POOL_KEY], [key]));
}

const PERMIT_SINGLE_TYPES: TypedData = {
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
  PermitSingle: [
    { name: "details", type: "PermitDetails" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
};

/** Permit2's EIP-712 request for one `PermitSingle`. Permit2's domain has no version. */
export function permitSingleTypedData(input: { chainId: number; permit2: Hex; permit: PermitSingle }) {
  return {
    domain: { name: "Permit2", chainId: input.chainId, verifyingContract: input.permit2 },
    types: PERMIT_SINGLE_TYPES,
    primaryType: "PermitSingle",
    message: input.permit,
  } as const;
}

/**
 * A BUY: BNB in, the coin out, to the caller.
 *
 *   WRAP_ETH(router, amount)
 *   [V3_SWAP_EXACT_IN(router, all of it, 0, wrapped BNB → … → quote, router pays)]
 *   INFI_SWAP[ SETTLE(quote, all of it, router pays)
 *              CL_SWAP_EXACT_IN_SINGLE(the Feast pool, the open delta, minOut, hookData)
 *              TAKE_ALL(coin, minOut) ]
 */
export function buyCommands(input: {
  wrappedNative: Hex;
  quote: Hex;
  coin: Hex;
  hops: readonly Hop[];
  poolKey: PoolKey;
  amountIn: bigint;
  minOut: bigint;
  hookData: Hex;
}): Command[] {
  const steps: Command[] = [{ command: "WRAP_ETH", recipient: ADDRESS_THIS, amount: input.amountIn }];
  if (input.hops.length > 0) {
    steps.push({
      command: "V3_SWAP_EXACT_IN",
      recipient: ADDRESS_THIS,
      amountIn: CONTRACT_BALANCE,
      amountOutMin: 0n,
      path: v3Path(input.wrappedNative, input.hops),
      payerIsUser: false,
    });
  }
  steps.push({
    command: "INFI_SWAP",
    actions: [
      { action: "SETTLE", currency: input.quote, amount: CONTRACT_BALANCE, payerIsUser: false },
      {
        action: "CL_SWAP_EXACT_IN_SINGLE",
        poolKey: input.poolKey,
        zeroForOne: sameAddress(input.quote, input.poolKey.currency0),
        amountIn: OPEN_DELTA,
        amountOutMinimum: input.minOut,
        hookData: input.hookData,
      },
      { action: "TAKE_ALL", currency: input.coin, minAmount: input.minOut },
    ],
  });
  return steps;
}

/**
 * A SALE: the coin in, from the caller through Permit2, BNB out, to the caller.
 *
 *   [PERMIT2_PERMIT(permit, signature)]
 *   INFI_SWAP[ CL_SWAP_EXACT_IN_SINGLE(the Feast pool, amount, minOut when no hops, hookData)
 *              SETTLE_ALL(coin, amount)
 *              TAKE(quote, router, the open delta) ]
 *   [V3_SWAP_EXACT_IN(router, all of it, 0, quote → … → wrapped BNB, router pays)]
 *   UNWRAP_WETH(caller, minOut)
 */
export function sellCommands(input: {
  wrappedNative: Hex;
  quote: Hex;
  coin: Hex;
  hops: readonly Hop[];
  poolKey: PoolKey;
  amountIn: bigint;
  minOut: bigint;
  hookData: Hex;
  permit: { permit: PermitSingle; signature: Hex } | null;
}): Command[] {
  const steps: Command[] = [];
  if (input.permit) steps.push({ command: "PERMIT2_PERMIT", ...input.permit });
  steps.push({
    command: "INFI_SWAP",
    actions: [
      {
        action: "CL_SWAP_EXACT_IN_SINGLE",
        poolKey: input.poolKey,
        zeroForOne: sameAddress(input.coin, input.poolKey.currency0),
        amountIn: input.amountIn,
        amountOutMinimum: input.hops.length > 0 ? 0n : input.minOut,
        hookData: input.hookData,
      },
      { action: "SETTLE_ALL", currency: input.coin, maxAmount: input.amountIn },
      { action: "TAKE", currency: input.quote, recipient: ADDRESS_THIS, amount: OPEN_DELTA },
    ],
  });
  if (input.hops.length > 0) {
    steps.push({
      command: "V3_SWAP_EXACT_IN",
      recipient: ADDRESS_THIS,
      amountIn: CONTRACT_BALANCE,
      amountOutMin: 0n,
      path: v3Path(input.quote, input.hops),
      payerIsUser: false,
    });
  }
  steps.push({ command: "UNWRAP_WETH", recipient: MSG_SENDER, amountMin: input.minOut });
  return steps;
}

/**
 * The referrer as the hook reads it: one 32-byte word, the address
 * left-padded — or empty bytes for nobody. Empty is not a zero word: the hook
 * reads empty `hookData` as "nobody referred this trade".
 *
 * A wallet that has bound a referrer in the Feast referral registry pays that
 * referrer on every trade whatever this says; a named referrer is paid for
 * this trade only, and only by an unbound wallet.
 */
export function hookDataFor(referrer: string | null): Hex {
  if (!referrer || !/^0x[0-9a-fA-F]{40}$/.test(referrer)) return "0x";
  if (/^0x0{40}$/.test(referrer)) return "0x";
  return `0x${referrer.slice(2).toLowerCase().padStart(64, "0")}`;
}

/** The MixedQuoter's arguments for a path of v3 hops: one action and one fee word per hop. */
export function hopsQuoteArgs(tokenIn: Hex, hops: readonly Hop[], amountIn: bigint) {
  return mixedArgs(
    [tokenIn, ...hops.map((hop) => hop.tokenOut)],
    hops.map(() => MIXED_V3_EXACT_INPUT_SINGLE),
    hops.map((hop) => encodeAbiParameters([{ type: "uint24" }], [hop.fee])),
    amountIn,
  );
}

/** The MixedQuoter's arguments for the Feast pool alone, with the hookData the trade will carry. */
export function feastQuoteArgs(key: PoolKey, tokenIn: Hex, tokenOut: Hex, amountIn: bigint, hookData: Hex) {
  return mixedArgs(
    [tokenIn, tokenOut],
    [MIXED_INFI_CL_EXACT_INPUT_SINGLE],
    [
      encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { name: "poolKey", ...POOL_KEY },
              { name: "hookData", type: "bytes" },
            ],
          },
        ],
        [{ poolKey: key, hookData }],
      ),
    ],
    amountIn,
  );
}

function mixedArgs(paths: Hex[], actions: number[], params: Hex[], amountIn: bigint): readonly [Hex[], Hex, Hex[], bigint] {
  return [paths, concat(actions.map((action) => numberToHex(action, { size: 1 }))), params, amountIn] as const;
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
