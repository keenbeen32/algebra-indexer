/**
 * Contract reads, as Effect API effects.
 *
 * All external I/O must go through the Effect API: handlers run twice, in a
 * parallel preload pass and a sequential processing pass, so a bare contract
 * read in a handler would execute twice.
 *
 * Reads are pinned to the block of the event that triggered them, so the
 * configured endpoints must be archive nodes.
 */
import { S, createEffect } from "envio";
import {
  createPublicClient,
  http,
  BaseError,
  ContractFunctionRevertedError,
  type Abi,
  type PublicClient,
} from "viem";
import { RPC_URL, RPC_FALLBACK_URL } from "../config/chains.js";
import { TOKEN_FALLBACK_BI, UNKNOWN_STRING, NULL_ETH_VALUE } from "./constants.js";

function build(url: string) {
  return createPublicClient({
    transport: http(url, { batch: true }),
    batch: { multicall: true },
  });
}

const clients = new Map<number, ReturnType<typeof createPublicClient>>();
const fallbackClients = new Map<number, ReturnType<typeof createPublicClient>>();

function client(chainId: number) {
  let c = clients.get(chainId);
  if (!c) {
    const url = RPC_URL[chainId];
    if (!url) throw new Error(`No RPC URL configured for chainId ${chainId}`);
    c = build(url);
    clients.set(chainId, c);
  }
  return c;
}

function fallbackClient(chainId: number) {
  const url = RPC_FALLBACK_URL[chainId];
  if (!url) return undefined;
  let c = fallbackClients.get(chainId);
  if (!c) {
    c = build(url);
    fallbackClients.set(chainId, c);
  }
  return c;
}

/**
 * True only for a genuine contract revert. A transport failure is not a revert
 * and must be retried instead, or a flaky endpoint halts the indexer.
 */
function isRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return err.walk((e) => e instanceof ContractFunctionRevertedError) !== null;
}

const RETRY_ATTEMPTS = Number(process.env.ENVIO_RPC_RETRY_ATTEMPTS) || 4;
const RETRY_BASE_MS = Number(process.env.ENVIO_RPC_RETRY_BASE_MS) || 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs an RPC read with retry and failover, then THROWS.
 *
 * Effects must never swallow a failure: every effect sets `cache: true`, so a
 * fallback returned from inside one would be written to the durable cache and
 * replayed on every later run. Fallbacks belong at the call site, where they
 * are applied per event and never persisted.
 */
async function withRpcRetry<T>(
  chainId: number,
  label: string,
  run: (c: PublicClient) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await run(client(chainId) as PublicClient);
    } catch (err) {
      if (isRevert(err)) throw err;
      lastErr = err;
      if (attempt < RETRY_ATTEMPTS - 1) {
        const backoff = RETRY_BASE_MS * 2 ** attempt;
        await sleep(backoff + Math.floor(Math.random() * RETRY_BASE_MS));
      }
    }
  }

  const fb = fallbackClient(chainId);
  if (fb) {
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        return await run(fb as PublicClient);
      } catch (err) {
        if (isRevert(err)) throw err;
        lastErr = err;
        if (attempt < RETRY_ATTEMPTS - 1) {
          const backoff = RETRY_BASE_MS * 2 ** attempt;
          await sleep(backoff + Math.floor(Math.random() * RETRY_BASE_MS));
        }
      }
    }
  }

  const reason = lastErr instanceof Error ? lastErr.message.split("\n")[0] : String(lastErr);
  throw new Error(
    `${label} failed on chain ${chainId} after ${RETRY_ATTEMPTS} primary` +
      `${fb ? ` + ${RETRY_ATTEMPTS} fallback` : ""} attempt(s): ${reason}`,
    { cause: lastErr },
  );
}

/** Like `withRpcRetry`, but returns undefined for a genuine revert. */
async function readOrRevert<T>(
  chainId: number,
  label: string,
  run: (c: PublicClient) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await withRpcRetry(chainId, label, run);
  } catch (err) {
    if (isRevert(err)) return undefined;
    throw err;
  }
}

/**
 * Per-effect RPC rate limit, applied per effect rather than globally. Lower it
 * via ENVIO_EFFECT_RATE_LIMIT if the provider returns 429s — the symptom is the
 * indexer stalling with retry and timeout errors rather than crashing.
 */
const RATE_LIMIT = {
  calls: Number(process.env.ENVIO_EFFECT_RATE_LIMIT) || 500,
  per: "second",
} as const;

const ERC20_ABI = [
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

const ERC20_BYTES32_ABI = [
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const satisfies Abi;

const FACTORY_ABI = [
  {
    name: "poolByPair",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const satisfies Abi;

const POOL_ABI = [
  { name: "totalFeeGrowth0Token", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "totalFeeGrowth1Token", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    name: "ticks",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "int24" }],
    outputs: [
      { type: "uint128", name: "liquidityTotal" },
      { type: "int128", name: "liquidityDelta" },
      { type: "uint256", name: "outerFeeGrowth0Token" },
      { type: "uint256", name: "outerFeeGrowth1Token" },
      { type: "int56", name: "outerTickCumulative" },
      { type: "uint160", name: "outerSecondsPerLiquidity" },
      { type: "uint32", name: "outerSecondsSpent" },
      { type: "bool", name: "initialized" },
    ],
  },
] as const satisfies Abi;

const NFPM_ABI = [
  {
    name: "positions",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      { type: "uint96", name: "nonce" },
      { type: "address", name: "operator" },
      { type: "address", name: "token0" },
      { type: "address", name: "token1" },
      { type: "int24", name: "tickLower" },
      { type: "int24", name: "tickUpper" },
      { type: "uint128", name: "liquidity" },
      { type: "uint256", name: "feeGrowthInside0LastX128" },
      { type: "uint256", name: "feeGrowthInside1LastX128" },
      { type: "uint128", name: "tokensOwed0" },
      { type: "uint128", name: "tokensOwed1" },
    ],
  },
] as const satisfies Abi;

const addr = (a: string) => a as `0x${string}`;

function isNullEthValue(hex: string): boolean {
  return hex.toLowerCase() === NULL_ETH_VALUE;
}

function bytes32ToString(hex: string): string {
  const buf = Buffer.from(hex.replace(/^0x/, ""), "hex");
  return buf.toString("utf8").replace(/\0+$/, "");
}

export const getTokenMetadata = createEffect(
  {
    name: "getTokenMetadata",
    input: { chainId: S.number, address: S.string, blockNumber: S.bigint },
    output: {
      symbol: S.string,
      name: S.string,
      decimals: S.bigint,
      totalSupply: S.bigint,
    },
    cache: true,
    rateLimit: RATE_LIMIT,
  },
  async ({ input }) => {
    const { chainId } = input;
    const at = { address: addr(input.address), blockNumber: input.blockNumber };

    const [symbolStr, nameStr, decimalsRaw, totalSupplyRaw] = await Promise.all([
      readOrRevert(chainId, "ERC20.symbol", (c) =>
        c.readContract({ ...at, abi: ERC20_ABI, functionName: "symbol" }),
      ),
      readOrRevert(chainId, "ERC20.name", (c) =>
        c.readContract({ ...at, abi: ERC20_ABI, functionName: "name" }),
      ),
      readOrRevert(chainId, "ERC20.decimals", (c) =>
        c.readContract({ ...at, abi: ERC20_ABI, functionName: "decimals" }),
      ),
      readOrRevert(chainId, "ERC20.totalSupply", (c) =>
        c.readContract({ ...at, abi: ERC20_ABI, functionName: "totalSupply" }),
      ),
    ]);

    let symbol = UNKNOWN_STRING;
    if (symbolStr !== undefined) {
      symbol = symbolStr as string;
    } else {
      const raw = (await readOrRevert(chainId, "ERC20SymbolBytes.symbol", (c) =>
        c.readContract({ ...at, abi: ERC20_BYTES32_ABI, functionName: "symbol" }),
      )) as string | undefined;
      if (raw !== undefined && !isNullEthValue(raw)) symbol = bytes32ToString(raw);
    }

    let name = UNKNOWN_STRING;
    if (nameStr !== undefined) {
      name = nameStr as string;
    } else {
      const raw = (await readOrRevert(chainId, "ERC20NameBytes.name", (c) =>
        c.readContract({ ...at, abi: ERC20_BYTES32_ABI, functionName: "name" }),
      )) as string | undefined;
      if (raw !== undefined && !isNullEthValue(raw)) name = bytes32ToString(raw);
    }

    const decimals =
      decimalsRaw !== undefined ? BigInt(decimalsRaw as number) : TOKEN_FALLBACK_BI;
    const totalSupply =
      totalSupplyRaw !== undefined ? (totalSupplyRaw as bigint) : TOKEN_FALLBACK_BI;

    return { symbol, name, decimals, totalSupply };
  },
);

export const getPositions = createEffect(
  {
    name: "getPositions",
    input: { chainId: S.number, nfpm: S.string, tokenId: S.bigint, blockNumber: S.bigint },
    output: S.union([
      S.schema({
        token0: S.string,
        token1: S.string,
        tickLower: S.number,
        tickUpper: S.number,
        feeGrowthInside0LastX128: S.bigint,
        feeGrowthInside1LastX128: S.bigint,
      }),
      null,
    ]),
    cache: true,
    rateLimit: RATE_LIMIT,
  },
  async ({ input }) => {
    const r = (await readOrRevert(input.chainId, "NFPM.positions", (c) =>
      c.readContract({
        address: addr(input.nfpm),
        abi: NFPM_ABI,
        functionName: "positions",
        args: [input.tokenId],
        blockNumber: input.blockNumber,
      }),
    )) as readonly unknown[] | undefined;

    if (r === undefined) return null;

    return {
      token0: (r[2] as string).toLowerCase(),
      token1: (r[3] as string).toLowerCase(),
      tickLower: Number(r[4]),
      tickUpper: Number(r[5]),
      feeGrowthInside0LastX128: r[7] as bigint,
      feeGrowthInside1LastX128: r[8] as bigint,
    };
  },
);

export const getPoolByPair = createEffect(
  {
    name: "getPoolByPair",
    input: {
      chainId: S.number,
      factory: S.string,
      token0: S.string,
      token1: S.string,
    },
    output: S.string,
    cache: true,
    rateLimit: RATE_LIMIT,
  },
  async ({ input }) => {
    const r = (await withRpcRetry(input.chainId, "Factory.poolByPair", (c) =>
      c.readContract({
        address: addr(input.factory),
        abi: FACTORY_ABI,
        functionName: "poolByPair",
        args: [addr(input.token0), addr(input.token1)],
      }),
    )) as string;
    return r.toLowerCase();
  },
);

export const getTotalFeeGrowth = createEffect(
  {
    name: "getTotalFeeGrowth",
    input: { chainId: S.number, pool: S.string, blockNumber: S.bigint },
    output: { feeGrowthGlobal0X128: S.bigint, feeGrowthGlobal1X128: S.bigint },
    cache: true,
    rateLimit: RATE_LIMIT,
  },
  async ({ input }) => {
    const at = { address: addr(input.pool), abi: POOL_ABI, blockNumber: input.blockNumber } as const;
    const [g0, g1] = await Promise.all([
      withRpcRetry(input.chainId, "Pool.totalFeeGrowth0Token", (c) =>
        c.readContract({ ...at, functionName: "totalFeeGrowth0Token" }),
      ),
      withRpcRetry(input.chainId, "Pool.totalFeeGrowth1Token", (c) =>
        c.readContract({ ...at, functionName: "totalFeeGrowth1Token" }),
      ),
    ]);
    return { feeGrowthGlobal0X128: g0 as bigint, feeGrowthGlobal1X128: g1 as bigint };
  },
);

export const getTicks = createEffect(
  {
    name: "getTicks",
    input: { chainId: S.number, pool: S.string, tickIdxs: S.array(S.number), blockNumber: S.bigint },
    output: S.array(S.schema({ feeGrowthOutside0X128: S.bigint, feeGrowthOutside1X128: S.bigint })),
    cache: true,
    rateLimit: RATE_LIMIT,
  },
  async ({ input }) => {
    return Promise.all(
      input.tickIdxs.map(async (tickIdx) => {
        const r = (await withRpcRetry(input.chainId, "Pool.ticks", (c) =>
          c.readContract({
            address: addr(input.pool),
            abi: POOL_ABI,
            functionName: "ticks",
            args: [tickIdx],
            blockNumber: input.blockNumber,
          }),
        )) as readonly unknown[];
        return {
          feeGrowthOutside0X128: r[2] as bigint,
          feeGrowthOutside1X128: r[3] as bigint,
        };
      }),
    );
  },
);

export const getTxGas = createEffect(
  {
    name: "getTxGas",
    input: { chainId: S.number, hash: S.string },
    output: S.bigint,
    cache: true,
    rateLimit: RATE_LIMIT,
  },
  async ({ input }) => {
    const tx = await withRpcRetry(input.chainId, "eth_getTransactionByHash", (c) =>
      c.getTransaction({ hash: input.hash as `0x${string}` }),
    );
    return tx.gas;
  },
);
