/** Per-chain constants, keyed by chain ID. */
export type EthPriceSide = "token0Price" | "token1Price";

export type ChainConfig = {
  readonly name: string;
  readonly factoryAddress: string;
  readonly wethAddress: string;
  readonly usdcWethPool: string;
  readonly ethPriceSide: EthPriceSide;
  readonly minimumEthLocked: string;
  readonly whitelistTokens: readonly string[];
  readonly stableCoins: readonly string[];
  readonly poolsList: readonly string[];
};

export const CHAIN_CONFIG: Record<number, ChainConfig> = {
  59144: {
    name: "lynex",
    factoryAddress: "0x622b2c98123D303ae067DB4925CD6282B3A08D0F",
    wethAddress: "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f",
    usdcWethPool: "0x3cb104f044db23d6513f2a6100a1997fa5e3f587",
    ethPriceSide: "token0Price",
    minimumEthLocked: "0",
    whitelistTokens: [
      "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f", // WETH
      "0x176211869ca2b568f2a7d4ee941e073a821ee1ff", // USDC
      "0xa219439258ca9da29e9cc4ce5596924745e12b93", // USDT
      "0x3aab2285ddcddad8edf438c1bab47e1a9d05a9b4", // WBTC
      "0x1a51b19ce03dbe0cb44c1528e34a7edd7771e9af", // LYNEX
    ],
    stableCoins: [
      "0x176211869ca2b568f2a7d4ee941e073a821ee1ff", // USDC
      "0xa219439258ca9da29e9cc4ce5596924745e12b93", // USDT
    ],
    poolsList: [""],
  },

  48900: {
    name: "ocelex",
    factoryAddress: "0x03057ae6294292b299a1863420edD65e0197AFEf",
    wethAddress: "0x4200000000000000000000000000000000000006",
    usdcWethPool: "0xcd927c5800d1d4e896a135ce0a4528979c8d24b3",
    ethPriceSide: "token1Price",
    minimumEthLocked: "0.1",
    whitelistTokens: [
      "0x4200000000000000000000000000000000000006", // WETH
      "0x46dda6a5a559d861c06ec9a95fb395f5c3db0742", // USDT
      "0xfd418e42783382e86ae91e445406600ba144d162", // ZRC
      "0x19df5689cfce64bc2a55f7220b0cd522659955ef", // BTC
      "0x3b952c8c9c44e8fe201e2b26f6b2200203214cff", // USDC
      "0x58024021fe3ef613fa76e2f36a3da97eb1454c36", // OCELEX
      "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", // ETHENA
    ],
    stableCoins: [
      "0x46dda6a5a559d861c06ec9a95fb395f5c3db0742", // USDT
      "0x3b952c8c9c44e8fe201e2b26f6b2200203214cff", // USDC
      "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", // ETHENA
    ],
    poolsList: [""],
  },
};

export function chainConfig(chainId: number): ChainConfig {
  const cfg = CHAIN_CONFIG[chainId];
  if (!cfg) throw new Error(`No chain config for chainId ${chainId}`);
  return cfg;
}

export const RPC_URL: Record<number, string> = {
  59144: process.env.ENVIO_RPC_URL_59144 || "https://rpc.linea.build",
  48900: process.env.ENVIO_RPC_URL_48900 || "https://mainnet.zircuit.com",
};

export const RPC_FALLBACK_URL: Record<number, string | undefined> = {
  59144: process.env.ENVIO_RPC_URL_59144_FALLBACK,
  48900: process.env.ENVIO_RPC_URL_48900_FALLBACK,
};

export function cid(chainId: number, id: string): string {
  return `${chainId}-${id}`;
}

export function bundleId(chainId: number): string {
  return cid(chainId, "1");
}

export function factoryId(chainId: number): string {
  return cid(chainId, chainConfig(chainId).factoryAddress);
}
