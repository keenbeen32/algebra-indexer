/** BigDecimal arithmetic. */
import { BigDecimal } from "envio";

export const SIGNIFICANT_DIGITS = 34;

export const ROUNDING_MODE = BigDecimal.ROUND_HALF_UP;

BigDecimal.set({ DECIMAL_PLACES: 200, ROUNDING_MODE });

export function norm(x: BigDecimal): BigDecimal {
  if (x.isZero()) return x;
  return x.precision(SIGNIFICANT_DIGITS, ROUNDING_MODE);
}

export const ZERO_BD = new BigDecimal("0");
export const ONE_BD = new BigDecimal("1");

export function bd(value: string | number | bigint): BigDecimal {
  return norm(new BigDecimal(value.toString()));
}

export const plus = (a: BigDecimal, b: BigDecimal) => norm(a.plus(b));
export const minus = (a: BigDecimal, b: BigDecimal) => norm(a.minus(b));
export const times = (a: BigDecimal, b: BigDecimal) => norm(a.times(b));
export const div = (a: BigDecimal, b: BigDecimal) => norm(a.div(b));

export function safeDiv(amount0: BigDecimal, amount1: BigDecimal): BigDecimal {
  if (amount1.isZero()) return ZERO_BD;
  return div(amount0, amount1);
}

const expCache = new Map<string, BigDecimal>();
export function exponentToBigDecimal(decimals: bigint): BigDecimal {
  const key = decimals.toString();
  const hit = expCache.get(key);
  if (hit) return hit;
  let result = ONE_BD;
  const ten = bd(10);
  for (let i = 0n; i < decimals; i++) result = times(result, ten);
  expCache.set(key, result);
  return result;
}

const powCache = new Map<string, BigDecimal>();

const CHECKPOINT_INTERVAL = 1000;
const powCheckpoints = new Map<string, Map<number, BigDecimal>>();

export function bigDecimalExponated(value: BigDecimal, power: bigint): BigDecimal {
  if (power === 0n) return ONE_BD;

  const key = `${value.toString()}^${power.toString()}`;
  const hit = powCache.get(key);
  if (hit) return hit;

  const negativePower = power < 0n;
  const powerAbs = negativePower ? -power : power;
  const n = Number(powerAbs);

  const valueKey = value.toString();
  let checkpoints = powCheckpoints.get(valueKey);
  if (!checkpoints) {
    checkpoints = new Map<number, BigDecimal>();
    powCheckpoints.set(valueKey, checkpoints);
  }

  let start = 1;
  let result = norm(ZERO_BD.plus(value));

  const floor = Math.floor(n / CHECKPOINT_INTERVAL) * CHECKPOINT_INTERVAL;
  for (let cp = floor; cp >= CHECKPOINT_INTERVAL; cp -= CHECKPOINT_INTERVAL) {
    const cached = checkpoints.get(cp);
    if (cached) {
      start = cp;
      result = cached;
      break;
    }
  }

  for (let i = start; i < n; i++) {
    result = times(result, value);
    const at = i + 1;
    if (at % CHECKPOINT_INTERVAL === 0 && !checkpoints.has(at)) {
      checkpoints.set(at, result);
    }
  }

  if (negativePower) {
    result = safeDiv(ONE_BD, result);
  }

  powCache.set(key, result);
  return result;
}

export function convertTokenToDecimal(
  tokenAmount: bigint,
  exchangeDecimals: bigint,
): BigDecimal {
  if (exchangeDecimals === 0n) return bd(tokenAmount);
  return div(bd(tokenAmount), exponentToBigDecimal(exchangeDecimals));
}

export function convertEthToDecimal(eth: bigint): BigDecimal {
  return div(bd(eth), bd("1000000000000000000"));
}
