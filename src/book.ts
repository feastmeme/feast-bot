/**
 * BNB Smart Chain, as the Feast app's own address book has it.
 *
 * Copied from the app's chain-56 book (`sandbox/mainnet/addresses.json` in the
 * Feast repository); `test/parity.test.ts` holds every address and every route
 * here equal to that file whenever this folder sits inside the repository.
 *
 * Quote assets are keyed by ADDRESS. The public API names each pool's quote
 * asset by address too, so nothing here depends on a symbol.
 */

export type Hex = `0x${string}`;

/** One v3 hop, in the shape the router takes: the token it ends in, and the pool fee. */
export type Hop = { tokenOut: Hex; fee: number };

export const CHAIN_ID = 56;

export const CONTRACTS = {
  /** FeastFactory: `poolKeyFor(coin)`. */
  factory: "0x1003b54659F5e31A7391fEBE824A137e8CDa90da",
  /** FeastHook: the pool hook that takes the 1% fee and enforces the opening cap. */
  hook: "0xABFB955e4582f49dc741DCf5354fbB0edaD0A7c5",
  /** PancakeSwap Infinity's CL pool manager: `getSlot0(poolId)`. */
  poolManager: "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b",
  /** PancakeSwap Infinity's Universal Router: every trade goes through `execute`. */
  router: "0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB",
  /** Permit2: how the router is allowed to move a coin you sell. */
  permit2: "0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768",
  /** PancakeSwap's MixedQuoter: the simulation every quote comes from. */
  mixedQuoter: "0x2dCbF7B985c8C5C931818e4E107bAe8aaC8dAB7C",
  /** Wrapped BNB. */
  wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
} as const satisfies Record<string, Hex>;

const USDT: Hex = "0x55d398326f99059fF775485246999027B3197955";

/** A quote asset reached from BNB through USDT: two v3 hops each way. */
function viaUsdt(token: Hex): { buy: Hop[]; sell: Hop[] } {
  return {
    buy: [
      { tokenOut: USDT, fee: 100 },
      { tokenOut: token, fee: 2500 },
    ],
    sell: [
      { tokenOut: USDT, fee: 2500 },
      { tokenOut: CONTRACTS.wrappedNative, fee: 100 },
    ],
  };
}

/** A quote asset with its own pool against wrapped BNB: one v3 hop each way. */
function direct(token: Hex, fee: number): { buy: Hop[]; sell: Hop[] } {
  return { buy: [{ tokenOut: token, fee }], sell: [{ tokenOut: CONTRACTS.wrappedNative, fee }] };
}

/**
 * Every quote asset a Feast pool can be paired with, and the v3 hops between it
 * and wrapped BNB: `buy` from wrapped BNB to the quote asset, `sell` back.
 * Wrapped BNB itself needs no hop.
 */
export const QUOTE_ROUTES: Readonly<Record<string, { buy: Hop[]; sell: Hop[] }>> = Object.fromEntries(
  (
    [
      ["0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A", viaUsdt("0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A")],
      ["0x4eF9d3062c7F6ebA4AAE4990c5036598C6eff4ec", viaUsdt("0x4eF9d3062c7F6ebA4AAE4990c5036598C6eff4ec")],
      ["0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f", direct("0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f", 2500)],
      ["0x80f3D493EBCe97e343c53D29a137942416B4ffC0", viaUsdt("0x80f3D493EBCe97e343c53D29a137942416B4ffC0")],
      ["0x3F53De71c126BdaBAe20f9cD64848d317f6C3238", viaUsdt("0x3F53De71c126BdaBAe20f9cD64848d317f6C3238")],
      ["0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436", viaUsdt("0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436")],
      ["0x205812CdBed920aFf76C6580abD681a46D11efc7", direct("0x205812CdBed920aFf76C6580abD681a46D11efc7", 500)],
      ["0xCA750eF65f295BBECd685Abf54e82CAf297BDB61", viaUsdt("0xCA750eF65f295BBECd685Abf54e82CAf297BDB61")],
      ["0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1", direct("0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1", 2500)],
      ["0x5b1910eAaD6450E50f816082Aa078C41F10C292f", viaUsdt("0x5b1910eAaD6450E50f816082Aa078C41F10C292f")],
      [CONTRACTS.wrappedNative, { buy: [], sell: [] }],
    ] as Array<[string, { buy: Hop[]; sell: Hop[] }]>
  ).map(([address, route]) => [address.toLowerCase(), route]),
);

/** The hops for a pool's quote asset, or null when this kit does not know the asset. */
export function routeFor(quote: string): { buy: Hop[]; sell: Hop[] } | null {
  return QUOTE_ROUTES[quote.toLowerCase()] ?? null;
}
