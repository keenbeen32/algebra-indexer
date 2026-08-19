/** Tick construction. */
import type { Tick } from "envio";
import { ZERO_BI } from "./constants.js";
import { ZERO_BD, ONE_BD, bd, safeDiv, bigDecimalExponated } from "./bigdecimal.js";

const ONE_OOOL = bd("1.0001");

export function createTick(
  tickId: string,
  tickIdx: bigint,
  poolId: string,
  poolAddress: string,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Tick {
  const price0 = bigDecimalExponated(ONE_OOOL, tickIdx);
  return {
    id: tickId,
    tickIdx,
    pool_id: poolId,
    poolAddress,
    createdAtTimestamp: blockTimestamp,
    createdAtBlockNumber: blockNumber,
    liquidityGross: ZERO_BI,
    liquidityNet: ZERO_BI,
    liquidityProviderCount: ZERO_BI,
    price0,
    price1: safeDiv(ONE_BD, price0),
    volumeToken0: ZERO_BD,
    volumeToken1: ZERO_BD,
    volumeUSD: ZERO_BD,
    untrackedVolumeUSD: ZERO_BD,
    feesUSD: ZERO_BD,
    collectedFeesToken0: ZERO_BD,
    collectedFeesToken1: ZERO_BD,
    collectedFeesUSD: ZERO_BD,
    feeGrowthOutside0X128: ZERO_BI,
    feeGrowthOutside1X128: ZERO_BI,
  };
}

export function tickId(chainId: number, poolAddress: string, tickIdx: bigint): string {
  return `${chainId}-${poolAddress}#${tickIdx.toString()}`;
}
