// Pure forecast/reorder math, extracted from components/InventoryApp.tsx so
// it can be unit tested without rendering the component. Behaviour must stay
// identical to the inline useMemo logic that used to live there.

export const OZ = 28.3495;
export const LB = 453.592;
export const gToLb = (g: number) => g / LB;

// Reorder point = weekly use (vel × g/bag) × lead-time weeks × this safety margin
export const REORDER_BUFFER = 1.15;

export type LocationKey = "warehouse" | "mall";

export type SizeStock = {
  variantId: string;
  label: string;
  grams: number;
  bags: number;
  byLocation?: { warehouse: number; mall: number };
};

export type Row = {
  id: string;
  name: string;
  raw: number;   // grams of bulk material on hand
  lead: number;  // resupply lead time, days
  vel: number;   // sales velocity, bags/week
  sizes: SizeStock[];
};

export type EventCfg = { name: string; date: string; type: string; attendees: number; conv: number; bags: number; buffer: number };
export type MallCfg = { traffic: number; conv: number; bags: number; weeks: number; buffer: number };
export type RestockCfg = { weeks: number; growth: number; safety: number };

// A saved Event-mode forecast, captured so it can be scored against real
// sales once the event date falls inside the rolling sales window.
export type ForecastSnapshotLine = { id: string; name: string; predictedBags: number };
export type ForecastSnapshot = { id: string; savedAt: string; ev: EventCfg; lines: ForecastSnapshotLine[] };

export type ForecastAccuracyLine = { id: string; name: string; predictedBags: number; actualUnits: number | null; accuracyPct: number | null };
export type ForecastAccuracyResult = {
  status: "pending" | "scored" | "expired";
  weekIdx: number | null;
  lines: ForecastAccuracyLine[];
  totalPredicted: number;
  totalActual: number | null;
  overallAccuracyPct: number | null;
};

// grams of finished tea on hand for a row (bags × size grams)
export const finG = (r: Row) => r.sizes.reduce((s, z) => s + z.bags * z.grams, 0);
export const finBags = (r: Row) => r.sizes.reduce((s, z) => s + z.bags, 0);

// Bag count for a size under a given location view. Before the first sync,
// byLocation is unset — assume everything sits in the warehouse.
export const sizeBags = (z: SizeStock, view: "total" | LocationKey) =>
  view === "total" ? z.bags : (z.byLocation?.[view] ?? (view === "warehouse" ? z.bags : 0));

// Finished bags/grams on hand for a row, scoped to a single location.
export const locBags = (r: Row, loc: LocationKey) => r.sizes.reduce((s, z) => s + sizeBags(z, loc), 0);
export const locG = (r: Row, loc: LocationKey) => r.sizes.reduce((s, z) => s + sizeBags(z, loc) * z.grams, 0);

export const avgBagG = (mix: { s1: number; s2: number; s4: number; s8: number }) =>
  Math.round(mix.s1 * Math.round(1 * OZ) + mix.s2 * Math.round(2 * OZ) + mix.s4 * Math.round(4 * OZ) + mix.s8 * Math.round(8 * OZ));

// Which event/mall size-mix bucket a size belongs to — "3.5 oz" (matcha-style
// teas) counts as the "4 oz" bucket since it's the next size up from 2oz.
export const sizeBucket = (label: string): "s1" | "s2" | "s4" | "s8" =>
  label === "1 oz" ? "s1" : label === "2 oz" ? "s2" : label === "8 oz" ? "s8" : "s4";

// Event/Mall forecast: split projected demand across teas (by velocity share
// × season) and sizes (by posMix), then figure out what's left to buy.
export function computeForecast(rows: Row[], opts: {
  mode: string;
  ev: EventCfg;
  mall: MallCfg;
  season: Record<string, number>;
  posMix: { s1: number; s2: number; s4: number };
  gPerBag: number;
  velSum: number;
}) {
  const { mode, ev, mall, season, posMix, gPerBag, velSum } = opts;
  const buf = 1 + ((mode === "event" ? ev.buffer : mall.buffer) || 0) / 100;
  const totalBags = mode === "event"
    ? Math.round(ev.attendees * (ev.conv / 100) * ev.bags)
    : Math.round(mall.traffic * (mall.conv / 100) * mall.bags * mall.weeks);
  // Event/mall demand is split into per-size bag counts using posMix
  // (1oz/2oz/4oz weights, 8oz excluded), normalized over each tea's sizes.
  const lines = rows.map(r => {
    const fin = finG(r);
    const mul = season[r.id] ?? 1;
    const shareBags = totalBags * (r.vel / velSum) * mul;
    const weights = r.sizes.map(z => (posMix as Record<string, number>)[sizeBucket(z.label)] ?? 0);
    const wSum = weights.reduce((a, b) => a + b, 0) || 1;
    const sizes = r.sizes.map((z, i) => ({ ...z, fcBags: Math.round(shareBags * weights[i] / wSum) }));
    const fcBags = sizes.reduce((a, z) => a + z.fcBags, 0);
    const gramsNeeded = sizes.reduce((a, z) => a + z.fcBags * z.grams, 0) * buf;
    const afterFinished = Math.max(0, gramsNeeded - fin);
    const buyG = Math.max(0, afterFinished - r.raw);
    const cover = afterFinished <= 0 ? 2 : r.raw / afterFinished;
    const verdict = afterFinished <= 0 || cover >= 1 ? "OK" : cover >= 1 / buf ? "LOW" : "BUY";
    const runway = mode === "mall" && fcBags > 0 ? (r.raw + fin) / (fcBags * gPerBag / mall.weeks) : null;
    return { ...r, fin, sizes, shareBags: fcBags, gramsNeeded: Math.round(gramsNeeded), buyG: Math.round(buyG), verdict, runway };
  });
  const totalBuy = lines.reduce((a, l) => a + l.buyG, 0);
  const flagged = lines.filter(l => l.verdict !== "OK").length;
  return { totalBags, lines, totalBuy, flagged };
}

// Restock plan: baseline replenishment from REAL per-variant sell-through.
// Per size: build to `weeks` of finished cover (× season × growth), net of
// what's already bagged. Raw to order = grams to produce those bags + a
// lead-time safety stock of raw, net of raw on hand. Output in lbs.
export function computeRestockPlan(rows: Row[], opts: {
  byVariant: Record<string, number>;
  weeksInWindow: number;
  season: Record<string, number>;
  restock: RestockCfg;
}) {
  const { byVariant, weeksInWindow, season, restock } = opts;
  const g = 1 + (restock.growth || 0) / 100;
  const lines = rows.map(r => {
    const mul = season[r.id] ?? 1;
    const f = mul * g;
    // Per-size weekly units sold (real), and the resulting prepare target.
    const sizes = r.sizes.map(z => {
      const wkUnits = (byVariant[z.variantId] ?? 0) / weeksInWindow;
      const target = wkUnits * restock.weeks * f;            // bags we want on hand
      const prepare = Math.max(0, Math.ceil(target - z.bags)); // net of finished on hand
      return { ...z, wkUnits, prepare };
    });
    const wkBags = sizes.reduce((a, z) => a + z.wkUnits, 0);
    const wkGrams = sizes.reduce((a, z) => a + z.wkUnits * z.grams, 0) * f;
    const produceG = sizes.reduce((a, z) => a + z.prepare * z.grams, 0);
    const safetyG = wkGrams * (r.lead / 7) * (restock.safety || 1); // raw buffer for next cycle
    const orderRawG = Math.max(0, produceG + safetyG - r.raw);
    const prepareBags = sizes.reduce((a, z) => a + z.prepare, 0);
    return { ...r, sizes, wkBags, wkGrams, produceG, safetyG, orderRawG, prepareBags };
  });
  const totalOrderLb = gToLb(lines.reduce((a, l) => a + l.orderRawG, 0));
  const totalPrepareBags = lines.reduce((a, l) => a + l.prepareBags, 0);
  return { lines, totalOrderLb, totalPrepareBags };
}

// Per-tea reorder status from raw + finished vs. a lead-time-scaled reorder point.
export function computeReorder(rows: Row[], gPerBag: number) {
  const lines = rows.map(r => {
    const fin = finG(r);
    const weeklyG = r.vel * gPerBag;                  // grams sold per week (vel = bags/week)
    const reorderG = Math.round(weeklyG * (r.lead / 7) * REORDER_BUFFER);
    const available = r.raw + fin;                    // material on hand in any form
    const coverWk = weeklyG > 0 ? available / weeklyG : null;
    // Weigh raw + finished against the reorder point so a well-stocked tea
    // with low raw but plenty of bagged product doesn't false-alarm.
    const verdict = weeklyG <= 0 || available >= reorderG * 1.3 ? "OK"
      : available >= reorderG ? "LOW" : "REORDER";
    return { ...r, fin, weeklyG: Math.round(weeklyG), reorderG, available, coverWk, verdict };
  });
  return { lines, flagged: lines.filter(l => l.verdict === "REORDER").length };
}

// How close `actual` came to `predicted`, as a 0-100% score (1 decimal).
const accuracyPct = (predicted: number, actual: number): number => {
  if (predicted === 0) return actual === 0 ? 100 : 0;
  return Math.round(Math.max(0, 100 - Math.abs(actual - predicted) / predicted * 100) * 10) / 10;
};

// Score a saved Event-mode forecast against real per-variant weekly sales,
// once the event date falls inside the rolling sales window. Uses the same
// week-bucketing as lib/shopify-sales.ts so the event date lines up with the
// week actual orders were aggregated into.
export function computeForecastAccuracy(
  snapshot: ForecastSnapshot,
  sales: { window: { since: string; until: string; days: number }; byVariantWeekly?: Record<string, number[]> } | null,
  rows: Row[]
): ForecastAccuracyResult {
  const totalPredicted = snapshot.lines.reduce((a, l) => a + l.predictedBags, 0);
  const pending = (): ForecastAccuracyResult => ({
    status: "pending", weekIdx: null,
    lines: snapshot.lines.map(l => ({ id: l.id, name: l.name, predictedBags: l.predictedBags, actualUnits: null, accuracyPct: null })),
    totalPredicted, totalActual: null, overallAccuracyPct: null,
  });
  if (!sales?.byVariantWeekly) return pending();

  const sinceMs = new Date(sales.window.since).getTime();
  const untilMs = new Date(sales.window.until).getTime();
  const eventMs = snapshot.ev.date ? new Date(snapshot.ev.date).getTime() : NaN;
  if (Number.isNaN(eventMs) || eventMs < sinceMs || eventMs > untilMs) {
    return {
      status: "expired", weekIdx: null,
      lines: snapshot.lines.map(l => ({ id: l.id, name: l.name, predictedBags: l.predictedBags, actualUnits: null, accuracyPct: null })),
      totalPredicted, totalActual: null, overallAccuracyPct: null,
    };
  }

  const numWeeks = Math.ceil(sales.window.days / 7);
  const weekIdx = Math.min(numWeeks - 1, Math.max(0, Math.floor((eventMs - sinceMs) / (7 * 86400_000))));
  const byVariantWeekly = sales.byVariantWeekly;
  const lines = snapshot.lines.map(snapLine => {
    const row = rows.find(r => r.id === snapLine.id);
    const actualUnits = (row?.sizes ?? []).reduce((a, z) => a + (byVariantWeekly[z.variantId]?.[weekIdx] ?? 0), 0);
    return { id: snapLine.id, name: snapLine.name, predictedBags: snapLine.predictedBags, actualUnits, accuracyPct: accuracyPct(snapLine.predictedBags, actualUnits) };
  });
  const totalActual = lines.reduce((a, l) => a + (l.actualUnits ?? 0), 0);
  return { status: "scored", weekIdx, lines, totalPredicted, totalActual, overallAccuracyPct: accuracyPct(totalPredicted, totalActual) };
}

// % of counted lines that match Shopify's recorded bags exactly.
export function cycleCountAccuracy(lines: { shopifyBags: number; countedBags: number }[]): number {
  if (lines.length === 0) return 100;
  const matches = lines.filter(l => l.countedBags === l.shopifyBags).length;
  return Math.round((matches / lines.length) * 1000) / 10;
}

// Warehouse health rolls the reorder lines into a single status snapshot.
export function computeHealth(reorderLines: ReturnType<typeof computeReorder>["lines"]) {
  const ls = reorderLines;
  const ok = ls.filter(l => l.verdict === "OK").length;
  const low = ls.filter(l => l.verdict === "LOW").length;
  const re = ls.filter(l => l.verdict === "REORDER").length;
  const covers = ls.map(l => l.coverWk).filter((x): x is number => x != null);
  const avgCover = covers.length ? covers.reduce((a, b) => a + b, 0) / covers.length : null;
  const score = Math.round((100 * (ok + 0.5 * low)) / (ls.length || 1));
  // Raw to buy to restock a flagged tea to a comfortable level (reorder pt + 30%).
  const toOrder = ls
    .filter(l => l.verdict !== "OK")
    .map(l => ({ id: l.id, name: l.name, lead: l.lead, verdict: l.verdict, buyG: Math.max(0, Math.round(l.reorderG * 1.3 - l.available)) }))
    .filter(x => x.buyG > 0)
    .sort((a, b) => b.buyG - a.buyG);
  return { ok, low, re, avgCover, score, toOrder };
}
