/**
 * The contract functions this kit calls, and every error it can be refused with.
 *
 * The functions are the ones the Feast app itself calls on the same contracts
 * (its `src/lib/chain/abi.ts` and `src/lib/trade/abi.ts`). The errors are the
 * app's whole refusal set — the Feast contracts', PancakeSwap's router,
 * Permit2's and the quoter's — so a revert decodes to the same name here as it
 * does on the site. `test/parity.test.ts` holds that set equal to the app's.
 */

import { parseAbi } from "viem";

export const factoryAbi = [
  {
    type: "function",
    name: "poolKeyFor",
    stateMutability: "view",
    inputs: [{ name: "coin", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "hooks", type: "address" },
          { name: "poolManager", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "parameters", type: "bytes32" },
        ],
      },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const poolManagerAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;

export const permit2Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

/** Not a view: the quoter simulates and reverts, so it is only ever simulated. */
export const mixedQuoterAbi = [
  {
    type: "function",
    name: "quoteMixedExactInput",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paths", type: "address[]" },
      { name: "actions", type: "bytes" },
      { name: "params", type: "bytes[]" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const universalRouterAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** Every error the trade path can carry back, by signature. */
export const ERRORS = parseAbi([
  "error CoinAndQuoteMustDiffer()", "error CreationStopped()", "error EmissionsBudgetMismatch(uint256,uint256)",
  "error EmissionsGuardianMismatch(address,address)", "error EmissionsHookMismatch(address,address)",
  "error EmissionsLedgerMismatch(address,address)", "error EmissionsPoolMismatch(bytes32,bytes32)", "error Frozen()",
  "error GateIsNotTheWindowsClose(uint64,uint64)", "error GenesisAlreadyDone()",
  "error GrantsEmissionsMismatch(address,address)", "error GrantsGrantMismatch(uint256,uint256)",
  "error GrantsGuardianMismatch(address,address)", "error NotGenesisKey()", "error NotTheVault()",
  "error NotTheWindow()", "error OpeningPriceOutOfRange(uint160)", "error PoolTooShallow()",
  "error PrebuyBelowMinimum(uint256,uint256)", "error PrebuyNeedsAQuoteAmount()",
  "error PrebuyNeedsTheCreator(address,address)", "error PrebuyTooLarge(uint256,uint256)",
  "error PrebuyVestingTooShort(uint64,uint64)", "error QuoteIsNotAToken()", "error RecipientHasNoCode(address)",
  "error RecipientNotAllowed(address)", "error SafeCastOverflowedUintToInt(uint256)",
  "error SafeERC20FailedOperation(address)", "error SinkGuardianMismatch(address,address)",
  "error SinkNotArmed(uint64,uint256)", "error SupplyNotInCustody(uint256)", "error SupplyTooLarge(uint256)",
  "error TeamVestingDurationMismatch(uint256,uint256)", "error TeamVestingGuardianMismatch(address,address)",
  "error TeamVestingStartNotWindowClose(uint256,uint256)", "error WindowCloseOutOfRange(uint256,uint256,uint256)",
  "error WindowFactoryMismatch(address,address)", "error WindowHookMismatch(address,address)",
  "error WindowPoolKeyMismatch(bytes32,bytes32)", "error WindowPoolManagerMismatch(address,address)",
  "error WindowWrappedNativeMismatch(address,address)", "error ZeroCreator()", "error NativeTransferFailed()",
  "error NoPoolForHop(address,address,uint24)", "error NoValue()", "error NotThePool()", "error NothingIn()",
  "error PartialFill(uint256,uint256)", "error RouteDoesNotReachQuote(address,address)",
  "error RouteMustEndInNative(address)", "error TooLittleOut(uint256,uint256)", "error UnknownCoin(address)",
  "error AlreadySeeded()", "error BoughtNothing()", "error CoinNotInPool()", "error GateOutOfBounds(uint64,address)",
  "error Int128Overflow()", "error NotFactory()", "error NotPoolManager()", "error NotVault()",
  "error NothingSeeded()", "error NothingToBuyBackWith()", "error PartialFillNotSupported(int256,int256)",
  "error PlatformSinkNotBound(address)", "error PoolAlreadyRegistered()", "error PoolNotOpenYet(uint64)",
  "error PoolNotRegistered()", "error PurchaseCapExceeded()", "error ReentrancyGuardReentrantCall()",
  "error RouteIsTheClaimantsToChoose(address)", "error SeedWouldNeedQuote()", "error ShareOutOfBand()",
  "error SpotTooFarFromAverage(int24,int24)", "error TipFloorListedTwice(address)",
  "error TipFloorOutOfBounds(address,uint256)", "error NoObservations()", "error NotWriter()",
  "error OracleTooYoung(uint32,uint32)", "error AskExceedsHop(address,uint256,uint256)",
  "error BelowMinOut(uint256,uint256)", "error EmptyRoute()", "error NotTheHook()",
  "error NothingArrived(address,uint256,uint256)", "error NothingOut()",
  "error OracleUnusable(address,uint16,uint32)", "error RouteExpectationTooLarge(address,uint256)",
  "error RouteReturnedTooLittle(uint256,uint256,uint256)", "error RouteRevisitsAToken(address)",
  "error RouteTooLong(uint256,uint256)", "error RouteWouldNotFill(uint256,uint256)",
  "error SpotTooFarFromAverage(address,int24,int24)", "error AlreadyAllocated()", "error ECDSAInvalidSignature()",
  "error ECDSAInvalidSignatureLength(uint256)", "error ECDSAInvalidSignatureS(bytes32)",
  "error ERC20InsufficientAllowance(address,uint256,uint256)",
  "error ERC20InsufficientBalance(address,uint256,uint256)", "error ERC20InvalidApprover(address)",
  "error ERC20InvalidReceiver(address)", "error ERC20InvalidSender(address)", "error ERC20InvalidSpender(address)",
  "error ERC2612ExpiredSignature(uint256)", "error ERC2612InvalidSigner(address,address)",
  "error InvalidAccountNonce(address,uint256)", "error InvalidShortString()", "error StringTooLong(string)",
  "error ZeroRecipient()", "error ZeroSupply()", "error ExecutionFailed(uint256,bytes)",
  "error TransactionDeadlinePassed()", "error LengthMismatch()", "error ETHNotAccepted()", "error InvalidEthSender()",
  "error InvalidCommandType(uint256)", "error InsufficientToken()", "error InsufficientETH()",
  "error FromAddressIsNotOwner()", "error V3InvalidSwap()", "error V3TooLittleReceived()",
  "error V3TooMuchRequested()", "error V3InvalidAmountOut()", "error V3InvalidCaller()",
  "error TooLittleReceived(uint256,uint256)", "error TooMuchRequested(uint256,uint256)",
  "error ExactOutputUnfilled(uint256,uint256)", "error DeltaNotPositive(address)", "error DeltaNotNegative(address)",
  "error InsufficientBalance()", "error InputLengthMismatch()", "error UnsupportedAction(uint256)",
  "error ContractLocked()", "error EnforcedPause()", "error AllowanceExpired(uint256)",
  "error InsufficientAllowance(uint256)", "error ExcessiveInvalidation()", "error InvalidAmount(uint256)",
  "error InvalidNonce()", "error SignatureExpired(uint256)", "error InvalidSignature()",
  "error InvalidSignatureLength()", "error InvalidSigner()", "error InvalidContractSignature()",
  "error UnexpectedRevertBytes(bytes)", "error NotEnoughLiquidity(bytes32)", "error NotSelf()",
  "error UnexpectedCallSuccess()", "error INVALID_ADDRESS()", "error InvalidPath()", "error InvalidPoolKeyCurrency()",
  "error NoActions()", "error WrappedError(address,bytes4,bytes,bytes)",
]);
