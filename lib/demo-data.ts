// Synthetic data for the public portfolio demo. This replaces the live Shopify
// + sales integration so the app runs with realistic-looking numbers and no
// backend, credentials, or real business data. Everything here is deterministic
// (seeded per variant), so the same figures render on every request and build.

import { SHOPIFY_VARIANT_MAP, SHOPIFY_LOCATIONS, type LocationKey } from "@/lib/shopify-map";

// Per-tea display name + baseline weekly velocity (bags/wk). Velocity drives the
// synthetic 90-day sales totals so "Sync velocity from sales" lands near these.
const DEMO_TEAS: Record<string, { name: string; vel: number }> = {
  earlgrey: { name: "Earl Grey Reserve", vel: 15 },
  breakfast: { name: "English Breakfast Bold", vel: 12 },
  oolong: { name: "Toasted Oolong", vel: 8 },
  sencha: { name: "Sencha Garden Green", vel: 13 },
  jasmine: { name: "Jasmine Pearl Green", vel: 9 },
  ceremonial: { name: "Ceremonial Matcha", vel: 9 },
  gingermatcha: { name: "Ginger Citrus Matcha", vel: 6 },
  peony: { name: "White Peony", vel: 6 },
  chamomile: { name: "Chamomile Honey", vel: 7 },
  gingerdigest: { name: "Ginger Digestive", vel: 10 },
};

const DAYS = 90;
const WEEKS = Math.ceil(DAYS / 7); // 13

// Deterministic PRNG (mulberry32) seeded from a string, so each variant gets its
// own stable stream of "random" numbers.
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Relative how-many-units-sell weight per size (smaller sizes move faster).
const SIZE_WEIGHT: Record<string, number> = { "1 oz": 0.5, "2 oz": 0.3, "4 oz": 0.12, "8 oz": 0.08, "3.5 oz": 0.2 };
// Retail price per size, for synthetic revenue.
const SIZE_PRICE: Record<string, number> = { "1 oz": 7, "2 oz": 12, "4 oz": 20, "8 oz": 34, "3.5 oz": 18 };

// Total finished bags on hand per variant — deterministic, size-scaled.
function variantBags(variantId: string, label: string): number {
  const r = rng("bags:" + variantId);
  const base = label === "1 oz" ? 14 : label === "2 oz" ? 10 : label === "4 oz" ? 8 : label === "8 oz" ? 5 : 6;
  return Math.max(0, Math.round(base * (0.5 + r())));
}

// Split a variant's bags across warehouse + mall. Most stock is at the warehouse;
// a deterministic minority of variants are mall-only or warehouse-only so the
// per-location views all show meaningful (and varied) numbers.
function splitLocation(variantId: string, total: number): { warehouse: number; mall: number } {
  const r = rng("loc:" + variantId);
  const roll = r();
  if (roll < 0.12) return { warehouse: 0, mall: total };        // mall-only
  if (roll < 0.30) return { warehouse: total, mall: 0 };        // warehouse-only
  const mall = Math.round(total * (0.2 + r() * 0.2));           // ~20-40% at the mall
  return { warehouse: total - mall, mall };
}

// Shape returned by GET /api/shopify (finished bag counts per tea, per size,
// split by location). Mirrors the real route's response.
export function demoStock() {
  const stock: Record<string, { variantId: string; label: string; grams: number; bags: number; byLocation: { warehouse: number; mall: number } }[]> = {};
  for (const [teaId, variants] of Object.entries(SHOPIFY_VARIANT_MAP)) {
    stock[teaId] = variants.map(v => {
      const bags = variantBags(v.variantId, v.label);
      const byLocation = splitLocation(v.variantId, bags);
      return { variantId: v.variantId, label: v.label, grams: v.grams, bags, byLocation };
    });
  }
  return { stock, fetchedAt: new Date().toISOString() };
}

// Total finished bags on hand per tea (used as slow-mover "on hand" inventory).
function inventoryByTea(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [teaId, variants] of Object.entries(SHOPIFY_VARIANT_MAP)) {
    out[teaId] = variants.reduce((s, v) => s + variantBags(v.variantId, v.label), 0);
  }
  return out;
}

// Spread a total across WEEKS weeks with a gentle trend + noise; integers that
// sum exactly to total (oldest week first).
function weeklySeries(seed: string, total: number): number[] {
  if (total <= 0) return new Array(WEEKS).fill(0);
  const r = rng("wk:" + seed);
  const trend = (r() - 0.5) * 0.6; // -0.3..0.3 overall drift
  const raw = Array.from({ length: WEEKS }, (_, i) => {
    const t = i / (WEEKS - 1);
    return Math.max(0.05, 1 + trend * (t - 0.5) * 2 + (r() - 0.5) * 0.5);
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  const counts = raw.map(x => Math.round((x / sum) * total));
  // Fix rounding drift on the last week.
  const diff = total - counts.reduce((a, b) => a + b, 0);
  counts[WEEKS - 1] = Math.max(0, counts[WEEKS - 1] + diff);
  return counts;
}

// Shape returned by GET /api/shopify/sales — a 90-day aggregate with per-variant
// totals, per-variant weekly counts (for sparklines), and product roll-ups.
export function demoSales(days: number = DAYS) {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);
  const inv = inventoryByTea();

  const byVariant: Record<string, number> = {};
  const byVariantWeekly: Record<string, number[]> = {};
  const products: { productId: string; title: string; units: number; revenue: number; teaId: string }[] = [];

  for (const [teaId, variants] of Object.entries(SHOPIFY_VARIANT_MAP)) {
    const meta = DEMO_TEAS[teaId];
    const weeklyVel = meta?.vel ?? 6;
    let teaUnits = 0, teaRevenue = 0;
    for (const v of variants) {
      const weight = SIZE_WEIGHT[v.label] ?? 0.15;
      // ~vel bags/wk for the tea, split across sizes by weight, over the window.
      const total = Math.max(0, Math.round(weeklyVel * (days / 7) * weight * (0.85 + rng("u:" + v.variantId)() * 0.3)));
      byVariant[v.variantId] = total;
      byVariantWeekly[v.variantId] = weeklySeries(v.variantId, total);
      teaUnits += total;
      teaRevenue += total * (SIZE_PRICE[v.label] ?? 12);
    }
    products.push({ productId: `gid://shopify/Product/${70000 + products.length}`, title: meta?.name ?? teaId, units: teaUnits, revenue: teaRevenue, teaId });
  }

  const orders = Math.round(products.reduce((a, p) => a + p.units, 0) / 1.6); // ~1.6 units/order
  const units = products.reduce((a, p) => a + p.units, 0);
  const revenue = products.reduce((a, p) => a + p.revenue, 0);

  const topSellers = [...products].sort((a, b) => b.units - a.units)
    .map(p => ({ productId: p.productId, title: p.title, units: p.units, revenue: p.revenue }));
  const slowMovers = [...products].sort((a, b) => a.units - b.units).slice(0, 6)
    .map(p => ({ productId: p.productId, title: p.title, units: p.units, revenue: p.revenue, inventory: inv[p.teaId] ?? 0 }));

  return {
    window: { since, until, days },
    totals: { orders, units, revenue },
    topSellers,
    slowMovers,
    byVariant,
    byVariantWeekly,
    fetchedAt: new Date().toISOString(),
  };
}

// Re-exported so route handlers can label things if needed.
export { SHOPIFY_LOCATIONS };
export type { LocationKey };
