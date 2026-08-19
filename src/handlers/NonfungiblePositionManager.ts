/** Position manager handlers: IncreaseLiquidity, DecreaseLiquidity, Collect, Transfer. */
import { indexer } from "envio";
import type { Position, PositionSnapshot } from "envio";
import { chainConfig, cid, factoryId } from "../config/chains.js";
import { ADDRESS_ZERO, ZERO_BI } from "../utils/constants.js";
import { ZERO_BD, plus, minus, convertTokenToDecimal } from "../utils/bigdecimal.js";
import { getPositions, getPoolByPair } from "../utils/effects.js";
import { loadTransaction } from "../utils/transaction.js";

async function getPosition(
  event: any,
  context: any,
  tokenId: bigint,
): Promise<Position | undefined> {
  const chainId = event.chainId;
  const cfg = chainConfig(chainId);
  const id = cid(chainId, tokenId.toString());

  const existing = await context.Position.get(id);
  if (existing) return existing;

  let res;
  try {
    res = await context.effect(getPositions, {
      chainId,
      nfpm: event.srcAddress,
      tokenId,
      blockNumber: BigInt(event.block.number),
    });
  } catch (err) {
    context.log.error(
      `getPositions failed for tokenId ${tokenId} on chain ${chainId} at block ` +
        `${event.block.number}; skipping this position event. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  if (!res) {
    context.log.warn(
      `POSITION_SKIPPED_NULL getPositions returned null for tokenId ${tokenId} on chain ` +
        `${chainId} at block ${event.block.number}; no Position row will be written. ` +
        `Expected only when a position is minted and burned in the same block, which is ` +
        `rare. If this appears in volume, cross-check with eth_call positions(tokenId) ` +
        `at this block.`,
    );
    return undefined;
  }

  let poolAddress: string;
  try {
    poolAddress = await context.effect(getPoolByPair, {
      chainId,
      factory: cfg.factoryAddress,
      token0: res.token0,
      token1: res.token1,
    });
  } catch (err) {
    context.log.error(
      `getPoolByPair failed for ${res.token0}/${res.token1} on chain ${chainId} at block ` +
        `${event.block.number}; skipping creation of Position ${tokenId}. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }

  const poolId = cid(chainId, poolAddress);

  const flipped = cfg.poolsList.includes(poolAddress);
  const token0Address = flipped ? res.token1 : res.token0;
  const token1Address = flipped ? res.token0 : res.token1;

  const transaction = await loadTransaction(event, context);

  return {
    id,
    owner: ADDRESS_ZERO,
    pool_id: poolId,
    token0_id: cid(chainId, token0Address),
    token1_id: cid(chainId, token1Address),
    tickLower_id: `${poolId}#${res.tickLower}`,
    tickUpper_id: `${poolId}#${res.tickUpper}`,
    liquidity: ZERO_BI,
    depositedToken0: ZERO_BD,
    depositedToken1: ZERO_BD,
    withdrawnToken0: ZERO_BD,
    withdrawnToken1: ZERO_BD,
    collectedToken0: ZERO_BD,
    collectedToken1: ZERO_BD,
    collectedFeesToken0: ZERO_BD,
    collectedFeesToken1: ZERO_BD,
    transaction_id: transaction.id,
    feeGrowthInside0LastX128: res.feeGrowthInside0LastX128,
    feeGrowthInside1LastX128: res.feeGrowthInside1LastX128,
    token0Tvl: undefined,
    token1Tvl: undefined,
  };
}

async function updateFeeVars(
  position: Position,
  event: any,
  context: any,
  tokenId: bigint,
): Promise<Position> {
  let res;
  try {
    res = await context.effect(getPositions, {
      chainId: event.chainId,
      nfpm: event.srcAddress,
      tokenId,
      blockNumber: BigInt(event.block.number),
    });
  } catch (err) {
    context.log.error(
      `getPositions (updateFeeVars) failed for tokenId ${tokenId} on chain ` +
        `${event.chainId} at block ${event.block.number}; retaining previous ` +
        `feeGrowthInside values. ${err instanceof Error ? err.message : String(err)}`,
    );
    return position;
  }
  if (!res) {
    context.log.info(
      `FEEVARS_SKIPPED_NULL getPositions returned null for tokenId ${tokenId} on chain ` +
        `${event.chainId} at block ${event.block.number}; feeGrowthInside* retain their ` +
        `previous values. Expected when the position was closed and its NFT burned in ` +
        `this block.`,
    );
    return position;
  }
  return {
    ...position,
    feeGrowthInside0LastX128: res.feeGrowthInside0LastX128,
    feeGrowthInside1LastX128: res.feeGrowthInside1LastX128,
  };
}

async function savePositionSnapshot(
  position: Position,
  event: any,
  context: any,
): Promise<void> {
  const chainId = event.chainId;
  const cfg = chainConfig(chainId);
  const transaction = await loadTransaction(event, context);
  const barePoolId = position.pool_id.slice(`${chainId}-`.length);
  const flipped = cfg.poolsList.includes(barePoolId);

  const snapshot: PositionSnapshot = {
    id: `${position.id}#${event.block.number}`,
    owner: position.owner,
    pool_id: position.pool_id,
    position_id: position.id,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    liquidity: position.liquidity,
    transaction_id: transaction.id,
    depositedToken0: flipped ? position.depositedToken1 : position.depositedToken0,
    depositedToken1: flipped ? position.depositedToken0 : position.depositedToken1,
    withdrawnToken0: flipped ? position.withdrawnToken1 : position.withdrawnToken0,
    withdrawnToken1: flipped ? position.withdrawnToken0 : position.withdrawnToken1,
    collectedFeesToken0: flipped ? position.collectedFeesToken1 : position.collectedFeesToken0,
    collectedFeesToken1: flipped ? position.collectedFeesToken0 : position.collectedFeesToken1,
    feeGrowthInside0LastX128: flipped
      ? position.feeGrowthInside1LastX128
      : position.feeGrowthInside0LastX128,
    feeGrowthInside1LastX128: flipped
      ? position.feeGrowthInside0LastX128
      : position.feeGrowthInside1LastX128,
  };
  context.PositionSnapshot.set(snapshot);
}

async function resolveAmounts(
  position: Position,
  event: any,
  context: any,
  amount0Raw: bigint,
  amount1Raw: bigint,
) {
  const chainId = event.chainId;
  const cfg = chainConfig(chainId);
  const barePoolId = position.pool_id.slice(`${chainId}-`.length);
  const flipped = cfg.poolsList.includes(barePoolId);

  const [token0, token1] = await Promise.all([
    context.Token.getOrThrow(position.token0_id),
    context.Token.getOrThrow(position.token1_id),
  ]);

  const amount0 = flipped
    ? convertTokenToDecimal(amount1Raw, token0.decimals)
    : convertTokenToDecimal(amount0Raw, token0.decimals);
  const amount1 = flipped
    ? convertTokenToDecimal(amount0Raw, token1.decimals)
    : convertTokenToDecimal(amount1Raw, token1.decimals);

  return { amount0, amount1 };
}

indexer.onEvent(
  { contract: "NonfungiblePositionManager", event: "IncreaseLiquidity" },
  async ({ event, context }) => {
    let position = await getPosition(event, context, event.params.tokenId);
    if (!position) return;

    const { amount0, amount1 } = await resolveAmounts(
      position,
      event,
      context,
      event.params.amount0,
      event.params.amount1,
    );

    position = {
      ...position,
      liquidity: position.liquidity + event.params.liquidity,
      depositedToken0: plus(position.depositedToken0, amount0),
      depositedToken1: plus(position.depositedToken1, amount1),
    };
    context.Position.set(position);
    await savePositionSnapshot(position, event, context);
  },
);

indexer.onEvent(
  { contract: "NonfungiblePositionManager", event: "DecreaseLiquidity" },
  async ({ event, context }) => {
    let position = await getPosition(event, context, event.params.tokenId);
    if (!position) return;

    const { amount0, amount1 } = await resolveAmounts(
      position,
      event,
      context,
      event.params.amount0,
      event.params.amount1,
    );

    position = {
      ...position,
      liquidity: position.liquidity - event.params.liquidity,
      withdrawnToken0: plus(position.withdrawnToken0, amount0),
      withdrawnToken1: plus(position.withdrawnToken1, amount1),
    };
    position = await updateFeeVars(position, event, context, event.params.tokenId);

    context.Position.set(position);
    await savePositionSnapshot(position, event, context);
  },
);

indexer.onEvent(
  { contract: "NonfungiblePositionManager", event: "Collect" },
  async ({ event, context }) => {
    let position = await getPosition(event, context, event.params.tokenId);
    if (!position) return;

    const { amount0, amount1 } = await resolveAmounts(
      position,
      event,
      context,
      event.params.amount0,
      event.params.amount1,
    );

    position = {
      ...position,
      collectedToken0: plus(position.collectedToken0, amount0),
      collectedToken1: plus(position.collectedToken1, amount1),
    };
    position = {
      ...position,
      collectedFeesToken0: minus(position.collectedToken0, position.withdrawnToken0),
      collectedFeesToken1: minus(position.collectedToken1, position.withdrawnToken1),
    };
    position = await updateFeeVars(position, event, context, event.params.tokenId);

    context.Position.set(position);
    await savePositionSnapshot(position, event, context);
  },
);

indexer.onEvent(
  { contract: "NonfungiblePositionManager", event: "Transfer" },
  async ({ event, context }) => {
    let position = await getPosition(event, context, event.params.tokenId);
    if (!position) return;

    position = { ...position, owner: event.params.to };
    context.Position.set(position);
    await savePositionSnapshot(position, event, context);
  },
);
