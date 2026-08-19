import { describe, expect, it } from "vitest";
import { BigDecimal } from "envio";
import {
  SIGNIFICANT_DIGITS,
  ZERO_BD,
  ONE_BD,
  bd,
  norm,
  plus,
  minus,
  times,
  div,
  safeDiv,
  exponentToBigDecimal,
  bigDecimalExponated,
  convertTokenToDecimal,
} from "../src/utils/bigdecimal.js";

const sig = (x: BigDecimal) => x.precision();

describe("norm", () => {
  it("reduces to 34 significant digits", () => {
    const wide = new BigDecimal("1." + "1".repeat(60));
    expect(sig(norm(wide))).toBe(SIGNIFICANT_DIGITS);
  });

  it("leaves a value already inside the budget alone", () => {
    expect(norm(bd("1.5")).toString()).toBe("1.5");
  });

  it("passes zero through", () => {
    expect(norm(ZERO_BD).isZero()).toBe(true);
  });

  it("rounds half up", () => {
    const x = new BigDecimal("1." + "0".repeat(32) + "15");
    expect(norm(x).toString()).toBe("1." + "0".repeat(32) + "2");
  });
});

describe("arithmetic helpers", () => {
  it("normalises each result", () => {
    const a = new BigDecimal("1e-10");
    const b = new BigDecimal("3");
    expect(sig(div(a, b))).toBe(SIGNIFICANT_DIGITS);
  });

  it("normalises per operation, not once at the end", () => {
    const a = new BigDecimal("1e-10");
    const b = new BigDecimal("3");
    const c = new BigDecimal("7");

    // times(div(a, b), c) must round the quotient BEFORE multiplying.
    expect(times(div(a, b), c).toString()).toBe(
      norm(norm(a.div(b)).times(c)).toString(),
    );
  });

  it("adds, subtracts and multiplies", () => {
    expect(plus(bd(2), bd(3)).toString()).toBe("5");
    expect(minus(bd(5), bd(3)).toString()).toBe("2");
    expect(times(bd(4), bd(3)).toString()).toBe("12");
    expect(div(bd(6), bd(3)).toString()).toBe("2");
  });
});

describe("safeDiv", () => {
  it("yields zero on a zero denominator rather than throwing", () => {
    expect(safeDiv(ONE_BD, ZERO_BD).isZero()).toBe(true);
  });

  it("divides normally otherwise", () => {
    expect(safeDiv(bd(9), bd(3)).toString()).toBe("3");
  });
});

describe("exponentToBigDecimal", () => {
  it("builds 10^n", () => {
    expect(exponentToBigDecimal(0n).toString()).toBe("1");
    expect(exponentToBigDecimal(6n).toString()).toBe("1000000");
    expect(exponentToBigDecimal(18n).toString()).toBe("1000000000000000000");
  });

  it("returns a stable value when memoised", () => {
    expect(exponentToBigDecimal(18n).toString()).toBe(
      exponentToBigDecimal(18n).toString(),
    );
  });
});

describe("bigDecimalExponated", () => {
  const base = bd("1.0001");

  it("returns one for a zero exponent", () => {
    expect(bigDecimalExponated(base, 0n).toString()).toBe("1");
  });

  it("matches repeated multiplication for a small exponent", () => {
    let expected = ONE_BD;
    for (let i = 0; i < 25; i++) expected = times(expected, base);
    expect(bigDecimalExponated(base, 25n).toString()).toBe(expected.toString());
  });

  it("inverts for a negative exponent", () => {
    const positive = bigDecimalExponated(base, 40n);
    const negative = bigDecimalExponated(base, -40n);
    expect(negative.toString()).toBe(safeDiv(ONE_BD, positive).toString());
  });

  it("is consistent across the checkpoint boundary", () => {
    const viaCheckpoint = bigDecimalExponated(base, 2500n);
    const stepped = times(bigDecimalExponated(base, 2499n), base);
    expect(viaCheckpoint.toString()).toBe(stepped.toString());
  });

  it("handles the tick bounds without overflowing to zero or infinity", () => {
    const upper = bigDecimalExponated(base, 887272n);
    const lower = bigDecimalExponated(base, -887272n);
    expect(upper.isFinite()).toBe(true);
    expect(upper.isZero()).toBe(false);
    expect(lower.isFinite()).toBe(true);
    expect(lower.isZero()).toBe(false);
    expect(sig(upper)).toBeLessThanOrEqual(SIGNIFICANT_DIGITS);
  });
});

describe("convertTokenToDecimal", () => {
  it("scales by the token's decimals", () => {
    expect(convertTokenToDecimal(1_500_000n, 6n).toString()).toBe("1.5");
    expect(convertTokenToDecimal(10n ** 18n, 18n).toString()).toBe("1");
  });

  it("returns the raw amount when decimals is zero", () => {
    expect(convertTokenToDecimal(42n, 0n).toString()).toBe("42");
  });
});
