/** Native and token pricing. */
import { BigDecimal } from "envio";
import type { Token } from "envio";
import { chainConfig, cid, bundleId } from "../config/chains.js";
import {
  ZERO_BD,
  ONE_BD,
  bd,
  div,
  times,
  plus,
  safeDiv,
  exponentToBigDecimal,
} from "./bigdecimal.js";

const Q192 = new BigDecimal("6.277101735386681e+57");

export function priceToTokenPrices(
  price: bigint,
  token0Decimals: bigint,
  token1Decimals: bigint,
): [BigDecimal, BigDecimal] {
  const num = bd(price * price);
  const price1 = div(
    times(div(num, Q192), exponentToBigDecimal(token0Decimals)),
    exponentToBigDecimal(token1Decimals),
  );
  const price0 = safeDiv(ONE_BD, price1);
  return [price0, price1];
}

export async function getEthPriceInUSD(
  chainId: number,
  context: any,
): Promise<BigDecimal> {
  const cfg = chainConfig(chainId);
  const usdcPool = await context.Pool.get(cid(chainId, cfg.usdcWethPool));
  if (!usdcPool) return ZERO_BD;
  return cfg.ethPriceSide === "token0Price"
    ? usdcPool.token0Price
    : usdcPool.token1Price;
}

export async function findEthPerToken(
  token: Token,
  chainId: number,
  context: any,
): Promise<BigDecimal> {
  const cfg = chainConfig(chainId);

  const bareId = token.id.slice(`${chainId}-`.length);
  if (bareId === cfg.wethAddress) return ONE_BD;

  const bundle = await context.Bundle.get(bundleId(chainId));

  if (cfg.stableCoins.includes(bareId)) {
    return safeDiv(ONE_BD, bundle.ethPriceUSD);
  }

  const minimumEthLocked = bd(cfg.minimumEthLocked);
  let largestLiquidityEth = ZERO_BD;
  let priceSoFar = ZERO_BD;

  const whiteList = token.whitelistPools;
  const pools = await Promise.all(
    whiteList.map((poolAddress: string) => context.Pool.get(poolAddress)),
  );

  const counterpartyIds = pools.map((pool: any) =>
    pool ? (pool.token0_id === token.id ? pool.token1_id : pool.token0_id) : undefined,
  );
  const counterparties = await Promise.all(
    counterpartyIds.map((id: string | undefined) =>
      id ? context.Token.get(id) : undefined,
    ),
  );

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    if (!pool) {
      throw new Error(
        `findEthPerToken: whitelistPool ${whiteList[i]} missing for token ${token.id}`,
      );
    }
    if (pool.liquidity <= 0n) continue;

    const other = counterparties[i];
    if (!other) {
      throw new Error(
        `findEthPerToken: counterparty token missing for pool ${pool.id}`,
      );
    }

    if (pool.token0_id === token.id) {
      const ethLocked = times(pool.totalValueLockedToken1, other.derivedEth);
      if (ethLocked.gt(largestLiquidityEth) && ethLocked.gt(minimumEthLocked)) {
        largestLiquidityEth = ethLocked;
        priceSoFar = times(pool.token1Price, other.derivedEth);
      }
    }
    if (pool.token1_id === token.id) {
      const ethLocked = times(pool.totalValueLockedToken0, other.derivedEth);
      if (ethLocked.gt(largestLiquidityEth) && ethLocked.gt(minimumEthLocked)) {
        largestLiquidityEth = ethLocked;
        priceSoFar = times(pool.token0Price, other.derivedEth);
      }
    }
  }

  return priceSoFar;
}

export async function getTrackedAmountUSD(
  chainId: number,
  context: any,
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
): Promise<BigDecimal> {
  const cfg = chainConfig(chainId);
  const bundle = await context.Bundle.get(bundleId(chainId));

  const price0USD = times(token0.derivedEth, bundle.ethPriceUSD);
  const price1USD = times(token1.derivedEth, bundle.ethPriceUSD);

  const bare0 = token0.id.slice(`${chainId}-`.length);
  const bare1 = token1.id.slice(`${chainId}-`.length);
  const w0 = cfg.whitelistTokens.includes(bare0);
  const w1 = cfg.whitelistTokens.includes(bare1);

  if (w0 && w1) {
    return plus(times(tokenAmount0, price0USD), times(tokenAmount1, price1USD));
  }
  if (w0 && !w1) {
    return times(times(tokenAmount0, price0USD), bd(2));
  }
  if (!w0 && w1) {
    return times(times(tokenAmount1, price1USD), bd(2));
  }
  return ZERO_BD;
}
