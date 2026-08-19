/** Factory handlers: PoolCreated and DefaultCommunityFee. */
import { indexer } from "envio";
import type { Bundle, Factory, Pool, Token } from "envio";
import { chainConfig, cid, bundleId, factoryId } from "../config/chains.js";
import { ADDRESS_ZERO, ZERO_BI, ONE_BI, UNKNOWN_STRING, TOKEN_FALLBACK_BI } from "../utils/constants.js";
import { ZERO_BD } from "../utils/bigdecimal.js";
import { getTokenMetadata } from "../utils/effects.js";

indexer.contractRegister(
  { contract: "Factory", event: "PoolCreated" },
  async ({ event, context }) => {
    context.chain.Pool.add(event.params.pool);
  },
);

/**
 * The effect throws on RPC failure so nothing is written to the durable cache;
 * the fallback is applied here instead, per event and never persisted.
 */
async function tokenMetadataOrFallback(
  context: any,
  chainId: number,
  address: string,
  blockNumber: bigint,
) {
  try {
    return await context.effect(getTokenMetadata, { chainId, address, blockNumber });
  } catch (err) {
    context.log.error(
      `getTokenMetadata failed for ${address} on chain ${chainId} at block ${blockNumber}; ` +
        `falling back to symbol/name='${UNKNOWN_STRING}', decimals=totalSupply=${TOKEN_FALLBACK_BI}. ` +
        `Amounts for this token will be wrong until reindexed. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      symbol: UNKNOWN_STRING,
      name: UNKNOWN_STRING,
      decimals: TOKEN_FALLBACK_BI,
      totalSupply: TOKEN_FALLBACK_BI,
    };
  }
}

function newFactory(id: string): Factory {
  return {
    id,
    poolCount: ZERO_BI,
    totalVolumeEth: ZERO_BD,
    totalVolumeUSD: ZERO_BD,
    defaultCommunityFee: ZERO_BI,
    untrackedVolumeUSD: ZERO_BD,
    totalFeesUSD: ZERO_BD,
    totalFeesEth: ZERO_BD,
    totalValueLockedEth: ZERO_BD,
    totalValueLockedUSD: ZERO_BD,
    totalValueLockedUSDUntracked: ZERO_BD,
    totalValueLockedEthUntracked: ZERO_BD,
    txCount: ZERO_BI,
    owner: ADDRESS_ZERO,
  };
}

indexer.onEvent(
  { contract: "Factory", event: "PoolCreated" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const cfg = chainConfig(chainId);
    const fid = factoryId(chainId);

    let factory = await context.Factory.get(fid);
    if (!factory) {
      factory = newFactory(fid);
      const bundle: Bundle = { id: bundleId(chainId), ethPriceUSD: ZERO_BD };
      context.Bundle.set(bundle);
    }

    factory = { ...factory, poolCount: factory.poolCount + ONE_BI };

    const poolAddress = event.params.pool;
    const poolId = cid(chainId, poolAddress);

    let token0Address = event.params.token0;
    let token1Address = event.params.token1;

    if (cfg.poolsList.includes(poolAddress)) {
      token0Address = event.params.token1;
      token1Address = event.params.token0;
    }

    const token0Id = cid(chainId, token0Address);
    const token1Id = cid(chainId, token1Address);

    let [token0, token1] = await Promise.all([
      context.Token.get(token0Id),
      context.Token.get(token1Id),
    ]);

    if (!token0) {
      const md = await tokenMetadataOrFallback(
        context,
        chainId,
        token0Address,
        BigInt(event.block.number),
      );
      token0 = {
        id: token0Id,
        symbol: md.symbol,
        name: md.name,
        totalSupply: md.totalSupply,
        decimals: md.decimals,
        derivedEth: ZERO_BD,
        volume: ZERO_BD,
        volumeUSD: ZERO_BD,
        feesUSD: ZERO_BD,
        untrackedVolumeUSD: ZERO_BD,
        totalValueLocked: ZERO_BD,
        totalValueLockedUSD: ZERO_BD,
        totalValueLockedUSDUntracked: ZERO_BD,
        txCount: ZERO_BI,
        poolCount: ZERO_BI,
        whitelistPools: [],
      };
    }

    if (!token1) {
      const md = await tokenMetadataOrFallback(
        context,
        chainId,
        token1Address,
        BigInt(event.block.number),
      );
      token1 = {
        id: token1Id,
        symbol: md.symbol,
        name: md.name,
        totalSupply: md.totalSupply,
        decimals: md.decimals,
        derivedEth: ZERO_BD,
        volume: ZERO_BD,
        volumeUSD: ZERO_BD,
        untrackedVolumeUSD: ZERO_BD,
        feesUSD: ZERO_BD,
        totalValueLocked: ZERO_BD,
        totalValueLockedUSD: ZERO_BD,
        totalValueLockedUSDUntracked: ZERO_BD,
        txCount: ZERO_BI,
        poolCount: ZERO_BI,
        whitelistPools: [],
      };
    }

    if (cfg.whitelistTokens.includes(token0Address)) {
      token1 = { ...token1, whitelistPools: [...token1.whitelistPools, poolId] };
    }
    if (cfg.whitelistTokens.includes(token1Address)) {
      token0 = { ...token0, whitelistPools: [...token0.whitelistPools, poolId] };
    }

    const pool: Pool = {
      id: poolId,
      token0_id: token0.id,
      token1_id: token1.id,
      fee: 100n,
      tickSpacing: 60n,
      createdAtTimestamp: BigInt(event.block.timestamp),
      createdAtBlockNumber: BigInt(event.block.number),
      liquidityProviderCount: ZERO_BI,
      tick: ZERO_BI,
      txCount: ZERO_BI,
      liquidity: ZERO_BI,
      sqrtPrice: ZERO_BI,
      feeGrowthGlobal0X128: ZERO_BI,
      feeGrowthGlobal1X128: ZERO_BI,
      communityFee0: factory.defaultCommunityFee,
      communityFee1: factory.defaultCommunityFee,
      token0Price: ZERO_BD,
      token1Price: ZERO_BD,
      observationIndex: ZERO_BI,
      totalValueLockedToken0: ZERO_BD,
      totalValueLockedToken1: ZERO_BD,
      totalValueLockedUSD: ZERO_BD,
      totalValueLockedEth: ZERO_BD,
      totalValueLockedUSDUntracked: ZERO_BD,
      volumeToken0: ZERO_BD,
      volumeToken1: ZERO_BD,
      volumeUSD: ZERO_BD,
      feesUSD: ZERO_BD,
      feesToken0: ZERO_BD,
      feesToken1: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      untrackedFeesUSD: ZERO_BD,
      collectedFeesToken0: ZERO_BD,
      collectedFeesToken1: ZERO_BD,
      collectedFeesUSD: ZERO_BD,
    };

    context.Pool.set(pool);
    context.Token.set(token0);
    context.Token.set(token1);
    context.Factory.set(factory);
  },
);

indexer.onEvent(
  { contract: "Factory", event: "DefaultCommunityFee" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const fid = factoryId(chainId);

    let factory = await context.Factory.get(fid);
    if (!factory) {
      factory = newFactory(fid);
      const bundle: Bundle = { id: bundleId(chainId), ethPriceUSD: ZERO_BD };
      context.Bundle.set(bundle);
    }

    context.Factory.set({
      ...factory,
      defaultCommunityFee: BigInt(event.params.newDefaultCommunityFee),
    });
  },
);
