import { describe, expect, it } from "vitest";
import { applyGuards, distributionFromQuantiles, stabilitySplit, wilson } from "../src/stats/stats";

describe("Wilson 95% interval", () => {
  it("matches the textbook value for 5 successes in 10 trials", () => {
    const w = wilson(5, 10);
    expect(w).not.toBeNull();
    expect(w?.estimate).toBeCloseTo(0.5, 10);
    expect(w?.lo).toBeCloseTo(0.2366, 4);
    expect(w?.hi).toBeCloseTo(0.7634, 4);
  });

  it("matches the closed form z²/(n+z²) for zero successes", () => {
    const w = wilson(0, 5);
    const z2 = 1.959963984540054 ** 2;
    expect(w?.lo).toBe(0);
    expect(w?.hi).toBeCloseTo(z2 / (5 + z2), 10);
  });

  it("is symmetric: k=n mirrors k=0", () => {
    const zero = wilson(0, 5);
    const all = wilson(5, 5);
    expect(all?.hi).toBe(1);
    expect(all?.lo).toBeCloseTo(1 - (zero?.hi ?? 0), 10);
  });

  it("tightens as n grows at fixed p", () => {
    const small = wilson(5, 10);
    const large = wilson(500, 1000);
    expect((large?.hi ?? 0) - (large?.lo ?? 0)).toBeLessThan((small?.hi ?? 0) - (small?.lo ?? 0));
  });

  it("handles empty and impossible inputs", () => {
    expect(wilson(0, 0)).toBeNull();
    expect(() => wilson(6, 5)).toThrow();
    expect(() => wilson(-1, 5)).toThrow();
  });
});

describe("minimum-N guards", () => {
  it("flags low samples and refuses tiny ones", () => {
    const floors = { warn: 30, refuse: 10 };
    expect(applyGuards(50, floors)).toMatchObject({ lowSample: false, refused: false });
    expect(applyGuards(29, floors)).toMatchObject({ lowSample: true, refused: false });
    expect(applyGuards(9, floors)).toMatchObject({ lowSample: true, refused: true });
    expect(applyGuards(10, floors)).toMatchObject({ refused: false });
  });
});

describe("stability split", () => {
  it("agrees when the halves are statistically compatible", () => {
    const s = stabilitySplit(50, 30, 50, 28);
    expect(s.agree).toBe(true);
  });
  it("disagrees when the halves are far apart", () => {
    const s = stabilitySplit(50, 5, 50, 45);
    expect(s.agree).toBe(false);
  });
  it("returns null agreement when a half is empty", () => {
    expect(stabilitySplit(0, 0, 50, 25).agree).toBeNull();
  });
});

describe("distribution summary", () => {
  it("builds from a quantile vector", () => {
    const d = distributionFromQuantiles(4, 60, [0, 0, 60, 120, 120, 120], "minutes");
    expect(d).toMatchObject({ count: 4, mean: 60, min: 0, median: 60, p90: 120, max: 120 });
  });
  it("returns null for empty and malformed inputs", () => {
    expect(distributionFromQuantiles(0, 0, [0, 0, 0, 0, 0, 0], "minutes")).toBeNull();
    expect(distributionFromQuantiles(4, 60, [0, 0, 60], "minutes")).toBeNull();
  });
});
