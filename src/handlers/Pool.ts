/** Pool handlers: Initialize, Mint, Burn, Swap, and the fee/tick-spacing events. */
import { indexer } from "envio";
import type { Burn, Mint, Pool, PoolPosition, Swap, Tick, Token } from "envio";
import { chainConfig, cid, bundleId, factoryId } from "../config/chains.js";
import { ONE_BI, ZERO_BI, TICK_SPACING } from "../utils/constants.js";
import {
  ZERO_BD,
  bd,
  plus,
  minus,
  times,
  div,
  safeDiv,
  convertTokenToDecimal,
} from "../utils/bigdecimal.js";
import { getEthPriceInUSD, findEthPerToken, getTrackedAmountUSD, priceToTokenPrices } from "../utils/pricing.js";
import { createTick, tickId } from "../utils/tick.js";
import { loadTransaction } from "../utils/transaction.js";
import { getTotalFeeGrowth, getTicks } from "../utils/effects.js";
import {
  updateAlgebraDayData,
  updatePoolDayData,
  updatePoolHourData,
  updateTokenDayData,
  updateTokenHourData,
  updateTickDayData,
  updateFeeHourData,
} from "../utils/intervalUpdates.js";

const MILLION = bd("1000000");

async function updateTickFeeVarsAndSave(
  ticks: Tick[],
  event: any,
  context: any,
): Promise<void> {
  if (ticks.length === 0) return;

  let results: { feeGrowthOutside0X128: bigint; feeGrowthOutside1X128: bigint }[];
  try {
    results = await context.effect(getTicks, {
      chainId: event.chainId,
      pool: event.srcAddress,
      tickIdxs: ticks.map((tick) => Number(tick.tickIdx)),
      blockNumber: BigInt(event.block.number),
    });
  } catch (err) {
    context.log.error(
      `getTicks failed for pool ${event.srcAddress} ticks [${ticks
        .map((t) => t.tickIdx)
        .join(",")}] on chain ${event.chainId} at block ${event.block.number}; ` +
        `retaining previous feeGrowthOutside values. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    results = ticks.map((tick) => ({
      feeGrowthOutside0X128: tick.feeGrowthOutside0X128,
      feeGrowthOutside1X128: tick.feeGrowthOutside1X128,
    }));
  }
  for (let i = 0; i < ticks.length; i += 1) {
    const tick = ticks[i]!;
    const res = results[i]!;
    const updated: Tick = {
      ...tick,
      feeGrowthOutside0X128: res.feeGrowthOutside0X128,
      feeGrowthOutside1X128: res.feeGrowthOutside1X128,
    };
    context.Tick.set(updated);
    await updateTickDayData(updated, event, context);
  }
}

async function loadExistingTick(
  tickIdx: bigint,
  event: any,
  context: any,
): Promise<Tick | undefined> {
  const id = tickId(event.chainId, event.srcAddress, tickIdx);
  return context.Tick.get(id);
}

indexer.onEvent(
  { contract: "Pool", event: "Initialize" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const poolId = cid(chainId, event.srcAddress);
    const pool = await context.Pool.getOrThrow(poolId);

    context.Pool.set({
      ...pool,
      sqrtPrice: event.params.price,
      tick: BigInt(event.params.tick),
    });

    const [token0, token1] = await Promise.all([
      context.Token.getOrThrow(pool.token0_id),
      context.Token.getOrThrow(pool.token1_id),
    ]);

    const bundle = await context.Bundle.getOrThrow(bundleId(chainId));
    context.Bundle.set({
      ...bundle,
      ethPriceUSD: await getEthPriceInUSD(chainId, context),
    });

    await updatePoolDayData(event, context);
    await updatePoolHourData(event, context);

    context.Token.set({ ...token0, derivedEth: await findEthPerToken(token0, chainId, context) });
    context.Token.set({ ...token1, derivedEth: await findEthPerToken(token1, chainId, context) });
  },
);

indexer.onEvent(
  { contract: "Pool", event: "Mint" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const cfg = chainConfig(chainId);
    const poolAddress = event.srcAddress;
    const poolId = cid(chainId, poolAddress);

    const bundle = await context.Bundle.getOrThrow(bundleId(chainId));
    let pool = await context.Pool.getOrThrow(poolId);
    let factory = await context.Factory.getOrThrow(factoryId(chainId));
    let [token0, token1] = await Promise.all([
      context.Token.getOrThrow(pool.token0_id),
      context.Token.getOrThrow(pool.token1_id),
    ]);

    let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
    let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);
    if (cfg.poolsList.includes(poolAddress)) {
      amount0 = convertTokenToDecimal(event.params.amount1, token0.decimals);
      amount1 = convertTokenToDecimal(event.params.amount0, token1.decimals);
    }

    const amountUSD = plus(
      times(amount0, times(token0.derivedEth, bundle.ethPriceUSD)),
      times(amount1, times(token1.derivedEth, bundle.ethPriceUSD)),
    );

    factory = {
      ...factory,
      totalValueLockedEth: minus(factory.totalValueLockedEth, pool.totalValueLockedEth),
      txCount: factory.txCount + ONE_BI,
    };

    token0 = {
      ...token0,
      txCount: token0.txCount + ONE_BI,
      totalValueLocked: plus(token0.totalValueLocked, amount0),
    };
    token0 = {
      ...token0,
      totalValueLockedUSD: times(token0.totalValueLocked, times(token0.derivedEth, bundle.ethPriceUSD)),
    };

    token1 = {
      ...token1,
      txCount: token1.txCount + ONE_BI,
      totalValueLocked: plus(token1.totalValueLocked, amount1),
    };
    token1 = {
      ...token1,
      totalValueLockedUSD: times(token1.totalValueLocked, times(token1.derivedEth, bundle.ethPriceUSD)),
    };

    pool = { ...pool, txCount: pool.txCount + ONE_BI };

    const bottomTick = BigInt(event.params.bottomTick);
    const topTick = BigInt(event.params.topTick);
    if (bottomTick <= pool.tick && topTick > pool.tick) {
      pool = { ...pool, liquidity: pool.liquidity + event.params.liquidityAmount };
    }

    pool = {
      ...pool,
      totalValueLockedToken0: plus(pool.totalValueLockedToken0, amount0),
      totalValueLockedToken1: plus(pool.totalValueLockedToken1, amount1),
    };
    pool = {
      ...pool,
      totalValueLockedEth: plus(
        times(pool.totalValueLockedToken0, token0.derivedEth),
        times(pool.totalValueLockedToken1, token1.derivedEth),
      ),
    };
    pool = { ...pool, totalValueLockedUSD: times(pool.totalValueLockedEth, bundle.ethPriceUSD) };

    factory = {
      ...factory,
      totalValueLockedEth: plus(factory.totalValueLockedEth, pool.totalValueLockedEth),
    };
    factory = {
      ...factory,
      totalValueLockedUSD: times(factory.totalValueLockedEth, bundle.ethPriceUSD),
    };

    const transaction = await loadTransaction(event, context);

    const mint: Mint = {
      id: `${transaction.id}#${pool.txCount.toString()}`,
      transaction_id: transaction.id,
      timestamp: transaction.timestamp,
      pool_id: pool.id,
      token0_id: pool.token0_id,
      token1_id: pool.token1_id,
      owner: event.params.owner,
      sender: event.params.sender,
      origin: event.transaction.from ?? "0x",
      amount: event.params.liquidityAmount,
      amount0,
      amount1,
      amountUSD,
      tickLower: bottomTick,
      tickUpper: topTick,
      logIndex: undefined,
    };

    const lowerTickId = tickId(chainId, poolAddress, bottomTick);
    const upperTickId = tickId(chainId, poolAddress, topTick);
    let [lowerTick, upperTick] = await Promise.all([
      context.Tick.get(lowerTickId),
      context.Tick.get(upperTickId),
    ]);

    if (!lowerTick) {
      lowerTick = createTick(lowerTickId, bottomTick, pool.id, poolAddress, BigInt(event.block.number), BigInt(event.block.timestamp));
    }
    if (!upperTick) {
      upperTick = createTick(upperTickId, topTick, pool.id, poolAddress, BigInt(event.block.number), BigInt(event.block.timestamp));
    }

    const amount = event.params.liquidityAmount;
    lowerTick = {
      ...lowerTick,
      liquidityGross: lowerTick.liquidityGross + amount,
      liquidityNet: lowerTick.liquidityNet + amount,
    };
    upperTick = {
      ...upperTick,
      liquidityGross: upperTick.liquidityGross + amount,
      liquidityNet: upperTick.liquidityNet - amount,
    };

    const poolPositionId = `${pool.id}#${event.params.owner}#${bottomTick.toString()}#${topTick.toString()}`;
    const existingPosition = await context.PoolPosition.get(poolPositionId);
    const poolPosition: PoolPosition = existingPosition
      ? { ...existingPosition, liquidity: existingPosition.liquidity + amount }
      : {
          id: poolPositionId,
          pool_id: pool.id,
          lowerTick_id: lowerTick.id,
          upperTick_id: upperTick.id,
          liquidity: amount,
          owner: event.params.owner,
        };

    await updateAlgebraDayData(event, context);
    await updatePoolDayData(event, context);
    await updatePoolHourData(event, context);
    await updateTokenDayData(token0, event, context);
    await updateTokenDayData(token1, event, context);
    await updateTokenHourData(token0, event, context);
    await updateTokenHourData(token1, event, context);

    context.Token.set(token0);
    context.Token.set(token1);
    context.Pool.set(pool);
    context.PoolPosition.set(poolPosition);
    context.Factory.set(factory);
    context.Mint.set(mint);

    await updateTickFeeVarsAndSave([lowerTick, upperTick], event, context);
  },
);

indexer.onEvent(
  { contract: "Pool", event: "Burn" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const cfg = chainConfig(chainId);
    const poolAddress = event.srcAddress;
    const poolId = cid(chainId, poolAddress);

    const bundle = await context.Bundle.getOrThrow(bundleId(chainId));
    let pool = await context.Pool.getOrThrow(poolId);
    let factory = await context.Factory.getOrThrow(factoryId(chainId));
    let [token0, token1] = await Promise.all([
      context.Token.getOrThrow(pool.token0_id),
      context.Token.getOrThrow(pool.token1_id),
    ]);

    let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
    let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);
    if (cfg.poolsList.includes(poolAddress)) {
      amount0 = convertTokenToDecimal(event.params.amount1, token0.decimals);
      amount1 = convertTokenToDecimal(event.params.amount0, token1.decimals);
    }

    const amountUSD = plus(
      times(amount0, times(token0.derivedEth, bundle.ethPriceUSD)),
      times(amount1, times(token1.derivedEth, bundle.ethPriceUSD)),
    );

    factory = {
      ...factory,
      totalValueLockedEth: minus(factory.totalValueLockedEth, pool.totalValueLockedEth),
      txCount: factory.txCount + ONE_BI,
    };

    token0 = {
      ...token0,
      txCount: token0.txCount + ONE_BI,
      totalValueLocked: minus(token0.totalValueLocked, amount0),
    };
    token0 = {
      ...token0,
      totalValueLockedUSD: times(token0.totalValueLocked, times(token0.derivedEth, bundle.ethPriceUSD)),
    };

    token1 = {
      ...token1,
      txCount: token1.txCount + ONE_BI,
      totalValueLocked: minus(token1.totalValueLocked, amount1),
    };
    token1 = {
      ...token1,
      totalValueLockedUSD: times(token1.totalValueLocked, times(token1.derivedEth, bundle.ethPriceUSD)),
    };

    pool = { ...pool, txCount: pool.txCount + ONE_BI };

    const bottomTick = BigInt(event.params.bottomTick);
    const topTick = BigInt(event.params.topTick);
    if (bottomTick <= pool.tick && topTick > pool.tick) {
      pool = { ...pool, liquidity: pool.liquidity - event.params.liquidityAmount };
    }

    pool = {
      ...pool,
      totalValueLockedToken0: minus(pool.totalValueLockedToken0, amount0),
      totalValueLockedToken1: minus(pool.totalValueLockedToken1, amount1),
    };
    pool = {
      ...pool,
      totalValueLockedEth: plus(
        times(pool.totalValueLockedToken0, token0.derivedEth),
        times(pool.totalValueLockedToken1, token1.derivedEth),
      ),
    };
    pool = { ...pool, totalValueLockedUSD: times(pool.totalValueLockedEth, bundle.ethPriceUSD) };

    factory = {
      ...factory,
      totalValueLockedEth: plus(factory.totalValueLockedEth, pool.totalValueLockedEth),
    };
    factory = {
      ...factory,
      totalValueLockedUSD: times(factory.totalValueLockedEth, bundle.ethPriceUSD),
    };

    const transaction = await loadTransaction(event, context);
    const burn: Burn = {
      id: `${transaction.id}#${pool.txCount.toString()}`,
      transaction_id: transaction.id,
      timestamp: transaction.timestamp,
      pool_id: pool.id,
      token0_id: pool.token0_id,
      token1_id: pool.token1_id,
      owner: event.params.owner,
      origin: event.transaction.from ?? "0x",
      amount: event.params.liquidityAmount,
      amount0,
      amount1,
      amountUSD,
      tickLower: bottomTick,
      tickUpper: topTick,
      logIndex: undefined,
    };

    const lowerTickId = tickId(chainId, poolAddress, bottomTick);
    const upperTickId = tickId(chainId, poolAddress, topTick);
    const [lowerTickRaw, upperTickRaw] = await Promise.all([
      context.Tick.get(lowerTickId),
      context.Tick.get(upperTickId),
    ]);
    if (!lowerTickRaw) throw new Error(`handleBurn: missing lower Tick ${lowerTickId}`);
    if (!upperTickRaw) throw new Error(`handleBurn: missing upper Tick ${upperTickId}`);

    const amount = event.params.liquidityAmount;
    const lowerTick: Tick = {
      ...lowerTickRaw,
      liquidityGross: lowerTickRaw.liquidityGross - amount,
      liquidityNet: lowerTickRaw.liquidityNet - amount,
    };
    const upperTick: Tick = {
      ...upperTickRaw,
      liquidityGross: upperTickRaw.liquidityGross - amount,
      liquidityNet: upperTickRaw.liquidityNet + amount,
    };

    const poolPositionId = `${pool.id}#${event.params.owner}#${bottomTick.toString()}#${topTick.toString()}`;
    const existingPosition = await context.PoolPosition.get(poolPositionId);
    if (existingPosition) {
      context.PoolPosition.set({
        ...existingPosition,
        liquidity: existingPosition.liquidity - amount,
      });
    }

    await updateAlgebraDayData(event, context);
    await updatePoolDayData(event, context);
    await updatePoolHourData(event, context);
    await updateTokenDayData(token0, event, context);
    await updateTokenDayData(token1, event, context);
    await updateTokenHourData(token0, event, context);
    await updateTokenHourData(token1, event, context);
    await updateTickFeeVarsAndSave([lowerTick, upperTick], event, context);

    context.Token.set(token0);
    context.Token.set(token1);
    context.Pool.set(pool);
    context.Factory.set(factory);
    context.Burn.set(burn);
  },
);

indexer.onEvent(
  { contract: "Pool", event: "Swap" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const cfg = chainConfig(chainId);
    const poolAddress = event.srcAddress;
    const poolId = cid(chainId, poolAddress);

    let bundle = await context.Bundle.getOrThrow(bundleId(chainId));
    let factory = await context.Factory.getOrThrow(factoryId(chainId));
    let pool = await context.Pool.getOrThrow(poolId);

    const oldTick = pool.tick;

    let [token0, token1] = await Promise.all([
      context.Token.getOrThrow(pool.token0_id),
      context.Token.getOrThrow(pool.token1_id),
    ]);

    let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
    let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);
    if (cfg.poolsList.includes(poolAddress)) {
      amount0 = convertTokenToDecimal(event.params.amount1, token0.decimals);
      amount1 = convertTokenToDecimal(event.params.amount0, token1.decimals);
    }

    let amount0Abs = amount0;
    let amount0withFee = amount0;
    if (amount0.lt(ZERO_BD)) {
      amount0Abs = times(amount0, bd(-1));
    } else {
      amount0withFee = div(times(amount0, minus(MILLION, bd(pool.fee))), MILLION);
      amount0Abs = amount0;
    }

    let amount1Abs = amount1;
    let amount1withFee = amount1;
    if (amount1.lt(ZERO_BD)) {
      amount1Abs = times(amount1, bd(-1));
    } else {
      amount1Abs = amount1;
      amount1withFee = div(times(amount1, minus(MILLION, bd(pool.fee))), MILLION);
    }

    const amount0Eth = times(amount0Abs, token0.derivedEth);
    const amount1Eth = times(amount1Abs, token1.derivedEth);
    const amount0USD = times(amount0Eth, bundle.ethPriceUSD);
    const amount1USD = times(amount1Eth, bundle.ethPriceUSD);

    const amountTotalUSDTracked = div(
      await getTrackedAmountUSD(chainId, context, amount0Abs, token0, amount1Abs, token1),
      bd(2),
    );
    const amountTotalEthTracked = safeDiv(amountTotalUSDTracked, bundle.ethPriceUSD);
    const amountTotalUSDUntracked = div(plus(amount0USD, amount1USD), bd(2));

    const feesEth = div(times(amountTotalEthTracked, bd(pool.fee)), MILLION);
    const feesUSD = div(times(amountTotalUSDTracked, bd(pool.fee)), MILLION);
    const untrackedFees = div(times(amountTotalUSDUntracked, bd(pool.fee)), MILLION);

    factory = {
      ...factory,
      txCount: factory.txCount + ONE_BI,
      totalVolumeEth: plus(factory.totalVolumeEth, amountTotalEthTracked),
      totalVolumeUSD: plus(factory.totalVolumeUSD, amountTotalUSDTracked),
      untrackedVolumeUSD: plus(factory.untrackedVolumeUSD, amountTotalUSDUntracked),
      totalFeesEth: plus(factory.totalFeesEth, feesEth),
      totalFeesUSD: plus(factory.totalFeesUSD, feesUSD),
    };

    const currentPoolTvlEth = pool.totalValueLockedEth;
    factory = {
      ...factory,
      totalValueLockedEth: minus(factory.totalValueLockedEth, currentPoolTvlEth),
    };

    pool = {
      ...pool,
      volumeToken0: plus(pool.volumeToken0, amount0Abs),
      volumeToken1: plus(pool.volumeToken1, amount1Abs),
      volumeUSD: plus(pool.volumeUSD, amountTotalUSDTracked),
      untrackedVolumeUSD: plus(pool.untrackedVolumeUSD, amountTotalUSDUntracked),
      feesUSD: plus(pool.feesUSD, feesUSD),
      untrackedFeesUSD: plus(pool.untrackedFeesUSD, untrackedFees),
      txCount: pool.txCount + ONE_BI,
      liquidity: event.params.liquidity,
      tick: BigInt(event.params.tick),
      sqrtPrice: event.params.price,
    };
    pool = {
      ...pool,
      totalValueLockedToken0: plus(pool.totalValueLockedToken0, amount0withFee),
      totalValueLockedToken1: plus(pool.totalValueLockedToken1, amount1withFee),
    };

    token0 = {
      ...token0,
      volume: plus(token0.volume, amount0Abs),
      totalValueLocked: plus(token0.totalValueLocked, amount0withFee),
      volumeUSD: plus(token0.volumeUSD, amountTotalUSDTracked),
      untrackedVolumeUSD: plus(token0.untrackedVolumeUSD, amountTotalUSDUntracked),
      feesUSD: plus(token0.feesUSD, feesUSD),
      txCount: token0.txCount + ONE_BI,
    };
    token1 = {
      ...token1,
      volume: plus(token1.volume, amount1Abs),
      totalValueLocked: plus(token1.totalValueLocked, amount1withFee),
      volumeUSD: plus(token1.volumeUSD, amountTotalUSDTracked),
      untrackedVolumeUSD: plus(token1.untrackedVolumeUSD, amountTotalUSDUntracked),
      feesUSD: plus(token1.feesUSD, feesUSD),
      txCount: token1.txCount + ONE_BI,
    };

    let prices = priceToTokenPrices(pool.sqrtPrice, token0.decimals, token1.decimals);
    pool = { ...pool, token0Price: prices[0], token1Price: prices[1] };
    if (cfg.poolsList.includes(poolAddress)) {
      prices = priceToTokenPrices(pool.sqrtPrice, token1.decimals, token0.decimals);
      pool = { ...pool, token0Price: prices[1], token1Price: prices[0] };
    }

    context.Pool.set(pool);

    bundle = { ...bundle, ethPriceUSD: await getEthPriceInUSD(chainId, context) };
    context.Bundle.set(bundle);

    token0 = { ...token0, derivedEth: await findEthPerToken(token0, chainId, context) };
    token1 = { ...token1, derivedEth: await findEthPerToken(token1, chainId, context) };

    pool = {
      ...pool,
      totalValueLockedEth: plus(
        times(pool.totalValueLockedToken0, token0.derivedEth),
        times(pool.totalValueLockedToken1, token1.derivedEth),
      ),
    };
    pool = { ...pool, totalValueLockedUSD: times(pool.totalValueLockedEth, bundle.ethPriceUSD) };

    factory = {
      ...factory,
      totalValueLockedEth: plus(factory.totalValueLockedEth, pool.totalValueLockedEth),
    };
    factory = {
      ...factory,
      totalValueLockedUSD: times(factory.totalValueLockedEth, bundle.ethPriceUSD),
    };

    token0 = {
      ...token0,
      totalValueLockedUSD: times(times(token0.totalValueLocked, token0.derivedEth), bundle.ethPriceUSD),
    };
    token1 = {
      ...token1,
      totalValueLockedUSD: times(times(token1.totalValueLocked, token1.derivedEth), bundle.ethPriceUSD),
    };

    const transaction = await loadTransaction(event, context);
    const swap: Swap = {
      id: `${transaction.id}#${pool.txCount.toString()}`,
      transaction_id: transaction.id,
      timestamp: transaction.timestamp,
      pool_id: pool.id,
      token0_id: pool.token0_id,
      token1_id: pool.token1_id,
      sender: event.params.sender,
      origin: event.transaction.from ?? "0x",
      liquidity: event.params.liquidity,
      recipient: event.params.recipient,
      amount0,
      amount1,
      amountUSD: amountTotalUSDTracked,
      tick: BigInt(event.params.tick),
      price: event.params.price,
      logIndex: undefined,
    };

    let fg = {
      feeGrowthGlobal0X128: pool.feeGrowthGlobal0X128,
      feeGrowthGlobal1X128: pool.feeGrowthGlobal1X128,
    };
    try {
      fg = await context.effect(getTotalFeeGrowth, {
        chainId,
        pool: poolAddress,
        blockNumber: BigInt(event.block.number),
      });
    } catch (err) {
      context.log.error(
        `getTotalFeeGrowth failed for pool ${poolAddress} on chain ${chainId} at block ` +
          `${event.block.number}; retaining previous feeGrowthGlobal values. ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    pool = {
      ...pool,
      feeGrowthGlobal0X128: fg.feeGrowthGlobal0X128,
      feeGrowthGlobal1X128: fg.feeGrowthGlobal1X128,
    };

    let algebraDayData = await updateAlgebraDayData(event, context);
    let poolDayData = await updatePoolDayData(event, context);
    let poolHourData = await updatePoolHourData(event, context);
    let token0DayData = await updateTokenDayData(token0, event, context);
    let token1DayData = await updateTokenDayData(token1, event, context);
    let token0HourData = await updateTokenHourData(token0, event, context);
    let token1HourData = await updateTokenHourData(token1, event, context);

    if (amount0.lt(ZERO_BD)) {
      const f = div(times(amount1, bd(pool.fee)), MILLION);
      pool = { ...pool, feesToken1: plus(pool.feesToken1, f) };
      poolDayData = { ...poolDayData, feesToken1: plus(poolDayData.feesToken1, f) };
    }
    if (amount1.lt(ZERO_BD)) {
      const f = div(times(amount0, bd(pool.fee)), MILLION);
      pool = { ...pool, feesToken0: plus(pool.feesToken0, f) };
      poolDayData = { ...poolDayData, feesToken0: plus(poolDayData.feesToken0, f) };
    }

    algebraDayData = {
      ...algebraDayData,
      volumeEth: plus(algebraDayData.volumeEth, amountTotalEthTracked),
      volumeUSD: plus(algebraDayData.volumeUSD, amountTotalUSDTracked),
      feesUSD: plus(algebraDayData.feesUSD, feesUSD),
    };

    poolDayData = {
      ...poolDayData,
      volumeUSD: plus(poolDayData.volumeUSD, amountTotalUSDTracked),
      untrackedVolumeUSD: plus(poolDayData.untrackedVolumeUSD, amountTotalUSDUntracked),
      volumeToken0: plus(poolDayData.volumeToken0, amount0Abs),
      volumeToken1: plus(poolDayData.volumeToken1, amount1Abs),
      feesUSD: plus(poolDayData.feesUSD, feesUSD),
    };

    poolHourData = {
      ...poolHourData,
      untrackedVolumeUSD: plus(poolHourData.untrackedVolumeUSD, amountTotalUSDUntracked),
      volumeUSD: plus(poolHourData.volumeUSD, amountTotalUSDTracked),
      volumeToken0: plus(poolHourData.volumeToken0, amount0Abs),
      volumeToken1: plus(poolHourData.volumeToken1, amount1Abs),
      feesUSD: plus(poolHourData.feesUSD, feesUSD),
    };

    token0DayData = {
      ...token0DayData,
      volume: plus(token0DayData.volume, amount0Abs),
      volumeUSD: plus(token0DayData.volumeUSD, amountTotalUSDTracked),
      untrackedVolumeUSD: plus(token0DayData.untrackedVolumeUSD, amountTotalUSDTracked),
      feesUSD: plus(token0DayData.feesUSD, feesUSD),
    };
    token0HourData = {
      ...token0HourData,
      volume: plus(token0HourData.volume, amount0Abs),
      volumeUSD: plus(token0HourData.volumeUSD, amountTotalUSDTracked),
      untrackedVolumeUSD: plus(token0HourData.untrackedVolumeUSD, amountTotalUSDTracked),
      feesUSD: plus(token0HourData.feesUSD, feesUSD),
    };
    token1DayData = {
      ...token1DayData,
      volume: plus(token1DayData.volume, amount1Abs),
      volumeUSD: plus(token1DayData.volumeUSD, amountTotalUSDTracked),
      untrackedVolumeUSD: plus(token1DayData.untrackedVolumeUSD, amountTotalUSDTracked),
      feesUSD: plus(token1DayData.feesUSD, feesUSD),
    };
    token1HourData = {
      ...token1HourData,
      volume: plus(token1HourData.volume, amount1Abs),
      volumeUSD: plus(token1HourData.volumeUSD, amountTotalUSDTracked),
      untrackedVolumeUSD: plus(token1HourData.untrackedVolumeUSD, amountTotalUSDTracked),
      feesUSD: plus(token1HourData.feesUSD, feesUSD),
    };

    context.Swap.set(swap);
    context.TokenDayData.set(token0DayData);
    context.TokenDayData.set(token1DayData);
    context.AlgebraDayData.set(algebraDayData);
    context.PoolHourData.set(poolHourData);
    context.PoolDayData.set(poolDayData);
    context.Factory.set(factory);
    context.Pool.set(pool);
    context.Token.set(token0);
    context.Token.set(token1);

    const newTick = pool.tick;
    const ticksToRefresh = new Map<string, Tick>();
    const addExistingTick = async (tickIdx: bigint): Promise<void> => {
      const tick = await loadExistingTick(tickIdx, event, context);
      if (tick) ticksToRefresh.set(tick.id, tick);
    };
    const modulo = newTick % TICK_SPACING;
    if (modulo === ZERO_BI) {
      await addExistingTick(newTick);
    }

    const diff = oldTick - newTick;
    const numIters = (diff < 0n ? -diff : diff) / TICK_SPACING;

    if (numIters > 100n) {
    } else if (newTick > oldTick) {
      const firstInitialized = oldTick + (TICK_SPACING - modulo);
      for (let i = firstInitialized; i <= newTick; i += TICK_SPACING) {
        await addExistingTick(i);
      }
    } else if (newTick < oldTick) {
      const firstInitialized = oldTick - modulo;
      for (let i = firstInitialized; i >= newTick; i -= TICK_SPACING) {
        await addExistingTick(i);
      }
    }
    await updateTickFeeVarsAndSave([...ticksToRefresh.values()], event, context);
  },
);

indexer.onEvent(
  { contract: "Pool", event: "CommunityFee" },
  async ({ event, context }) => {
    const pool = await context.Pool.get(cid(event.chainId, event.srcAddress));
    if (!pool) return;
    context.Pool.set({
      ...pool,
      communityFee0: BigInt(event.params.communityFee0New),
      communityFee1: BigInt(event.params.communityFee1New),
    });
  },
);

indexer.onEvent(
  { contract: "Pool", event: "Collect" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const pool = await context.Pool.getOrThrow(cid(chainId, event.srcAddress));
    const factory = await context.Factory.getOrThrow(factoryId(chainId));
    const [token0, token1] = await Promise.all([
      context.Token.getOrThrow(pool.token0_id),
      context.Token.getOrThrow(pool.token1_id),
    ]);

    context.Token.set({ ...token0, txCount: token0.txCount + ONE_BI });
    context.Token.set({ ...token1, txCount: token1.txCount + ONE_BI });
    context.Pool.set({ ...pool, txCount: pool.txCount + ONE_BI });
    context.Factory.set({ ...factory, txCount: factory.txCount + ONE_BI });
  },
);

indexer.onEvent(
  { contract: "Pool", event: "Fee" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const poolAddress = event.srcAddress;
    const pool = await context.Pool.getOrThrow(cid(chainId, poolAddress));
    const fee = BigInt(event.params.fee);

    context.Pool.set({ ...pool, fee });

    const timestamp = BigInt(event.block.timestamp);
    const loadKey = cid(chainId, `${poolAddress}${timestamp.toString()}`);
    const createKey = cid(chainId, `${timestamp.toString()}${poolAddress}`);

    const existing = await context.PoolFeeData.get(loadKey);
    if (!existing) {
      context.PoolFeeData.set({
        id: createKey,
        pool: poolAddress,
        fee,
        timestamp,
      });
    } else {
      context.PoolFeeData.set({ ...existing, fee });
    }

    await updateFeeHourData(event, context, fee);
  },
);

indexer.onEvent(
  { contract: "Pool", event: "TickSpacing" },
  async ({ event, context }) => {
    const pool = await context.Pool.getOrThrow(cid(event.chainId, event.srcAddress));
    context.Pool.set({ ...pool, tickSpacing: BigInt(event.params.newTickSpacing) });
  },
);
