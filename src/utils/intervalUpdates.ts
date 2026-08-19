/** Day and hour rollups. */
import type {
  AlgebraDayData,
  PoolDayData,
  PoolHourData,
  Tick,
  TickDayData,
  Token,
  TokenDayData,
  TokenHourData,
} from "envio";
import { cid, factoryId, bundleId } from "../config/chains.js";
import { ZERO_BI, ONE_BI } from "./constants.js";
import { ZERO_BD, times } from "./bigdecimal.js";

const dayIdOf = (ts: number) => Math.floor(ts / 86400);
const hourIdOf = (ts: number) => Math.floor(ts / 3600);

export async function updateAlgebraDayData(
  event: any,
  context: any,
): Promise<AlgebraDayData> {
  const chainId = event.chainId;
  const algebra = await context.Factory.get(factoryId(chainId));
  const timestamp = Number(event.block.timestamp);
  const dayID = dayIdOf(timestamp);
  const dayStartTimestamp = dayID * 86400;
  const id = cid(chainId, dayID.toString());

  let entity = await context.AlgebraDayData.get(id);
  if (!entity) {
    entity = {
      id,
      date: dayStartTimestamp,
      volumeEth: ZERO_BD,
      volumeUSD: ZERO_BD,
      volumeUSDUntracked: ZERO_BD,
      feesUSD: ZERO_BD,
      tvlUSD: ZERO_BD,
      txCount: ZERO_BI,
    };
  }

  const updated: AlgebraDayData = {
    ...entity,
    tvlUSD: algebra.totalValueLockedUSD,
    txCount: algebra.txCount,
  };
  context.AlgebraDayData.set(updated);
  return updated;
}

export async function updatePoolDayData(
  event: any,
  context: any,
): Promise<PoolDayData> {
  const chainId = event.chainId;
  const timestamp = Number(event.block.timestamp);
  const dayID = dayIdOf(timestamp);
  const dayStartTimestamp = dayID * 86400;
  const poolAddress = event.srcAddress;
  const id = cid(chainId, `${poolAddress}-${dayID}`);
  const pool = await context.Pool.get(cid(chainId, poolAddress));

  let entity = await context.PoolDayData.get(id);
  if (!entity) {
    entity = {
      id,
      date: dayStartTimestamp,
      pool_id: pool.id,
      volumeToken0: ZERO_BD,
      volumeToken1: ZERO_BD,
      feesToken0: ZERO_BD,
      feesToken1: ZERO_BD,
      volumeUSD: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      feesUSD: ZERO_BD,
      txCount: ZERO_BI,
      feeGrowthGlobal0X128: ZERO_BI,
      feeGrowthGlobal1X128: ZERO_BI,
      open: pool.token0Price,
      high: pool.token0Price,
      low: pool.token0Price,
      close: pool.token0Price,
      liquidity: ZERO_BI,
      sqrtPrice: ZERO_BI,
      token0Price: ZERO_BD,
      token1Price: ZERO_BD,
      tick: undefined,
      tvlUSD: ZERO_BD,
    };
  }

  let high = entity.high;
  let low = entity.low;
  if (pool.token0Price.gt(high)) high = pool.token0Price;
  if (pool.token0Price.lt(low)) low = pool.token0Price;

  const updated: PoolDayData = {
    ...entity,
    high,
    low,
    liquidity: pool.liquidity,
    sqrtPrice: pool.sqrtPrice,
    feeGrowthGlobal0X128: pool.feeGrowthGlobal0X128,
    feeGrowthGlobal1X128: pool.feeGrowthGlobal1X128,
    token0Price: pool.token0Price,
    token1Price: pool.token1Price,
    tick: pool.tick,
    tvlUSD: pool.totalValueLockedUSD,
    txCount: entity.txCount + ONE_BI,
  };
  context.PoolDayData.set(updated);
  return updated;
}

export async function updateFeeHourData(
  event: any,
  context: any,
  fee: bigint,
): Promise<void> {
  const chainId = event.chainId;
  const timestamp = Number(event.block.timestamp);
  const hourIndex = hourIdOf(timestamp);
  const hourStartUnix = hourIndex * 3600;
  const poolAddress = event.srcAddress;
  const id = cid(chainId, `${poolAddress}-${hourIndex}`);

  const existing = await context.FeeHourData.get(id);

  if (existing) {
    let maxFee = existing.maxFee;
    let minFee = existing.minFee;
    if (maxFee < fee) maxFee = fee;
    if (minFee > fee) minFee = fee;
    context.FeeHourData.set({
      ...existing,
      timestamp: BigInt(hourStartUnix),
      fee: existing.fee + fee,
      changesCount: existing.changesCount + ONE_BI,
      maxFee,
      minFee,
      endFee: fee,
    });
    return;
  }

  if (fee === ZERO_BI) {
    context.log.warn(
      `FeeHourData ${id} created with fee=0; writing 0 for startFee/endFee/maxFee/minFee.`,
    );
  }

  context.FeeHourData.set({
    id,
    timestamp: BigInt(hourStartUnix),
    fee,
    changesCount: ONE_BI,
    pool: poolAddress,
    startFee: fee,
    endFee: fee,
    maxFee: fee,
    minFee: fee,
  });
}

export async function updatePoolHourData(
  event: any,
  context: any,
): Promise<PoolHourData> {
  const chainId = event.chainId;
  const timestamp = Number(event.block.timestamp);
  const hourIndex = hourIdOf(timestamp);
  const hourStartUnix = hourIndex * 3600;
  const poolAddress = event.srcAddress;
  const id = cid(chainId, `${poolAddress}-${hourIndex}`);
  const pool = await context.Pool.get(cid(chainId, poolAddress));

  let entity = await context.PoolHourData.get(id);
  if (!entity) {
    entity = {
      id,
      periodStartUnix: hourStartUnix,
      pool_id: pool.id,
      volumeToken0: ZERO_BD,
      volumeToken1: ZERO_BD,
      volumeUSD: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      txCount: ZERO_BI,
      feesUSD: ZERO_BD,
      feeGrowthGlobal0X128: ZERO_BI,
      feeGrowthGlobal1X128: ZERO_BI,
      open: pool.token0Price,
      high: pool.token0Price,
      low: pool.token0Price,
      close: pool.token0Price,
      liquidity: ZERO_BI,
      sqrtPrice: ZERO_BI,
      token0Price: ZERO_BD,
      token1Price: ZERO_BD,
      tick: undefined,
      tvlUSD: ZERO_BD,
    };
  }

  let high = entity.high;
  let low = entity.low;
  if (pool.token0Price.gt(high)) high = pool.token0Price;
  if (pool.token0Price.lt(low)) low = pool.token0Price;

  const updated: PoolHourData = {
    ...entity,
    high,
    low,
    liquidity: pool.liquidity,
    sqrtPrice: pool.sqrtPrice,
    token0Price: pool.token0Price,
    token1Price: pool.token1Price,
    feeGrowthGlobal0X128: pool.feeGrowthGlobal0X128,
    feeGrowthGlobal1X128: pool.feeGrowthGlobal1X128,
    close: pool.token0Price,
    tick: pool.tick,
    tvlUSD: pool.totalValueLockedUSD,
    txCount: entity.txCount + ONE_BI,
  };
  context.PoolHourData.set(updated);
  return updated;
}

export async function updateTokenDayData(
  token: Token,
  event: any,
  context: any,
): Promise<TokenDayData> {
  const chainId = event.chainId;
  const bundle = await context.Bundle.get(bundleId(chainId));
  const timestamp = Number(event.block.timestamp);
  const dayID = dayIdOf(timestamp);
  const dayStartTimestamp = dayID * 86400;
  const id = `${token.id}-${dayID}`;
  const tokenPrice = times(token.derivedEth, bundle.ethPriceUSD);

  let entity = await context.TokenDayData.get(id);
  if (!entity) {
    entity = {
      id,
      date: dayStartTimestamp,
      token_id: token.id,
      volume: ZERO_BD,
      volumeUSD: ZERO_BD,
      feesUSD: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      open: tokenPrice,
      high: tokenPrice,
      low: tokenPrice,
      close: tokenPrice,
      priceUSD: ZERO_BD,
      totalValueLocked: ZERO_BD,
      totalValueLockedUSD: ZERO_BD,
    };
  }

  let high = entity.high;
  let low = entity.low;
  if (tokenPrice.gt(high)) high = tokenPrice;
  if (tokenPrice.lt(low)) low = tokenPrice;

  const updated: TokenDayData = {
    ...entity,
    high,
    low,
    close: tokenPrice,
    priceUSD: times(token.derivedEth, bundle.ethPriceUSD),
    totalValueLocked: token.totalValueLocked,
    totalValueLockedUSD: token.totalValueLockedUSD,
  };
  context.TokenDayData.set(updated);
  return updated;
}

export async function updateTokenHourData(
  token: Token,
  event: any,
  context: any,
): Promise<TokenHourData> {
  const chainId = event.chainId;
  const bundle = await context.Bundle.get(bundleId(chainId));
  const timestamp = Number(event.block.timestamp);
  const hourIndex = hourIdOf(timestamp);
  const hourStartUnix = hourIndex * 3600;
  const id = `${token.id}-${hourIndex}`;
  const tokenPrice = times(token.derivedEth, bundle.ethPriceUSD);

  let entity = await context.TokenHourData.get(id);
  if (!entity) {
    entity = {
      id,
      periodStartUnix: hourStartUnix,
      token_id: token.id,
      volume: ZERO_BD,
      volumeUSD: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      feesUSD: ZERO_BD,
      open: tokenPrice,
      high: tokenPrice,
      low: tokenPrice,
      close: tokenPrice,
      priceUSD: ZERO_BD,
      totalValueLocked: ZERO_BD,
      totalValueLockedUSD: ZERO_BD,
    };
  }

  let high = entity.high;
  let low = entity.low;
  if (tokenPrice.gt(high)) high = tokenPrice;
  if (tokenPrice.lt(low)) low = tokenPrice;

  const updated: TokenHourData = {
    ...entity,
    high,
    low,
    close: tokenPrice,
    priceUSD: tokenPrice,
    totalValueLocked: token.totalValueLocked,
    totalValueLockedUSD: token.totalValueLockedUSD,
  };
  context.TokenHourData.set(updated);
  return updated;
}

export async function updateTickDayData(
  tick: Tick,
  event: any,
  context: any,
): Promise<TickDayData> {
  const timestamp = Number(event.block.timestamp);
  const dayID = dayIdOf(timestamp);
  const dayStartTimestamp = dayID * 86400;
  const id = `${tick.id}-${dayID}`;

  let entity = await context.TickDayData.get(id);
  if (!entity) {
    entity = {
      id,
      date: dayStartTimestamp,
      pool_id: tick.pool_id,
      tick_id: tick.id,
      liquidityGross: ZERO_BI,
      liquidityNet: ZERO_BI,
      volumeToken0: ZERO_BD,
      volumeToken1: ZERO_BD,
      volumeUSD: ZERO_BD,
      feesUSD: ZERO_BD,
      feeGrowthOutside0X128: ZERO_BI,
      feeGrowthOutside1X128: ZERO_BI,
    };
  }

  const updated: TickDayData = {
    ...entity,
    liquidityGross: tick.liquidityGross,
    liquidityNet: tick.liquidityNet,
    volumeToken0: tick.volumeToken0,
    volumeToken1: tick.volumeToken0,
    volumeUSD: tick.volumeUSD,
    feesUSD: tick.feesUSD,
    feeGrowthOutside0X128: tick.feeGrowthOutside0X128,
    feeGrowthOutside1X128: tick.feeGrowthOutside1X128,
  };
  context.TickDayData.set(updated);
  return updated;
}
