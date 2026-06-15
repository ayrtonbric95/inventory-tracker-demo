import { describe, it, expect } from "vitest";
import {
  gToLb, finG, finBags, sizeBags, locBags, locG, avgBagG, sizeBucket,
  computeForecast, computeRestockPlan, computeReorder, computeHealth,
  computeForecastAccuracy, cycleCountAccuracy,
  REORDER_BUFFER, type Row, type ForecastSnapshot,
} from "./forecast";

const mkRow = (over: Partial<Row> = {}): Row => ({
  id: "mint",
  name: "Moroccan Mint",
  raw: 1000,
  lead: 21,
  vel: 10,
  sizes: [
    { variantId: "v1oz", label: "1 oz", grams: 28, bags: 10 },
    { variantId: "v2oz", label: "2 oz", grams: 57, bags: 5 },
  ],
  ...over,
});

describe("unit helpers", () => {
  it("gToLb converts grams to pounds", () => {
    expect(gToLb(453.592)).toBeCloseTo(1, 5);
  });

  it("finG sums bags × grams across sizes", () => {
    const r = mkRow();
    expect(finG(r)).toBe(10 * 28 + 5 * 57);
  });

  it("finBags sums bag counts across sizes", () => {
    expect(finBags(mkRow())).toBe(15);
  });

  it("sizeBags returns total bags for the 'total' view", () => {
    const z = { variantId: "v", label: "1 oz", grams: 28, bags: 10, byLocation: { warehouse: 6, mall: 4 } };
    expect(sizeBags(z, "total")).toBe(10);
  });

  it("sizeBags returns the per-location split when present", () => {
    const z = { variantId: "v", label: "1 oz", grams: 28, bags: 10, byLocation: { warehouse: 6, mall: 4 } };
    expect(sizeBags(z, "warehouse")).toBe(6);
    expect(sizeBags(z, "mall")).toBe(4);
  });

  it("sizeBags assumes everything is at the warehouse before byLocation exists", () => {
    const z = { variantId: "v", label: "1 oz", grams: 28, bags: 10 };
    expect(sizeBags(z, "warehouse")).toBe(10);
    expect(sizeBags(z, "mall")).toBe(0);
  });

  it("locBags and locG sum a row's bags/grams scoped to one location", () => {
    const r = mkRow({
      sizes: [
        { variantId: "v1oz", label: "1 oz", grams: 28, bags: 10, byLocation: { warehouse: 6, mall: 4 } },
        { variantId: "v2oz", label: "2 oz", grams: 57, bags: 5, byLocation: { warehouse: 2, mall: 3 } },
      ],
    });
    expect(locBags(r, "warehouse")).toBe(8);
    expect(locBags(r, "mall")).toBe(7);
    expect(locG(r, "warehouse")).toBe(6 * 28 + 2 * 57);
    expect(locG(r, "mall")).toBe(4 * 28 + 3 * 57);
  });

  it("avgBagG weights size grams by the mix percentages", () => {
    // All 1oz (28.3495g) -> ~28g average bag.
    expect(avgBagG({ s1: 1, s2: 0, s4: 0, s8: 0 })).toBe(28);
    // All 2oz (56.699g) -> ~57g average bag.
    expect(avgBagG({ s1: 0, s2: 1, s4: 0, s8: 0 })).toBe(57);
  });

  it("sizeBucket maps labels to their event/mall mix bucket", () => {
    expect(sizeBucket("1 oz")).toBe("s1");
    expect(sizeBucket("2 oz")).toBe("s2");
    expect(sizeBucket("4 oz")).toBe("s4");
    expect(sizeBucket("8 oz")).toBe("s8");
    // 3.5oz (matcha-style) rolls up into the 4oz bucket.
    expect(sizeBucket("3.5 oz")).toBe("s4");
  });
});

describe("computeForecast", () => {
  const baseOpts = {
    season: {},
    posMix: { s1: 45, s2: 45, s4: 10 },
    gPerBag: 50,
    velSum: 10, // single row with vel 10
  };

  it("computes event total bags from attendees × conversion × bags/attendee", () => {
    const rows = [mkRow()];
    const ev = { name: "Market", date: "", type: "farmers market", attendees: 250, conv: 12, bags: 1.4, buffer: 15 };
    const mall = { traffic: 0, conv: 0, bags: 0, weeks: 4, buffer: 15 };
    const out = computeForecast(rows, { ...baseOpts, mode: "event", ev, mall });
    expect(out.totalBags).toBe(Math.round(250 * 0.12 * 1.4)); // 42
  });

  it("computes mall total bags from traffic × conversion × bags × weeks", () => {
    const rows = [mkRow()];
    const ev = { name: "Market", date: "", type: "farmers market", attendees: 0, conv: 0, bags: 0, buffer: 15 };
    const mall = { traffic: 3000, conv: 1.5, bags: 1.2, weeks: 4, buffer: 15 };
    const out = computeForecast(rows, { ...baseOpts, mode: "mall", ev, mall });
    expect(out.totalBags).toBe(Math.round(3000 * 0.015 * 1.2 * 4)); // 216
  });

  it("flags BUY when raw + finished can't cover the forecast even with the buffer", () => {
    // Huge demand, almost nothing on hand.
    const rows = [mkRow({ raw: 0, sizes: [
      { variantId: "v1oz", label: "1 oz", grams: 28, bags: 0 },
      { variantId: "v2oz", label: "2 oz", grams: 57, bags: 0 },
    ] })];
    const ev = { name: "Market", date: "", type: "farmers market", attendees: 10000, conv: 50, bags: 2, buffer: 15 };
    const mall = { traffic: 0, conv: 0, bags: 0, weeks: 4, buffer: 15 };
    const out = computeForecast(rows, { ...baseOpts, mode: "event", ev, mall });
    expect(out.lines[0].verdict).toBe("BUY");
    expect(out.lines[0].buyG).toBeGreaterThan(0);
    expect(out.flagged).toBe(1);
  });

  it("verdict is OK when finished stock alone already covers the forecast", () => {
    const rows = [mkRow({ raw: 0, sizes: [
      { variantId: "v1oz", label: "1 oz", grams: 28, bags: 1000 },
      { variantId: "v2oz", label: "2 oz", grams: 57, bags: 1000 },
    ] })];
    const ev = { name: "Market", date: "", type: "farmers market", attendees: 250, conv: 12, bags: 1.4, buffer: 15 };
    const mall = { traffic: 0, conv: 0, bags: 0, weeks: 4, buffer: 15 };
    const out = computeForecast(rows, { ...baseOpts, mode: "event", ev, mall });
    expect(out.lines[0].verdict).toBe("OK");
    expect(out.lines[0].buyG).toBe(0);
    expect(out.flagged).toBe(0);
  });
});

describe("computeRestockPlan", () => {
  it("prepares enough bags to reach `weeks` of cover net of what's on hand", () => {
    const rows = [mkRow({ sizes: [
      { variantId: "v1oz", label: "1 oz", grams: 28, bags: 0 },
    ] })];
    // 7 units/wk real sell-through over a 7-day window -> wkUnits = 7.
    const out = computeRestockPlan(rows, {
      byVariant: { v1oz: 7 },
      weeksInWindow: 1,
      season: {},
      restock: { weeks: 6, growth: 0, safety: 1.2 },
    });
    // target = 7 * 6 = 42 bags, 0 on hand -> prepare 42.
    expect(out.lines[0].sizes[0].prepare).toBe(42);
    expect(out.totalPrepareBags).toBe(42);
  });

  it("nets prepare target against bags already on hand", () => {
    const rows = [mkRow({ sizes: [
      { variantId: "v1oz", label: "1 oz", grams: 28, bags: 30 },
    ] })];
    const out = computeRestockPlan(rows, {
      byVariant: { v1oz: 7 },
      weeksInWindow: 1,
      season: {},
      restock: { weeks: 6, growth: 0, safety: 1.2 },
    });
    // target 42, 30 on hand -> prepare 12.
    expect(out.lines[0].sizes[0].prepare).toBe(12);
  });

  it("orders raw to cover production plus a lead-time safety buffer, net of raw on hand", () => {
    const rows = [mkRow({ raw: 0, lead: 7, sizes: [
      { variantId: "v1oz", label: "1 oz", grams: 100, bags: 0 },
    ] })];
    const out = computeRestockPlan(rows, {
      byVariant: { v1oz: 7 }, // 7 units/wk
      weeksInWindow: 1,
      season: {},
      restock: { weeks: 1, growth: 0, safety: 1 },
    });
    // target = 7 bags * 100g = 700g to produce.
    // wkGrams = 7 * 100 = 700; safetyG = 700 * (7/7) * 1 = 700.
    // orderRawG = 700 + 700 - 0 = 1400.
    expect(out.lines[0].produceG).toBe(700);
    expect(out.lines[0].safetyG).toBe(700);
    expect(out.lines[0].orderRawG).toBe(1400);
  });

  it("never produces a negative prepare or order amount", () => {
    const rows = [mkRow({ raw: 100000, sizes: [
      { variantId: "v1oz", label: "1 oz", grams: 28, bags: 10000 },
    ] })];
    const out = computeRestockPlan(rows, {
      byVariant: { v1oz: 1 },
      weeksInWindow: 1,
      season: {},
      restock: { weeks: 6, growth: 0, safety: 1.2 },
    });
    expect(out.lines[0].sizes[0].prepare).toBe(0);
    expect(out.lines[0].orderRawG).toBe(0);
  });
});

describe("computeReorder", () => {
  const gPerBag = 50; // grams per bag

  it("is OK when available stock comfortably exceeds the reorder point", () => {
    const r = mkRow({ raw: 100000, vel: 10, lead: 21 });
    const out = computeReorder([r], gPerBag);
    expect(out.lines[0].verdict).toBe("OK");
    expect(out.flagged).toBe(0);
  });

  it("is OK regardless of stock when there's no velocity (weeklyG <= 0)", () => {
    const r = mkRow({ raw: 0, vel: 0, sizes: [
      { variantId: "v1oz", label: "1 oz", grams: 28, bags: 0 },
    ] });
    const out = computeReorder([r], gPerBag);
    expect(out.lines[0].verdict).toBe("OK");
    expect(out.lines[0].coverWk).toBeNull();
  });

  it("flags REORDER when available stock falls below the reorder point", () => {
    // weeklyG = 10 * 50 = 500 g/wk; reorderG = 500 * (21/7) * 1.15 = 1725.
    const r = mkRow({ raw: 0, vel: 10, lead: 21, sizes: [
      { variantId: "v1oz", label: "1 oz", grams: 28, bags: 0 },
    ] });
    const out = computeReorder([r], gPerBag);
    expect(out.lines[0].reorderG).toBe(Math.round(500 * 3 * REORDER_BUFFER));
    expect(out.lines[0].available).toBe(0);
    expect(out.lines[0].verdict).toBe("REORDER");
    expect(out.flagged).toBe(1);
  });

  it("flags LOW between the reorder point and 1.3x the reorder point", () => {
    // reorderG = 1725 (see above). Pick available between 1725 and 1725*1.3=2242.5.
    const r = mkRow({ raw: 2000, vel: 10, lead: 21, sizes: [
      { variantId: "v1oz", label: "1 oz", grams: 28, bags: 0 },
    ] });
    const out = computeReorder([r], gPerBag);
    expect(out.lines[0].available).toBe(2000);
    expect(out.lines[0].verdict).toBe("LOW");
  });

  it("computes weeks of cover as available stock divided by weekly usage", () => {
    const r = mkRow({ raw: 1000, vel: 10, lead: 21, sizes: [
      { variantId: "v1oz", label: "1 oz", grams: 28, bags: 0 },
    ] });
    const out = computeReorder([r], gPerBag);
    // available = 1000, weeklyG = 500 -> 2 weeks of cover.
    expect(out.lines[0].coverWk).toBe(2);
  });
});

describe("computeForecastAccuracy", () => {
  const sales = {
    window: { since: "2026-01-01", until: "2026-01-14", days: 14 },
    byVariantWeekly: {
      v1oz: [5, 8],
      v2oz: [2, 3],
    } as Record<string, number[]>,
  };

  const mkSnapshot = (over: Partial<ForecastSnapshot> = {}): ForecastSnapshot => ({
    id: "snap1",
    savedAt: "2026-01-05T00:00:00.000Z",
    ev: { name: "Market", date: "2026-01-10", type: "farmers market", attendees: 250, conv: 12, bags: 1.4, buffer: 15 },
    lines: [{ id: "mint", name: "Moroccan Mint", predictedBags: 10 }],
    ...over,
  });

  it("returns status 'pending' when sales has no byVariantWeekly", () => {
    const out = computeForecastAccuracy(mkSnapshot(), { window: sales.window }, [mkRow()]);
    expect(out.status).toBe("pending");
    expect(out.lines[0].actualUnits).toBeNull();
    expect(out.lines[0].accuracyPct).toBeNull();
  });

  it("returns status 'pending' when sales is null", () => {
    const out = computeForecastAccuracy(mkSnapshot(), null, [mkRow()]);
    expect(out.status).toBe("pending");
  });

  it("returns status 'expired' when the event date is before the sales window", () => {
    const snap = mkSnapshot({ ev: { ...mkSnapshot().ev, date: "2025-12-01" } });
    const out = computeForecastAccuracy(snap, sales, [mkRow()]);
    expect(out.status).toBe("expired");
    expect(out.totalActual).toBeNull();
  });

  it("returns status 'expired' when the event date is after the sales window", () => {
    const snap = mkSnapshot({ ev: { ...mkSnapshot().ev, date: "2026-02-01" } });
    const out = computeForecastAccuracy(snap, sales, [mkRow()]);
    expect(out.status).toBe("expired");
  });

  it("scores actual units from the matching week bucket, summed across a tea's variants", () => {
    // 2026-01-10 is 9 days after since (2026-01-01) -> weekIdx 1.
    const out = computeForecastAccuracy(mkSnapshot(), sales, [mkRow()]);
    expect(out.status).toBe("scored");
    expect(out.weekIdx).toBe(1);
    // week 1 units: v1oz=8 + v2oz=3 = 11.
    expect(out.lines[0].actualUnits).toBe(11);
  });

  it("computes accuracyPct as 100 when actual matches predicted exactly", () => {
    const snap = mkSnapshot({ lines: [{ id: "mint", name: "Moroccan Mint", predictedBags: 11 }] });
    const out = computeForecastAccuracy(snap, sales, [mkRow()]);
    expect(out.lines[0].accuracyPct).toBe(100);
    expect(out.overallAccuracyPct).toBe(100);
  });

  it("computes accuracyPct that degrades as actual diverges from predicted, floored at 0", () => {
    const snap = mkSnapshot({ lines: [{ id: "mint", name: "Moroccan Mint", predictedBags: 1 }] });
    const out = computeForecastAccuracy(snap, sales, [mkRow()]);
    // predicted=1, actual=11 -> 100 - |11-1|/1*100 = -900 -> floored to 0.
    expect(out.lines[0].accuracyPct).toBe(0);
  });

  it("handles predictedBags === 0: 100% if actual is also 0, 0% otherwise", () => {
    const zeroSales = { window: sales.window, byVariantWeekly: { v1oz: [0, 0], v2oz: [0, 0] } };
    const snap = mkSnapshot({ lines: [{ id: "mint", name: "Moroccan Mint", predictedBags: 0 }] });
    expect(computeForecastAccuracy(snap, zeroSales, [mkRow()]).lines[0].accuracyPct).toBe(100);
    expect(computeForecastAccuracy(snap, sales, [mkRow()]).lines[0].accuracyPct).toBe(0);
  });

  it("computes overallAccuracyPct from totals across all lines, not per-line average", () => {
    const rows = [
      mkRow({ id: "mint", name: "Mint", sizes: [{ variantId: "v1oz", label: "1 oz", grams: 28, bags: 0 }] }),
      mkRow({ id: "chai", name: "Chai", sizes: [{ variantId: "v2oz", label: "1 oz", grams: 28, bags: 0 }] }),
    ];
    const snap = mkSnapshot({
      lines: [
        { id: "mint", name: "Mint", predictedBags: 8 },  // actual (week1) = 8 -> 100%
        { id: "chai", name: "Chai", predictedBags: 1 },  // actual (week1) = 3 -> low %
      ],
    });
    const out = computeForecastAccuracy(snap, sales, rows);
    // totals: predicted 9, actual 11 -> 100 - |11-9|/9*100 ≈ 77.8%
    expect(out.totalPredicted).toBe(9);
    expect(out.totalActual).toBe(11);
    expect(out.overallAccuracyPct).toBeCloseTo(77.8, 1);
  });
});

describe("cycleCountAccuracy", () => {
  it("returns 100 for an empty list", () => {
    expect(cycleCountAccuracy([])).toBe(100);
  });

  it("returns 100 when every counted line matches Shopify exactly", () => {
    expect(cycleCountAccuracy([{ shopifyBags: 10, countedBags: 10 }, { shopifyBags: 0, countedBags: 0 }])).toBe(100);
  });

  it("returns the percentage of exact-match lines when some differ", () => {
    expect(cycleCountAccuracy([
      { shopifyBags: 10, countedBags: 10 },
      { shopifyBags: 5, countedBags: 4 },
      { shopifyBags: 2, countedBags: 2 },
      { shopifyBags: 1, countedBags: 0 },
    ])).toBe(50);
  });
});

describe("computeHealth", () => {
  it("scores 100 when every tea is OK", () => {
    const lines = computeReorder([mkRow({ raw: 100000, vel: 10 })], 50).lines;
    const health = computeHealth(lines);
    expect(health.score).toBe(100);
    expect(health.ok).toBe(1);
    expect(health.toOrder).toHaveLength(0);
  });

  it("scores 0 and lists a buy quantity when every tea is at REORDER", () => {
    const lines = computeReorder([mkRow({ raw: 0, vel: 10, lead: 21, sizes: [
      { variantId: "v1oz", label: "1 oz", grams: 28, bags: 0 },
    ] })], 50).lines;
    const health = computeHealth(lines);
    expect(health.score).toBe(0);
    expect(health.re).toBe(1);
    expect(health.toOrder).toHaveLength(1);
    expect(health.toOrder[0].buyG).toBeGreaterThan(0);
  });

  it("weighs LOW teas as half an OK tea in the score", () => {
    // One OK tea, one LOW tea -> score = 100 * (1 + 0.5) / 2 = 75.
    const okLine = computeReorder([mkRow({ raw: 100000, vel: 10 })], 50).lines[0];
    const lowLine = computeReorder([mkRow({ raw: 2000, vel: 10, lead: 21, sizes: [
      { variantId: "v1oz", label: "1 oz", grams: 28, bags: 0 },
    ] })], 50).lines[0];
    const health = computeHealth([okLine, lowLine]);
    expect(lowLine.verdict).toBe("LOW");
    expect(health.score).toBe(75);
  });

  it("sorts teas to order by buy quantity, largest first", () => {
    const big = computeReorder([mkRow({ id: "a", name: "Big Buy", raw: 0, vel: 20, lead: 30, sizes: [
      { variantId: "va", label: "1 oz", grams: 28, bags: 0 },
    ] })], 50).lines[0];
    const small = computeReorder([mkRow({ id: "b", name: "Small Buy", raw: 0, vel: 2, lead: 21, sizes: [
      { variantId: "vb", label: "1 oz", grams: 28, bags: 0 },
    ] })], 50).lines[0];
    const health = computeHealth([small, big]);
    expect(health.toOrder.map(o => o.name)).toEqual(["Big Buy", "Small Buy"]);
  });
});
