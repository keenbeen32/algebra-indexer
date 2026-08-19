import { describe, expect, it } from "vitest";
import {
  CHAIN_CONFIG,
  chainConfig,
  cid,
  bundleId,
  factoryId,
} from "../src/config/chains.js";
import { createTick, tickId } from "../src/utils/tick.js";
import { priceToTokenPrices } from "../src/utils/pricing.js";
import { ZERO_BI } from "../src/utils/constants.js";
import { safeDiv, ONE_BD } from "../src/utils/bigdecimal.js";

describe("chainConfig", () => {
  it("resolves both configured chains", () => {
    expect(chainConfig(59144)).toBe(CHAIN_CONFIG[59144]);
    expect(chainConfig(48900)).toBe(CHAIN_CONFIG[48900]);
  });

  it("throws for an unconfigured chain", () => {
    expect(() => chainConfig(1)).toThrow(/No chain config/);
  });

  it("keeps every configured address lowercase except the factory constant", () => {
    for (const cfg of Object.values(CHAIN_CONFIG)) {
      expect(cfg.wethAddress).toBe(cfg.wethAddress.toLowerCase());
      expect(cfg.usdcWethPool).toBe(cfg.usdcWethPool.toLowerCase());
      for (const t of cfg.whitelistTokens) expect(t).toBe(t.toLowerCase());
      for (const t of cfg.stableCoins) expect(t).toBe(t.toLowerCase());
    }
  });

  it("selects a valid ETH price side per chain", () => {
    for (const cfg of Object.values(CHAIN_CONFIG)) {
      expect(["token0Price", "token1Price"]).toContain(cfg.ethPriceSide);
    }
  });
});

describe("id helpers", () => {
  it("prefixes with the chain id", () => {
    expect(cid(59144, "abc")).toBe("59144-abc");
  });

  it("keys the bundle on 1", () => {
    expect(bundleId(48900)).toBe("48900-1");
  });

  it("keys the factory on the configured factory address", () => {
    expect(factoryId(59144)).toBe(`59144-${chainConfig(59144).factoryAddress}`);
  });

  it("builds tick ids as chain-pool#tick", () => {
    expect(tickId(59144, "0xabc", -2389n)).toBe("59144-0xabc#-2389");
    expect(tickId(48900, "0xabc", 0n)).toBe("48900-0xabc#0");
  });
});

describe("createTick", () => {
  const id = tickId(59144, "0xpool", 60n);
  const tick = createTick(id, 60n, "59144-0xpool", "0xpool", 100n, 1_700_000_000n);

  it("carries the ids it was given", () => {
    expect(tick.id).toBe(id);
    expect(tick.pool_id).toBe("59144-0xpool");
    expect(tick.poolAddress).toBe("0xpool");
    expect(tick.tickIdx).toBe(60n);
  });

  it("derives price1 as the inverse of price0", () => {
    expect(tick.price1.toString()).toBe(safeDiv(ONE_BD, tick.price0).toString());
  });

  it("prices tick 0 at one", () => {
    const zero = createTick(tickId(59144, "0xpool", 0n), 0n, "59144-0xpool", "0xpool", 1n, 1n);
    expect(zero.price0.toString()).toBe("1");
    expect(zero.price1.toString()).toBe("1");
  });

  it("starts every accumulator at zero", () => {
    expect(tick.liquidityGross).toBe(ZERO_BI);
    expect(tick.liquidityNet).toBe(ZERO_BI);
    expect(tick.feeGrowthOutside0X128).toBe(ZERO_BI);
    expect(tick.feeGrowthOutside1X128).toBe(ZERO_BI);
    expect(tick.volumeToken0.isZero()).toBe(true);
    expect(tick.collectedFeesUSD.isZero()).toBe(true);
  });
});

describe("priceToTokenPrices", () => {
  it("returns a reciprocal pair", () => {
    const [price0, price1] = priceToTokenPrices(2n ** 96n, 18n, 18n);
    expect(price0.toString()).toBe(safeDiv(ONE_BD, price1).toString());
  });

  it("prices a 1:1 pool one-to-one when decimals match", () => {
    const [price0, price1] = priceToTokenPrices(2n ** 96n, 18n, 18n);
    expect(Number(price0.toString())).toBeCloseTo(1, 6);
    expect(Number(price1.toString())).toBeCloseTo(1, 6);
  });

  it("accounts for differing token decimals", () => {
    const [, price1] = priceToTokenPrices(2n ** 96n, 18n, 6n);
    expect(Number(price1.toString())).toBeCloseTo(1e12, 0);
  });

  it("is finite at a small sqrt price", () => {
    const [price0, price1] = priceToTokenPrices(2n ** 48n, 18n, 18n);
    expect(price0.isFinite()).toBe(true);
    expect(price1.isFinite()).toBe(true);
  });
});
