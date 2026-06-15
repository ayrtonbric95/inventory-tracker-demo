"use client";

import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import {
  gToLb, finG, finBags, sizeBags, locBags, locG, avgBagG, REORDER_BUFFER,
  computeForecast, computeRestockPlan, computeReorder, computeHealth,
  computeForecastAccuracy, cycleCountAccuracy,
} from "@/lib/forecast";
import type {
  LocationKey, SizeStock, Row, EventCfg, MallCfg, RestockCfg,
  ForecastSnapshot, ForecastSnapshotLine,
} from "@/lib/forecast";

/* ─── Demo Tea Co. · Inventory Control Tower ───
   Finished goods are tracked as per-size BAG counts (1/2/4/8oz) mirrored from
   Shopify (source of truth); grams are derived only to drive the forecast.
   Raw material is tracked in mass (grams). Forecasting is deterministic and
   fully local — seasonality is derived from the calendar month, no API.
   State persists server-side via /api/state (Vercel KV).
*/

// Relative-time label for "last synced" badges.
const timeAgo = (iso: string | null) => {
  if (!iso) return "never";
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
};

// YYYY-MM-DD date `days` from today — default PO ETA from a tea's lead time.
const addDays = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

// Days since an ISO/YYYY-MM-DD date string — for the cycle-count overdue check.
const daysSince = (dateStr: string | null) => dateStr ? Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400_000) : Infinity;

// Tiny weekly-units trend line, colour-coded by whether the second half of
// the window is trending up or down vs. the first half.
function Sparkline({ data }: { data: number[] }) {
  if (!data || data.length < 2) return null;
  const w = 60, h = 18, pad = 2;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const step = (w - pad * 2) / (data.length - 1);
  const points = data.map((v, i) => `${pad + i * step},${h - pad - ((v - min) / range) * (h - pad * 2)}`).join(" ");
  const mid = Math.floor(data.length / 2);
  const firstAvg = data.slice(0, mid).reduce((a, b) => a + b, 0) / Math.max(1, mid);
  const secondAvg = data.slice(mid).reduce((a, b) => a + b, 0) / Math.max(1, data.length - mid);
  const color = secondAvg > firstAvg * 1.1 ? "#1f6f68" : secondAvg < firstAvg * 0.9 ? "#a8331f" : "#6c6453";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

type BatchEntry = {
  id: string;
  date: string;
  teaId: string;
  teaName: string;
  sizeLabel: string;
  variantId: string;
  bags: number;
  rawUsed: number;
  location?: LocationKey;
};

// Where finished bags physically live. Forecast/reorder math always uses the
// combined total; the location view just changes what the breakdown shows.
const LOCATIONS: { key: LocationKey; label: string }[] = [
  { key: "warehouse", label: "Warehouse" },
  { key: "mall", label: "Mall Store" },
];

// Flavour family per tea + how each family's demand swings by season — powers
// the "Auto seasonality" button locally (no API needed).
const SEASON_CAT: Record<string, string> = {
  mint: "cool", mango: "cool", lagoon: "cool", paradise: "cool", keylime: "cool", darj: "cool",
  chai: "warm", cocoa: "warm", cider: "warm", blackforest: "warm", oolong: "warm", mate: "warm",
  rose: "floral", rosebud: "floral", lavender: "floral", radiant: "floral", tummy: "floral",
  matcha: "green", bluematcha: "green",
};
const SEASON_MULT: Record<string, Record<string, number>> = {
  cool:   { spring: 1.05, summer: 1.35, fall: 0.9,  winter: 0.8 },  // iced / fruity / mint
  warm:   { spring: 0.95, summer: 0.8,  fall: 1.2,  winter: 1.35 }, // spiced / dessert / chai
  floral: { spring: 1.3,  summer: 1.05, fall: 0.95, winter: 1.0 },  // florals / detox
  green:  { spring: 1.05, summer: 1.15, fall: 1.0,  winter: 1.0 },  // matcha / green
};

// Base tea type per tea, sourced from each product's Shopify tag ("Type - Origin")
// on 2026-06-13. Drives the colour-coded grouping in the inventory lists.
const TEA_TYPE: Record<string, string> = {
  darj: "Black", mango: "Black", blackforest: "Black",
  mint: "Green", paradise: "Green", keylime: "Green", lavender: "Green",
  oolong: "Oolong",
  radiant: "White", rose: "White",
  matcha: "Matcha", chai: "Matcha", bluematcha: "Matcha",
  tummy: "Herbal", lagoon: "Herbal", cider: "Herbal", mate: "Herbal", cocoa: "Herbal", rosebud: "Herbal",
};

// Display order + subtle row tint / left-accent colour per type.
const TYPE_META: Record<string, { order: number; bg: string; accent: string }> = {
  Black:  { order: 1, bg: "rgba(74,59,46,.08)",   accent: "#4a3b2e" },
  Oolong: { order: 2, bg: "rgba(191,107,44,.09)", accent: "#bf6b2c" },
  Green:  { order: 3, bg: "rgba(31,111,104,.09)", accent: "#1f6f68" },
  Matcha: { order: 4, bg: "rgba(90,150,40,.12)",  accent: "#5a9628" },
  White:  { order: 5, bg: "rgba(138,147,168,.11)", accent: "#8a93a8" },
  Herbal: { order: 6, bg: "rgba(111,138,58,.10)", accent: "#6f8a3a" },
};
const typeOf = (id: string) => TEA_TYPE[id] ?? "Herbal";
const typeMeta = (id: string) => TYPE_META[typeOf(id)] ?? TYPE_META.Herbal;

// Sort any list of rows (objects with an `id`) grouped by tea type, in TYPE_META
// order, so all Black sit together, all Green together, etc.
function groupByType<T extends { id: string }>(lines: T[]): { type: string; items: T[] }[] {
  const byType = new Map<string, T[]>();
  for (const l of lines) {
    const t = typeOf(l.id);
    (byType.get(t) ?? byType.set(t, []).get(t)!).push(l);
  }
  return [...byType.entries()]
    .sort((a, b) => (TYPE_META[a[0]]?.order ?? 99) - (TYPE_META[b[0]]?.order ?? 99))
    .map(([type, items]) => ({ type, items }));
}

// Finished bag counts seeded from the live Shopify pull on 2026-06-13;
// "Sync finished from Shopify" refreshes them. Raw/lead/vel are app-managed.
const SEED: Row[] = [
  { id: "mint", name: "Moroccan Mint", raw: 1800, lead: 21, vel: 13, sizes: [
    { variantId: "gid://shopify/ProductVariant/10001", label: "1 oz", grams: 28, bags: 11 },
    { variantId: "gid://shopify/ProductVariant/10002", label: "2 oz", grams: 57, bags: 12 },
    { variantId: "gid://shopify/ProductVariant/10003", label: "4 oz", grams: 113, bags: 13 },
    { variantId: "gid://shopify/ProductVariant/10004", label: "8 oz", grams: 227, bags: 7 },
  ] },
  { id: "darj", name: "Apricot Darjeeling", raw: 900, lead: 21, vel: 16, sizes: [
    { variantId: "gid://shopify/ProductVariant/10005", label: "1 oz", grams: 28, bags: 10 },
    { variantId: "gid://shopify/ProductVariant/10006", label: "2 oz", grams: 57, bags: 8 },
    { variantId: "gid://shopify/ProductVariant/10007", label: "4 oz", grams: 113, bags: 5 },
    { variantId: "gid://shopify/ProductVariant/10008", label: "8 oz", grams: 227, bags: 3 },
  ] },
  { id: "tummy", name: "Tranquil Tummy", raw: 1200, lead: 18, vel: 18, sizes: [
    { variantId: "gid://shopify/ProductVariant/10009", label: "1 oz", grams: 28, bags: 8 },
    { variantId: "gid://shopify/ProductVariant/10010", label: "2 oz", grams: 57, bags: 8 },
    { variantId: "gid://shopify/ProductVariant/10011", label: "4 oz", grams: 113, bags: 4 },
    { variantId: "gid://shopify/ProductVariant/10012", label: "8 oz", grams: 227, bags: 9 },
  ] },
  { id: "paradise", name: "Mornings In Paradise", raw: 1100, lead: 18, vel: 14, sizes: [
    { variantId: "gid://shopify/ProductVariant/10013", label: "1 oz", grams: 28, bags: 7 },
    { variantId: "gid://shopify/ProductVariant/10014", label: "2 oz", grams: 57, bags: 5 },
    { variantId: "gid://shopify/ProductVariant/10015", label: "4 oz", grams: 113, bags: 8 },
    { variantId: "gid://shopify/ProductVariant/10016", label: "8 oz", grams: 227, bags: 3 },
  ] },
  { id: "mango", name: "Thai Fiery Mango", raw: 2200, lead: 18, vel: 11, sizes: [
    { variantId: "gid://shopify/ProductVariant/10017", label: "1 oz", grams: 28, bags: 8 },
    { variantId: "gid://shopify/ProductVariant/10018", label: "2 oz", grams: 57, bags: 20 },
    { variantId: "gid://shopify/ProductVariant/10019", label: "4 oz", grams: 113, bags: 12 },
    { variantId: "gid://shopify/ProductVariant/10020", label: "8 oz", grams: 227, bags: 2 },
  ] },
  { id: "lagoon", name: "Tropical Blue Lagoon", raw: 1000, lead: 18, vel: 7, sizes: [
    { variantId: "gid://shopify/ProductVariant/10021", label: "1 oz", grams: 28, bags: 9 },
    { variantId: "gid://shopify/ProductVariant/10022", label: "2 oz", grams: 57, bags: 14 },
    { variantId: "gid://shopify/ProductVariant/10023", label: "4 oz", grams: 113, bags: 5 },
    { variantId: "gid://shopify/ProductVariant/10024", label: "8 oz", grams: 227, bags: 4 },
  ] },
  { id: "keylime", name: "Silky Key Lime Pie", raw: 700, lead: 18, vel: 8, sizes: [
    { variantId: "gid://shopify/ProductVariant/10025", label: "1 oz", grams: 28, bags: 10 },
    { variantId: "gid://shopify/ProductVariant/10026", label: "2 oz", grams: 57, bags: 6 },
    { variantId: "gid://shopify/ProductVariant/10027", label: "4 oz", grams: 113, bags: 12 },
    { variantId: "gid://shopify/ProductVariant/10028", label: "8 oz", grams: 227, bags: 3 },
  ] },
  { id: "blackforest", name: "Black Forest Bliss", raw: 800, lead: 21, vel: 8, sizes: [
    { variantId: "gid://shopify/ProductVariant/10029", label: "1 oz", grams: 28, bags: 9 },
    { variantId: "gid://shopify/ProductVariant/10030", label: "2 oz", grams: 57, bags: 6 },
    { variantId: "gid://shopify/ProductVariant/10031", label: "4 oz", grams: 113, bags: 9 },
    { variantId: "gid://shopify/ProductVariant/10032", label: "8 oz", grams: 227, bags: 8 },
  ] },
  { id: "oolong", name: "Maple Oolong", raw: 900, lead: 21, vel: 6, sizes: [
    { variantId: "gid://shopify/ProductVariant/10033", label: "1 oz", grams: 28, bags: 8 },
    { variantId: "gid://shopify/ProductVariant/10034", label: "2 oz", grams: 57, bags: 10 },
    { variantId: "gid://shopify/ProductVariant/10035", label: "4 oz", grams: 113, bags: 8 },
    { variantId: "gid://shopify/ProductVariant/10036", label: "8 oz", grams: 227, bags: 4 },
  ] },
  { id: "radiant", name: "Radiant Glow", raw: 1000, lead: 21, vel: 7, sizes: [
    { variantId: "gid://shopify/ProductVariant/10037", label: "1 oz", grams: 28, bags: 10 },
    { variantId: "gid://shopify/ProductVariant/10038", label: "2 oz", grams: 57, bags: 15 },
    { variantId: "gid://shopify/ProductVariant/10039", label: "4 oz", grams: 113, bags: 12 },
    { variantId: "gid://shopify/ProductVariant/10040", label: "8 oz", grams: 227, bags: 6 },
  ] },
  { id: "lavender", name: "Lavender Bouquet", raw: 1200, lead: 21, vel: 5, sizes: [
    { variantId: "gid://shopify/ProductVariant/10041", label: "1 oz", grams: 28, bags: 7 },
    { variantId: "gid://shopify/ProductVariant/10042", label: "2 oz", grams: 57, bags: 12 },
    { variantId: "gid://shopify/ProductVariant/10043", label: "4 oz", grams: 113, bags: 14 },
    { variantId: "gid://shopify/ProductVariant/10044", label: "8 oz", grams: 227, bags: 4 },
  ] },
  { id: "cider", name: "Cider House Blend", raw: 700, lead: 18, vel: 4, sizes: [
    { variantId: "gid://shopify/ProductVariant/10045", label: "1 oz", grams: 28, bags: 10 },
    { variantId: "gid://shopify/ProductVariant/10046", label: "2 oz", grams: 57, bags: 8 },
    { variantId: "gid://shopify/ProductVariant/10047", label: "4 oz", grams: 113, bags: 7 },
    { variantId: "gid://shopify/ProductVariant/10048", label: "8 oz", grams: 227, bags: 9 },
  ] },
  { id: "mate", name: "Roasted Mate", raw: 1500, lead: 14, vel: 5, sizes: [
    { variantId: "gid://shopify/ProductVariant/10049", label: "1 oz", grams: 28, bags: 8 },
    { variantId: "gid://shopify/ProductVariant/10050", label: "2 oz", grams: 57, bags: 10 },
    { variantId: "gid://shopify/ProductVariant/10051", label: "4 oz", grams: 113, bags: 6 },
    { variantId: "gid://shopify/ProductVariant/10052", label: "8 oz", grams: 227, bags: 0 },
  ] },
  { id: "cocoa", name: "Cocoa Berry Kiss", raw: 600, lead: 18, vel: 5, sizes: [
    { variantId: "gid://shopify/ProductVariant/10053", label: "1 oz", grams: 28, bags: 13 },
    { variantId: "gid://shopify/ProductVariant/10054", label: "2 oz", grams: 57, bags: 5 },
    { variantId: "gid://shopify/ProductVariant/10055", label: "4 oz", grams: 113, bags: 4 },
    { variantId: "gid://shopify/ProductVariant/10056", label: "8 oz", grams: 227, bags: 4 },
  ] },
  { id: "rose", name: "Serene Rose", raw: 500, lead: 25, vel: 5, sizes: [
    { variantId: "gid://shopify/ProductVariant/10057", label: "1 oz", grams: 28, bags: 6 },
    { variantId: "gid://shopify/ProductVariant/10058", label: "2 oz", grams: 57, bags: 9 },
    { variantId: "gid://shopify/ProductVariant/10059", label: "4 oz", grams: 113, bags: 8 },
    { variantId: "gid://shopify/ProductVariant/10060", label: "8 oz", grams: 227, bags: 0 },
  ] },
  { id: "rosebud", name: "Wild Rosebuds", raw: 300, lead: 25, vel: 4, sizes: [
    { variantId: "gid://shopify/ProductVariant/10061", label: "1 oz", grams: 28, bags: 3 },
    { variantId: "gid://shopify/ProductVariant/10062", label: "2 oz", grams: 57, bags: 4 },
    { variantId: "gid://shopify/ProductVariant/10063", label: "4 oz", grams: 113, bags: 2 },
    { variantId: "gid://shopify/ProductVariant/10064", label: "8 oz", grams: 227, bags: 0 },
  ] },
  { id: "matcha", name: "Luxe Matcha", raw: 450, lead: 30, vel: 7, sizes: [
    { variantId: "gid://shopify/ProductVariant/10065", label: "1 oz", grams: 28, bags: 22 },
    { variantId: "gid://shopify/ProductVariant/10066", label: "2 oz", grams: 57, bags: 5 },
    { variantId: "gid://shopify/ProductVariant/10067", label: "3.5 oz", grams: 99, bags: 3 },
  ] },
  { id: "chai", name: "Vanilla Chai-Cha", raw: 600, lead: 30, vel: 11, sizes: [
    { variantId: "gid://shopify/ProductVariant/10068", label: "1 oz", grams: 28, bags: 17 },
    { variantId: "gid://shopify/ProductVariant/10069", label: "2 oz", grams: 57, bags: 8 },
    { variantId: "gid://shopify/ProductVariant/10070", label: "3.5 oz", grams: 99, bags: 4 },
  ] },
  { id: "bluematcha", name: "Blue Velvet Matcha", raw: 400, lead: 30, vel: 4, sizes: [
    { variantId: "gid://shopify/ProductVariant/10071", label: "1 oz", grams: 28, bags: 24 },
    { variantId: "gid://shopify/ProductVariant/10072", label: "2 oz", grams: 57, bags: 4 },
    { variantId: "gid://shopify/ProductVariant/10073", label: "3.5 oz", grams: 99, bags: 1 },
  ] },
];

const css = `
  .pt-root{font-family:'IBM Plex Mono',ui-monospace,monospace;background:#ece4d2;color:#16263f;min-height:100vh;font-size:13px;background-image:repeating-linear-gradient(0deg,transparent 0 38px,rgba(22,38,63,.035) 38px 39px)}
  .pt-root h1,.pt-root h2,.pt-arch{font-family:'Archivo',sans-serif}
  .pt-wrap{max-width:1100px;margin:0 auto;padding:20px 16px 90px}
  .pt-mast{border:2px solid #16263f;background:#16263f;color:#ece4d2;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
  .pt-mast h1{margin:0;font-size:22px;font-weight:800;letter-spacing:-.01em}
  .pt-eyebrow{font-family:'Archivo';letter-spacing:.3em;text-transform:uppercase;font-size:10px;color:#a9bcd6;font-weight:600}
  .pt-tabs{display:flex;border:2px solid #16263f;border-top:none;background:#e2d8c2;flex-wrap:wrap}
  .pt-tab{font-family:'Archivo';font-weight:700;font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:11px 15px;cursor:pointer;border:none;background:transparent;color:#6c6453;border-right:1px solid #c3b79b}
  .pt-tab.on{background:#16263f;color:#ece4d2}
  .pt-sec{margin-top:22px}
  @keyframes pt-shimmer{0%{background-position:-200px 0}100%{background-position:200px 0}}
  .pt-skel{display:inline-block;border-radius:2px;background:linear-gradient(90deg,#c3b79b 25%,#d8cfb8 37%,#c3b79b 63%);background-size:400px 100%;animation:pt-shimmer 1.4s ease-in-out infinite}
  .pt-mast .pt-skel{background:linear-gradient(90deg,#33476b 25%,#46608c 37%,#33476b 63%);background-size:400px 100%}
  .pt-sechead{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #16263f;padding-bottom:5px;margin-bottom:8px;gap:10px;flex-wrap:wrap}
  .pt-sechead h2{font-size:14px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin:0}
  .pt-hint{font-size:11px;color:#6c6453}
  table.pt{width:100%;border-collapse:collapse}
  table.pt th{font-family:'Archivo';font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:#6c6453;font-weight:600;text-align:left;padding:8px 8px;border-bottom:1px solid #c3b79b}
  table.pt th.n,table.pt td.n{text-align:right;font-variant-numeric:tabular-nums}
  table.pt td{padding:6px 8px;border-bottom:1px solid #d8cdb4}
  table.pt tr:hover td{background:#e6dcc6}
  .pt-in{background:#f3ecdb;border:1px solid #c3b79b;color:#16263f;font-family:inherit;font-size:13px;padding:5px 7px;width:100%;border-radius:0}
  .pt-in:focus{outline:none;border-color:#1f6f68;background:#fff}
  .pt-in.n{text-align:right}
  .pt-btn{font-family:'Archivo';font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:11px;background:#16263f;color:#ece4d2;border:2px solid #16263f;padding:8px 14px;cursor:pointer}
  .pt-btn:hover{background:#0e1a2d}.pt-btn:disabled{opacity:.5;cursor:wait}
  .pt-btn.ghost{background:transparent;color:#16263f}.pt-btn.ghost:hover{background:#16263f;color:#ece4d2}
  .pt-btn.inv{background:transparent;color:#ece4d2;border-color:#a9bcd6}.pt-btn.inv:hover{background:#a9bcd6;color:#16263f}
  .pt-btn.sm{padding:4px 9px;font-size:10px}
  .pt-kpis{display:grid;grid-template-columns:repeat(4,1fr);border:2px solid #16263f;border-top:none;background:#e2d8c2}
  .pt-kpi{padding:12px 14px;border-right:1px solid #c3b79b}.pt-kpi:last-child{border-right:none}
  .pt-kpi .k{font-family:'Archivo';font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#6c6453;font-weight:600;margin-bottom:4px}
  .pt-kpi .v{font-size:21px;font-weight:600;line-height:1.1}.pt-kpi .v small{font-size:11px;color:#6c6453}
  .pt-stamp{display:inline-block;border:2px solid currentColor;padding:2px 7px;border-radius:3px;font-family:'Archivo';font-weight:800;letter-spacing:.07em;text-transform:uppercase;font-size:10px;transform:rotate(-4deg)}
  .s-ok{color:#1f6f68}.s-low{color:#bf6b2c}.s-buy{color:#a8331f}
  .pt-note{font-size:11px;color:#6c6453;margin-top:8px;line-height:1.55}
  .pt-buybox{background:#f0e7d2;border:1px dashed #a8331f;padding:11px 13px;margin-top:12px;font-size:12px}
  .pt-ai{background:#f3ecdb;border:1px solid #c3b79b;border-left:4px solid #1f6f68;padding:13px 15px;margin-top:12px;white-space:pre-wrap;font-size:12.5px;line-height:1.6}
  .pt-err{border-left-color:#a8331f;color:#a8331f}
  .pt-warn{border-left-color:#e0a35c;color:#7a4a12}
  .pt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:10px 0}
  .pt-field label{font-family:'Archivo';font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:#6c6453;font-weight:600;display:block;margin-bottom:3px}
  .pt-szrow{font-size:10.5px;color:#6c6453;font-variant-numeric:tabular-nums;white-space:nowrap;margin-top:2px}
  table.pt td{vertical-align:middle}
  table.pt th.c,table.pt td.c{text-align:center}
  .pt-in.mini{padding:4px 4px;text-align:center;font-size:12px;max-width:64px;margin:0 auto}
  .pt-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .pt-scroll.wide table.pt{min-width:740px}
  .pt-seg{display:inline-flex;border:1px solid #16263f}
  .pt-seg button{font-family:'Archivo';font-weight:700;font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:5px 10px;cursor:pointer;border:none;background:transparent;color:#16263f}
  .pt-seg button.on{background:#16263f;color:#ece4d2}
  .pt-seg button+button{border-left:1px solid #16263f}
  tr.pt-grp td{padding:7px 8px;border-bottom:1px solid #c3b79b;background:#e2d8c2}
  .pt-grp .lbl{font-family:'Archivo';font-weight:800;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase}
  .pt-grp .cnt{font-size:10px;color:#6c6453;font-weight:400;letter-spacing:.06em}
  td.pt-acc{border-left:3px solid var(--acc)}
  @media(max-width:680px){
    .pt-wrap{padding:14px 10px 80px}
    .pt-mast{padding:12px 14px}.pt-mast h1{font-size:19px}
    .pt-kpis{grid-template-columns:repeat(2,1fr)}
    .pt-kpi .v{font-size:18px}
    table.pt th,table.pt td{padding:6px 6px}
    .pt-tab{padding:10px 12px}
  }
`;

type SalesRow = { productId: string; title: string; units: number; revenue: number };
type SlowRow = SalesRow & { inventory: number };
type SalesData = {
  window: { since: string; until: string; days: number };
  totals: { orders: number; units: number; revenue: number };
  topSellers: SalesRow[];
  slowMovers: SlowRow[];
  byVariant?: Record<string, number>;
  byVariantWeekly?: Record<string, number[]>;
  fetchedAt?: string;
};
// A raw-tea purchase order placed with a supplier, tracked from "ordered" to
// "received" so the reorder list can show "on order" instead of nagging again.
type POEntry = {
  id: string;
  teaId: string;
  teaName: string;
  qtyG: number;
  orderedDate: string;
  etaDate: string;
  received: boolean;
  receivedDate?: string;
};
// A physical cycle count vs Shopify's recorded combined bag counts.
type CycleCountLine = { variantId: string; teaId: string; teaName: string; sizeLabel: string; shopifyBags: number; countedBags: number };
type CycleCountEntry = { id: string; date: string; lines: CycleCountLine[]; accuracyPct: number };

type SavedState = {
  rows?: Row[];
  ev?: EventCfg;
  mall?: MallCfg;
  season?: Record<string, number>;
  batches?: BatchEntry[];
  posMix?: { s1: number; s2: number; s4: number };
  restock?: RestockCfg;
  pos?: POEntry[];
  mallCounts?: Record<string, number>;
  forecastLog?: ForecastSnapshot[];
  cycleCountLog?: CycleCountEntry[];
};

export default function InventoryApp() {
  const [tab, setTab] = useState("dash");
  const [rows, setRows] = useState<Row[]>(SEED);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [report, setReport] = useState("");

  const [ev, setEv] = useState<EventCfg>({ name: "Spring Market", date: "", type: "farmers market", attendees: 250, conv: 12, bags: 1.4, buffer: 15 });
  const [mix] = useState({ s1: 0.35, s2: 0.4, s4: 0.2, s8: 0.05 });
  // Event/POS + mall size mix — at events and the mall counter, sales skew
  // heavily to 1oz/2oz with very few 4oz, and no 8oz. Percentages of bags.
  const [posMix, setPosMix] = useState({ s1: 45, s2: 45, s4: 10 });
  const [mall, setMall] = useState<MallCfg>({ traffic: 3000, conv: 1.5, bags: 1.2, weeks: 4, buffer: 15 });
  const [season, setSeason] = useState<Record<string, number>>({});
  const [mode, setMode] = useState("event");
  // Restock mode: build to `weeks` of finished cover, apply a manual growth/trend
  // %, and keep `safety` × lead-time of raw on hand for the next cycle.
  const [restock, setRestock] = useState<RestockCfg>({ weeks: 6, growth: 0, safety: 1.2 });
  const [batches, setBatches] = useState<BatchEntry[]>([]);
  const [pos, setPos] = useState<POEntry[]>([]);
  const [poEta, setPoEta] = useState<Record<string, string>>({});
  // Mall's own counted bags per variant, for spotting drift vs. Shopify's
  // mall-location tracking (the mall reconciles its own WMS/POS).
  const [mallCounts, setMallCounts] = useState<Record<string, number>>({});
  // Saved Event-mode forecasts, scored later against real sales.
  const [forecastLog, setForecastLog] = useState<ForecastSnapshot[]>([]);
  // Draft physical cycle-count entries (combined warehouse + mall), keyed by variantId.
  const [cycleCounts, setCycleCounts] = useState<Record<string, number>>({});
  const [cycleCountLog, setCycleCountLog] = useState<CycleCountEntry[]>([]);
  const [batchForm, setBatchForm] = useState<{ teaId: string; variantId: string; bags: number; rawUsed: number; location: LocationKey }>({ teaId: SEED[0].id, variantId: SEED[0].sizes[0].variantId, bags: 0, rawUsed: 0, location: "warehouse" });
  const [sales, setSales] = useState<SalesData | null>(null);
  const [locView, setLocView] = useState<"total" | LocationKey>("total");
  const [finSyncedAt, setFinSyncedAt] = useState<string | null>(null);
  const [salesSyncedAt, setSalesSyncedAt] = useState<string | null>(null);
  // Version of the saved state this client is editing from — sent with every
  // save so the server can tell if another open tab saved since we loaded.
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [conflict, setConflict] = useState<{ value: SavedState; updatedAt: number } | null>(null);

  const applySavedState = (s: SavedState) => {
    // Only adopt saved rows if they use the per-size model; otherwise keep SEED.
    if (Array.isArray(s.rows) && Array.isArray(s.rows[0]?.sizes)) setRows(s.rows);
    if (s.ev) setEv(s.ev);
    if (s.mall) setMall(s.mall);
    if (s.season) setSeason(s.season);
    if (s.batches) setBatches(s.batches);
    if (s.posMix) setPosMix(s.posMix);
    if (s.restock) setRestock(s.restock);
    if (s.pos) setPos(s.pos);
    if (s.mallCounts) setMallCounts(s.mallCounts);
    if (s.forecastLog) setForecastLog(s.forecastLog);
    if (s.cycleCountLog) setCycleCountLog(s.cycleCountLog);
  };

  useEffect(() => { (async () => {
    try {
      const r = await fetch("/api/state");
      const data = await r.json();
      if (data?.value) applySavedState(data.value);
      setBaseVersion(data?.updatedAt ?? null);
    } catch { /* fall back to seeded data */ } setLoaded(true);
  })(); }, []);

  useEffect(() => { if (!loaded || conflict) return; const t = setTimeout(async () => {
    try {
      const res = await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: { rows, ev, mall, season, batches, posMix, restock, pos, mallCounts, forecastLog, cycleCountLog }, baseUpdatedAt: baseVersion }),
      });
      const data = await res.json();
      if (res.status === 409 && data.conflict) {
        setConflict({ value: data.value, updatedAt: data.updatedAt });
      } else if (typeof data.updatedAt === "number") {
        setBaseVersion(data.updatedAt);
      }
    } catch { /* best-effort save */ }
  }, 600); return () => clearTimeout(t); }, [rows, ev, mall, season, batches, posMix, restock, pos, mallCounts, forecastLog, cycleCountLog, loaded, baseVersion, conflict]);

  // Conflict resolution: either adopt the other client's saved state, or
  // force-overwrite it with what's currently on screen.
  const resolveConflictReload = () => {
    if (!conflict) return;
    applySavedState(conflict.value);
    setBaseVersion(conflict.updatedAt);
    setConflict(null);
  };
  const resolveConflictOverwrite = async () => {
    if (!conflict) return;
    try {
      const res = await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: { rows, ev, mall, season, batches, posMix, restock, pos, mallCounts, forecastLog, cycleCountLog }, force: true }),
      });
      const data = await res.json();
      if (typeof data.updatedAt === "number") setBaseVersion(data.updatedAt);
    } catch { /* best-effort save */ }
    setConflict(null);
  };

  const upd = (id: string, f: "name" | "raw" | "lead" | "vel", v: string) =>
    setRows(rs => rs.map(r => r.id === id ? { ...r, [f]: f === "name" ? v : Number(v) || 0 } : r));
  const setMul = (id: string, v: string) => setSeason(s => ({ ...s, [id]: Number(v) || 0 }));

  const syncShopify = useCallback(async () => {
    setBusy("shopify"); setErr("");
    try {
      const res = await fetch("/api/shopify");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      // Replace finished bag counts (and per-location split) with Shopify's
      // (source of truth), matching by variant.
      setRows(rs => rs.map(r => {
        const fresh = data.stock?.[r.id] as SizeStock[] | undefined;
        if (!fresh) return r;
        const byId = new Map(fresh.map(z => [z.variantId, z]));
        return { ...r, sizes: r.sizes.map(z => byId.has(z.variantId) ? { ...z, ...byId.get(z.variantId)! } : z) };
      }));
      setFinSyncedAt(data.fetchedAt ?? new Date().toISOString());
    } catch (e) {
      setErr("Shopify sync isn't reachable right now (" + (e as Error).message + "). Finished counts are unchanged — update them by hand if needed.");
    }
    setBusy("");
  }, []);

  const selTea = rows.find(r => r.id === batchForm.teaId) ?? rows[0];
  const selSize = selTea?.sizes.find(z => z.variantId === batchForm.variantId) ?? selTea?.sizes[0];

  const placePO = (teaId: string, teaName: string, qtyG: number, etaDate: string) => {
    setPos(ps => [{
      id: (crypto.randomUUID?.() ?? String(Date.now())),
      teaId, teaName, qtyG,
      orderedDate: new Date().toISOString().slice(0, 10),
      etaDate, received: false,
    }, ...ps].slice(0, 30));
  };
  const receivePO = (id: string) =>
    setPos(ps => ps.map(p => p.id === id ? { ...p, received: true, receivedDate: new Date().toISOString().slice(0, 10) } : p));

  // Save a physical cycle count (combined warehouse + mall) vs. Shopify's
  // recorded bag counts as a dated log entry, then clear the draft entries.
  const saveCycleCount = () => {
    const lines: CycleCountLine[] = [];
    for (const r of rows) for (const z of r.sizes) {
      const counted = cycleCounts[z.variantId];
      if (counted === undefined) continue;
      lines.push({ variantId: z.variantId, teaId: r.id, teaName: r.name, sizeLabel: z.label, shopifyBags: z.bags, countedBags: counted });
    }
    if (lines.length === 0) return;
    setCycleCountLog(log => [{
      id: (crypto.randomUUID?.() ?? String(Date.now())),
      date: new Date().toISOString().slice(0, 10),
      lines, accuracyPct: cycleCountAccuracy(lines),
    }, ...log].slice(0, 12));
    setCycleCounts({});
  };

  const logBatch = async () => {
    const { teaId, variantId, bags, rawUsed, location } = batchForm;
    const tea = rows.find(r => r.id === teaId);
    const size = tea?.sizes.find(z => z.variantId === variantId);
    if (!tea || !size || (!bags && !rawUsed)) return;
    // Optimistic local update — the bags were physically produced regardless of sync.
    setRows(rs => rs.map(r => r.id === teaId
      ? { ...r, raw: Math.max(0, r.raw - rawUsed), sizes: r.sizes.map(z => z.variantId === variantId ? { ...z, bags: z.bags + bags } : z) }
      : r));
    setBatches(bs => [{
      id: (crypto.randomUUID?.() ?? String(Date.now())),
      date: new Date().toISOString().slice(0, 10),
      teaId, teaName: tea.name, sizeLabel: size.label, variantId, bags, rawUsed, location,
    }, ...bs].slice(0, 20));
    setBatchForm(f => ({ ...f, bags: 0, rawUsed: 0 }));
    // Push the produced bags to Shopify so it stays the source of truth.
    if (bags) {
      setBusy("batch"); setErr("");
      try {
        const res = await fetch("/api/shopify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changes: [{ variantId, delta: bags }], reason: "restock", location }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      } catch (e) {
        setErr(`Batch logged here, but Shopify wasn't updated (${(e as Error).message}). After it's reachable, re-enter the bags or hit “Sync finished from Shopify” to reconcile.`);
      }
      setBusy("");
    }
  };

  // Reverses the most recently logged batch: subtracts its bags back off the
  // variant, restores the raw it used, and pushes the inverse delta to
  // Shopify. Only the top entry can be undone, so the list stays consistent.
  const undoLastBatch = async () => {
    const b = batches[0];
    if (!b) return;
    if (!confirm(`Undo the ${b.date} batch — ${b.bags || 0} ${b.sizeLabel} bag(s) of ${b.teaName}${b.rawUsed ? ` (and restore ${b.rawUsed}g raw)` : ""}?`)) return;
    setRows(rs => rs.map(r => r.id === b.teaId
      ? { ...r, raw: r.raw + b.rawUsed, sizes: r.sizes.map(z => z.variantId === b.variantId ? { ...z, bags: Math.max(0, z.bags - b.bags) } : z) }
      : r));
    setBatches(bs => bs.slice(1));
    // Older entries logged before this feature existed have no variantId —
    // revert the local counts but skip the Shopify push for those.
    if (b.bags && b.variantId) {
      setBusy("batch"); setErr("");
      try {
        const res = await fetch("/api/shopify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changes: [{ variantId: b.variantId, delta: -b.bags }], reason: "restock", location: b.location ?? "warehouse" }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      } catch (e) {
        setErr(`Batch undone here, but Shopify wasn't updated (${(e as Error).message}). Hit “Sync finished from Shopify” to reconcile once it's reachable.`);
      }
      setBusy("");
    }
  };

  // Picking a tea/size resets the bag+raw fields; typing bags suggests raw used = bags × size grams.
  const pickTea = (teaId: string) => {
    const t = rows.find(r => r.id === teaId);
    setBatchForm(f => ({ ...f, teaId, variantId: t?.sizes[0].variantId ?? "", bags: 0, rawUsed: 0 }));
  };
  const pickSize = (variantId: string) => setBatchForm(f => ({ ...f, variantId, bags: 0, rawUsed: 0 }));
  const pickBags = (n: number) => setBatchForm(f => ({ ...f, bags: n, rawUsed: n * (selSize?.grams ?? 0) }));

  // Real average bag size across the whole catalog, from actual 90-day
  // sell-through (units × grams per variant). Falls back to the manual mix
  // estimate until sales are loaded.
  const realAvgBagG = useMemo(() => {
    if (!sales?.byVariant) return null;
    let units = 0, grams = 0;
    for (const r of rows) for (const z of r.sizes) {
      const u = sales.byVariant[z.variantId] ?? 0;
      units += u; grams += u * z.grams;
    }
    return units > 0 ? grams / units : null;
  }, [rows, sales]);
  const gPerBag = realAvgBagG ?? avgBagG(mix);
  const velSum = rows.reduce((a, r) => a + (r.vel || 0), 0) || 1;

  const forecast = useMemo(
    () => computeForecast(rows, { mode, ev, mall, season, posMix, gPerBag, velSum }),
    [rows, ev, mall, mode, season, gPerBag, velSum, posMix]
  );

  // Past Event-mode forecasts, scored against real sales once the event date
  // falls inside the rolling sales window.
  const forecastAccuracy = useMemo(
    () => forecastLog.map(snap => ({ snap, acc: computeForecastAccuracy(snap, sales, rows) })),
    [forecastLog, sales, rows]
  );

  const saveForecastSnapshot = () => {
    const lines: ForecastSnapshotLine[] = forecast.lines.map(l => ({ id: l.id, name: l.name, predictedBags: l.shareBags }));
    setForecastLog(fl => [{ id: (crypto.randomUUID?.() ?? String(Date.now())), savedAt: new Date().toISOString(), ev, lines }, ...fl].slice(0, 20));
  };

  // Restock plan: baseline replenishment from REAL per-variant sell-through.
  // Per size: build to `weeks` of finished cover (× season × growth), net of
  // what's already bagged. Raw to order = grams to produce those bags + a
  // lead-time safety stock of raw, net of raw on hand. Output in lbs.
  const weeksInWindow = sales?.window ? Math.max(1, sales.window.days / 7) : 13;
  const restockPlan = useMemo(
    () => computeRestockPlan(rows, { byVariant: sales?.byVariant ?? {}, weeksInWindow, season, restock }),
    [rows, sales, season, restock, weeksInWindow]
  );

  const reorder = useMemo(() => computeReorder(rows, gPerBag), [rows, gPerBag]);

  // Raw & Finished table rows for the selected location: Combined shows
  // everything; Warehouse/Mall hide teas with nothing on hand there (raw
  // counts toward "on hand" for Warehouse, since raw only lives there).
  const visibleReorderLines = useMemo(() => {
    if (locView === "total") return reorder.lines;
    return reorder.lines.filter(r => {
      const onHandHere = locBags(r, locView);
      return locView === "warehouse" ? (r.raw > 0 || onHandHere > 0) : onHandHere > 0;
    });
  }, [reorder.lines, locView]);

  // Mall reconciliation: only sizes actually stocked at the mall.
  const mallRows = useMemo(
    () => rows
      .map(r => ({ ...r, sizes: r.sizes.filter(z => sizeBags(z, "mall") > 0) }))
      .filter(r => r.sizes.length > 0),
    [rows]
  );

  // Warehouse health rolls the reorder lines into a single status snapshot.
  const health = useMemo(() => computeHealth(reorder.lines), [reorder]);

  const loadSales = useCallback(async (): Promise<SalesData | null> => {
    setBusy("sales"); setErr("");
    try {
      const res = await fetch("/api/shopify/sales?days=90");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSales(data);
      setSalesSyncedAt(data.fetchedAt ?? new Date().toISOString());
      setBusy("");
      return data;
    } catch (e) {
      setErr(`Shopify sales aren't reachable (${(e as Error).message}). If the read_orders scope isn't added yet, the warehouse-health section below still works.`);
      setBusy("");
      return null;
    }
  }, []);

  // Once the saved state has loaded, pull fresh finished counts + sales right
  // away so the app opens current instead of showing stale saved/seed data.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => { syncShopify(); loadSales(); }, 0);
    return () => clearTimeout(t);
  }, [loaded, syncShopify, loadSales]);

  // Badge the tab title with the REORDER count so it's visible even when this
  // tab isn't focused (no push notifications — just a glance at the tab bar).
  useEffect(() => {
    document.title = reorder.flagged > 0
      ? `(${reorder.flagged}) Demo Tea Co. · Control Tower`
      : "Demo Tea Co. · Control Tower";
  }, [reorder.flagged]);

  const refreshAll = useCallback(() => { syncShopify(); loadSales(); }, [syncShopify, loadSales]);

  // Real per-tea velocity (bags/wk, summed across sizes) from actual 90-day
  // sell-through — the same wkUnits math as the Restock plan, but per tea
  // rather than per size, so it can replace the manually-typed `vel`.
  const realVel = useMemo(() => {
    if (!sales?.byVariant) return null;
    const out: Record<string, number> = {};
    for (const r of rows) {
      const wk = r.sizes.reduce((a, z) => a + (sales.byVariant![z.variantId] ?? 0), 0) / weeksInWindow;
      out[r.id] = wk;
    }
    return out;
  }, [rows, sales, weeksInWindow]);

  // Per-tea weekly unit counts (oldest to newest), summed across sizes, for
  // the velocity sparkline — a quick visual of whether a tea is trending up/down.
  const salesSpark = useMemo(() => {
    if (!sales?.byVariantWeekly) return null;
    const out: Record<string, number[]> = {};
    for (const r of rows) {
      const weeks = r.sizes.reduce<number[]>((acc, z) => {
        const w = sales.byVariantWeekly![z.variantId];
        if (!w) return acc;
        if (acc.length === 0) acc = new Array(w.length).fill(0);
        for (let i = 0; i < w.length; i++) acc[i] += w[i];
        return acc;
      }, []);
      out[r.id] = weeks;
    }
    return out;
  }, [rows, sales]);

  // One-click sync: replace manually-typed velocities with real sell-through.
  // Loads sales first if they aren't already loaded.
  const syncVelocity = useCallback(async () => {
    const data = sales?.byVariant ? sales : await loadSales();
    if (!data?.byVariant) return;
    const weeks = Math.max(1, data.window.days / 7);
    setRows(rs => rs.map(r => {
      const wk = r.sizes.reduce((a, z) => a + (data.byVariant![z.variantId] ?? 0), 0) / weeks;
      return wk > 0 ? { ...r, vel: Math.round(wk * 10) / 10 } : r;
    }));
  }, [sales, loadSales]);

  // Deterministic seasonality from the calendar month + each tea's flavour family — no API.
  const localSeason = () => {
    const m = new Date().getMonth();
    const sea = m >= 2 && m <= 4 ? "spring" : m >= 5 && m <= 7 ? "summer" : m >= 8 && m <= 10 ? "fall" : "winter";
    const next: Record<string, number> = {};
    rows.forEach(r => { next[r.id] = SEASON_MULT[SEASON_CAT[r.id] ?? "green"]?.[sea] ?? 1; });
    setSeason(next);
  };

  // Built locally from on-hand numbers + loaded Shopify sales — no API, no cost.
  const buildReport = () => {
    const L: string[] = [];
    const rawKg = (totRaw / 1000).toFixed(1);
    const finKg = (totFinG / 1000).toFixed(1);
    L.push(`DEMO TEA CO. — WEEKLY STATUS · ${new Date().toDateString()}`, "");

    const headline = reorder.flagged > 0
      ? `${reorder.flagged} tea${reorder.flagged > 1 ? "s" : ""} need raw reordered · health ${health.score}/100.`
      : health.low > 0
        ? `Stock healthy (${health.score}/100); ${health.low} tea${health.low > 1 ? "s" : ""} getting low.`
        : `Stock healthy — ${health.score}/100, nothing urgent.`;
    L.push("HEADLINE", headline, "");

    L.push("WAREHOUSE HEALTH",
      `Raw ${rawKg} kg · finished ${totFinBags} bags (${finKg} kg). Average cover ${health.avgCover != null ? health.avgCover.toFixed(1) + " wk" : "—"}. OK ${health.ok} · Low ${health.low} · Reorder ${health.re}.`, "");

    L.push("REORDER ACTIONS");
    if (health.toOrder.length) {
      health.toOrder.forEach(o => L.push(`  • ${o.name} (${o.verdict}) — buy ~${o.buyG} g raw`));
      L.push(`  Total raw to buy: ~${health.toOrder.reduce((a, o) => a + o.buyG, 0)} g.`);
    } else L.push("  None — every tea covers its lead-time demand with margin.");
    L.push("");

    if (sales) {
      L.push(`TOP SELLERS · last ${sales.window.days}d (${sales.totals.orders} orders, $${sales.totals.revenue.toLocaleString()})`);
      sales.topSellers.slice(0, 5).forEach((s, i) => L.push(`  ${i + 1}. ${s.title} — ${s.units} units · $${s.revenue.toLocaleString()}`));
      L.push("");
      L.push("SLOW MOVERS & PUSH IDEAS");
      const top = sales.topSellers[0]?.title;
      const laggards = sales.slowMovers.filter(s => s.inventory > 0).slice(0, 4);
      if (laggards.length) {
        laggards.forEach(s => {
          const ideas = ["feature a 1 oz sampler"];
          if (top && top !== s.title) ideas.push(`bundle with ${top}`);
          ideas.push("spotlight in the next email/homepage");
          L.push(`  • ${s.title} — ${s.units} sold, ${s.inventory} on hand → ${ideas.join("; ")}.`);
        });
      } else L.push("  No stuck stock — everything with inventory is moving.");
    } else {
      L.push("SHOPIFY SALES", "  Load Shopify sales above to include top sellers and slow movers.");
    }

    setReport(L.join("\n"));
  };

  const totRaw = rows.reduce((a, r) => a + r.raw, 0);
  const totFinG = rows.reduce((a, r) => a + finG(r), 0);
  const totFinBags = rows.reduce((a, r) => a + finBags(r), 0);
  const Stamp = ({ v }: { v: string }) => <span className={"pt-stamp " + (v === "OK" ? "s-ok" : v === "LOW" ? "s-low" : "s-buy")}>{v}</span>;
  const TypeHeader = ({ type, count, span }: { type: string; count: number; span: number }) => (
    <tr className="pt-grp"><td colSpan={span} style={{ borderLeft: `3px solid ${TYPE_META[type]?.accent ?? "#6f8a3a"}` }}>
      <span className="lbl" style={{ color: TYPE_META[type]?.accent ?? "#6f8a3a" }}>{type} tea</span>{" "}
      <span className="cnt">· {count}</span>
    </td></tr>
  );

  // While the saved state is loading from KV, show a skeleton instead of
  // flashing the seeded numbers (which don't reflect this tea's real stock).
  if (!loaded) {
    return (
      <div className="pt-root">
        <style>{css}</style>
        <div className="pt-wrap">
          <div className="pt-mast">
            <div><div className="pt-eyebrow">Demo Tea Co. · Control Tower</div><h1>Inventory & Forecast</h1></div>
            <div className="pt-skel" style={{ width: 90, height: 28 }} />
          </div>
          <div className="pt-kpis">
            {[0, 1, 2, 3].map(i => (
              <div className="pt-kpi" key={i}>
                <div className="k">&nbsp;</div>
                <div className="pt-skel" style={{ width: "70%", height: 21 }} />
              </div>
            ))}
          </div>
          <div className="pt-tabs">
            {[["dash", "Forecast"], ["raw", "Raw & Finished"], ["report", "Weekly Report"]].map(([k, l]) => (
              <button key={k} className={"pt-tab" + (k === "dash" ? " on" : "")} disabled>{l}</button>
            ))}
          </div>
          <div className="pt-sec">
            {[0, 1, 2, 3, 4, 5].map(i => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 0", borderBottom: "1px solid #c3b79b" }}>
                <div className="pt-skel" style={{ width: 150, height: 14 }} />
                <div className="pt-skel" style={{ width: 60, height: 14 }} />
                <div className="pt-skel" style={{ width: 100, height: 14, marginLeft: "auto" }} />
                <div className="pt-skel" style={{ width: 70, height: 14 }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-root">
      <style>{css}</style>
      <div className="pt-wrap">
        <div className="pt-mast">
          <div><div className="pt-eyebrow">Demo Tea Co. · Control Tower</div><h1>Inventory & Forecast</h1></div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <button className="pt-btn sm inv" disabled={!!busy} onClick={refreshAll}>
              {busy === "shopify" || busy === "sales" ? "Refreshing…" : "Refresh"}
            </button>
            <div className="pt-hint" style={{ color: finSyncedAt && salesSyncedAt ? "#a9bcd6" : "#e0a35c", maxWidth: 260, textAlign: "right" }}>
              Stock synced {timeAgo(finSyncedAt)} · Sales {timeAgo(salesSyncedAt)}
            </div>
            <div className="pt-hint" style={{ color: daysSince(cycleCountLog[0]?.date ?? null) > 30 ? "#e0a35c" : "#a9bcd6", maxWidth: 260, textAlign: "right" }}>
              Cycle count: {cycleCountLog[0] ? `${daysSince(cycleCountLog[0].date)}d ago` : "never"}
            </div>
          </div>
        </div>

        <div className="pt-kpis">
          <div className="pt-kpi"><div className="k">Raw on hand</div><div className="v">{(totRaw / 1000).toFixed(1)}<small> kg</small></div></div>
          <div className="pt-kpi"><div className="k">Finished bags</div><div className="v">{totFinBags}<small> bags · {(totFinG / 1000).toFixed(1)} kg</small></div></div>
          <div className="pt-kpi"><div className="k">Reorder now</div><div className="v" style={{ color: reorder.flagged > 0 ? "#a8331f" : "#1f6f68" }}>{reorder.flagged}<small> / {rows.length} teas</small></div></div>
          <div className="pt-kpi"><div className="k">Health score</div><div className="v" style={{ color: health.score >= 80 ? "#1f6f68" : health.score >= 60 ? "#bf6b2c" : "#a8331f" }}>{health.score}<small> / 100</small></div></div>
        </div>

        <div className="pt-tabs">
          {[["dash", "Forecast"], ["raw", "Raw & Finished"], ["report", "Weekly Report"]].map(([k, l]) => (
            <button key={k} className={"pt-tab" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>

        {conflict && (
          <div className="pt-ai pt-warn">
            This inventory was saved from another tab/device {timeAgo(new Date(conflict.updatedAt).toISOString())}.
            Your changes haven&apos;t been saved yet, so nothing is lost on either side — pick one:
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="pt-btn sm" onClick={resolveConflictReload}>Reload their version (discard mine)</button>
              <button className="pt-btn sm ghost" onClick={resolveConflictOverwrite}>Keep mine (overwrite theirs)</button>
            </div>
          </div>
        )}

        {reorder.flagged > 0 && (
          <div className="pt-ai pt-err">
            <b>{reorder.flagged} tea{reorder.flagged > 1 ? "s" : ""} at REORDER</b> — raw + finished
            has dropped to the reorder point: {reorder.lines.filter(l => l.verdict === "REORDER").map(l => l.name).join(", ")}.
            <div style={{ marginTop: 8 }}>
              <button className="pt-btn sm" onClick={() => setTab("report")}>View reorder actions</button>
            </div>
          </div>
        )}

        {err && <div className="pt-ai pt-err">{err}</div>}

        {tab === "dash" && (
          <div className="pt-sec">
            <div className="pt-sechead"><h2>{mode === "event" ? "Event" : mode === "mall" ? "Mall store" : "Restock"} forecast</h2>
              <div style={{ display: "flex", gap: 6 }}>
                <button className={"pt-btn sm" + (mode === "restock" ? "" : " ghost")} onClick={() => setMode("restock")}>Restock</button>
                <button className={"pt-btn sm" + (mode === "event" ? "" : " ghost")} onClick={() => setMode("event")}>Event</button>
                <button className={"pt-btn sm" + (mode === "mall" ? "" : " ghost")} onClick={() => setMode("mall")}>Mall</button>
              </div>
            </div>

            {mode === "event" && (
              <div className="pt-grid">
                <div className="pt-field"><label>Event name</label><input className="pt-in" value={ev.name} onChange={e => setEv({ ...ev, name: e.target.value })} /></div>
                <div className="pt-field"><label>Date</label><input className="pt-in" type="date" value={ev.date} onChange={e => setEv({ ...ev, date: e.target.value })} /></div>
                <div className="pt-field"><label>Type</label><input className="pt-in" value={ev.type} onChange={e => setEv({ ...ev, type: e.target.value })} /></div>
                <div className="pt-field"><label>Attendees</label><input className="pt-in n" type="number" value={ev.attendees} onChange={e => setEv({ ...ev, attendees: +e.target.value })} /></div>
                <div className="pt-field"><label>Conversion %</label><input className="pt-in n" type="number" value={ev.conv} onChange={e => setEv({ ...ev, conv: +e.target.value })} /></div>
                <div className="pt-field"><label>Bags / buyer</label><input className="pt-in n" type="number" step="0.1" value={ev.bags} onChange={e => setEv({ ...ev, bags: +e.target.value })} /></div>
                <div className="pt-field"><label>Buffer %</label><input className="pt-in n" type="number" value={ev.buffer} onChange={e => setEv({ ...ev, buffer: +e.target.value })} /></div>
              </div>
            )}
            {mode === "mall" && (
              <div className="pt-grid">
                <div className="pt-field"><label>Foot traffic / wk</label><input className="pt-in n" type="number" value={mall.traffic} onChange={e => setMall({ ...mall, traffic: +e.target.value })} /></div>
                <div className="pt-field"><label>Capture %</label><input className="pt-in n" type="number" step="0.1" value={mall.conv} onChange={e => setMall({ ...mall, conv: +e.target.value })} /></div>
                <div className="pt-field"><label>Bags / buyer</label><input className="pt-in n" type="number" step="0.1" value={mall.bags} onChange={e => setMall({ ...mall, bags: +e.target.value })} /></div>
                <div className="pt-field"><label>Horizon (weeks)</label><input className="pt-in n" type="number" value={mall.weeks} onChange={e => setMall({ ...mall, weeks: +e.target.value })} /></div>
                <div className="pt-field"><label>Buffer %</label><input className="pt-in n" type="number" value={mall.buffer} onChange={e => setMall({ ...mall, buffer: +e.target.value })} /></div>
              </div>
            )}
            {mode === "restock" && (
              <div className="pt-grid">
                <div className="pt-field"><label>Build to cover (weeks)</label><input className="pt-in n" type="number" value={restock.weeks} onChange={e => setRestock({ ...restock, weeks: +e.target.value })} /></div>
                <div className="pt-field"><label>Growth / trend %</label><input className="pt-in n" type="number" value={restock.growth} onChange={e => setRestock({ ...restock, growth: +e.target.value })} /></div>
                <div className="pt-field"><label>Raw safety (× lead)</label><input className="pt-in n" type="number" step="0.1" value={restock.safety} onChange={e => setRestock({ ...restock, safety: +e.target.value })} /></div>
              </div>
            )}
            {(mode === "event" || mode === "mall") && (
              <div className="pt-grid">
                <div className="pt-field"><label>Size mix: 1oz %</label><input className="pt-in n" type="number" value={posMix.s1} onChange={e => setPosMix({ ...posMix, s1: +e.target.value })} /></div>
                <div className="pt-field"><label>Size mix: 2oz %</label><input className="pt-in n" type="number" value={posMix.s2} onChange={e => setPosMix({ ...posMix, s2: +e.target.value })} /></div>
                <div className="pt-field"><label>Size mix: 4oz %</label><input className="pt-in n" type="number" value={posMix.s4} onChange={e => setPosMix({ ...posMix, s4: +e.target.value })} /></div>
              </div>
            )}

            {mode === "restock" ? (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "4px 0 2px", flexWrap: "wrap" }}>
                  <span className="pt-hint">{sales?.byVariant
                    ? <>Sell-through: <b>last {sales.window.days} days</b> of real per-variant sales</>
                    : <>Load sales to compute size-level demand</>}</span>
                  <button className="pt-btn sm ghost" disabled={!!busy} onClick={loadSales}>{busy === "sales" ? "Loading…" : sales?.byVariant ? "Refresh sales" : "Load 90-day sales"}</button>
                  <button className="pt-btn sm ghost" onClick={localSeason}>Auto seasonality</button>
                  {Object.keys(season).length > 0 && <button className="pt-btn sm ghost" onClick={() => setSeason({})}>Clear season</button>}
                </div>

                {sales?.byVariant ? (
                  <>
                    <div className="pt-scroll wide">
                    <table className="pt" style={{ marginTop: 6 }}>
                      <thead><tr>
                        <th>Tea</th><th className="c">×Season</th><th className="n">Sales/wk</th>
                        <th>Prepare (bags)</th><th className="n">Order raw (lb)</th>
                      </tr></thead>
                      <tbody>{groupByType(restockPlan.lines).map(grp => (
                        <Fragment key={grp.type}>
                          <TypeHeader type={grp.type} count={grp.items.length} span={5} />
                          {grp.items.map(l => (
                            <tr key={l.id} style={{ background: typeMeta(l.id).bg }}>
                              <td className="pt-acc" style={{ fontWeight: 600, minWidth: 150, ["--acc" as string]: typeMeta(l.id).accent }}>{l.name}</td>
                              <td className="c" style={{ width: 72 }}><input className="pt-in mini" type="number" step="0.05" value={season[l.id] ?? 1} onChange={e => setMul(l.id, e.target.value)} /></td>
                              <td className="n">{l.wkBags.toFixed(1)}</td>
                              <td style={{ minWidth: 190 }}>
                                <div style={{ fontWeight: 600 }}>{l.prepareBags}<span style={{ fontSize: 10, color: "#6c6453", fontWeight: 400 }}> bags · {gToLb(l.produceG).toFixed(2)} lb</span></div>
                                <div className="pt-szrow">{l.sizes.map(z => `${z.label.replace(" ", "")} ${z.prepare}`).join("  ·  ")}</div>
                              </td>
                              <td className="n" style={{ fontWeight: 600, color: l.orderRawG > 0 ? "#a8331f" : "#1f6f68" }}>{l.orderRawG > 0 ? gToLb(l.orderRawG).toFixed(1) : "—"}</td>
                            </tr>
                          ))}
                        </Fragment>
                      ))}</tbody>
                    </table>
                    </div>
                    <div className="pt-buybox" style={{ borderColor: restockPlan.totalOrderLb > 0 ? "#a8331f" : "#1f6f68", color: restockPlan.totalOrderLb > 0 ? "#a8331f" : "#1f6f68" }}>
                      <b>Prepare {restockPlan.totalPrepareBags} bags</b> to hit {restock.weeks} weeks of cover{restock.growth ? ` (+${restock.growth}% trend)` : ""}; <b>order ~{restockPlan.totalOrderLb.toFixed(1)} lb raw</b> total (covers production + a {restock.safety}× lead-time buffer, net of raw on hand).
                    </div>
                    <div className="pt-note">Math per size: <i>prepare = sales/wk × {restock.weeks} wk × season × growth − finished on hand</i> (rounded up). Per tea: <i>order raw = bags to prepare (in grams) + {restock.safety} × lead-time of weekly use − raw on hand</i>, shown in lb. Sales/wk is real per-variant sell-through over the last {sales.window.days} days — including 1 oz, now correctly split per flavour. Set <b>Auto seasonality</b> (month-based) or override ×Season per tea.</div>
                  </>
                ) : (
                  <div className="pt-buybox" style={{ borderColor: "#1f6f68", color: "#16263f" }}>Click <b>Load 90-day sales</b> above to pull real per-variant sell-through, then the table will show how many of each size to prepare and how much raw to order in lbs.</div>
                )}
              </>
            ) : (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "4px 0 2px", flexWrap: "wrap" }}>
                  <span className="pt-hint">Expected demand: <b>{forecast.totalBags} bags</b> · avg {Math.round(gPerBag)} g/bag{realAvgBagG ? " (real sales)" : " (estimate — load sales for the real figure)"}</span>
                  <button className="pt-btn sm ghost" onClick={localSeason}>Auto seasonality</button>
                  {Object.keys(season).length > 0 && <button className="pt-btn sm ghost" onClick={() => setSeason({})}>Clear season</button>}
                </div>

                <div className="pt-scroll wide">
                <table className="pt" style={{ marginTop: 6 }}>
                  <thead><tr>
                    <th>Tea</th><th className="c">×Season</th><th>Forecast (bags)</th>
                    <th className="n">Raw (g)</th><th className="n">Finished (lb)</th><th className="n">Buy (lb)</th>
                    {mode === "mall" && <th className="n">Runway wk</th>}<th>Status</th>
                  </tr></thead>
                  <tbody>{groupByType(forecast.lines).map(grp => (
                    <Fragment key={grp.type}>
                      <TypeHeader type={grp.type} count={grp.items.length} span={mode === "mall" ? 8 : 7} />
                      {grp.items.map(l => (
                        <tr key={l.id} style={{ background: typeMeta(l.id).bg }}>
                          <td className="pt-acc" style={{ fontWeight: 600, minWidth: 150, ["--acc" as string]: typeMeta(l.id).accent }}>{l.name}</td>
                          <td className="c" style={{ width: 72 }}><input className="pt-in mini" type="number" step="0.05" value={season[l.id] ?? 1} onChange={e => setMul(l.id, e.target.value)} /></td>
                          <td style={{ minWidth: 190 }}>
                            <div style={{ fontWeight: 600 }}>{l.shareBags}<span style={{ fontSize: 10, color: "#6c6453", fontWeight: 400 }}> bags · {gToLb(l.gramsNeeded).toFixed(2)} lb</span></div>
                            <div className="pt-szrow">{l.sizes.map(z => `${z.label.replace(" ", "")} ${z.fcBags}`).join("  ·  ")}</div>
                          </td>
                          <td className="n">{l.raw}</td>
                          <td className="n">{gToLb(l.fin).toFixed(2)}</td>
                          <td className="n" style={{ color: l.buyG > 0 ? "#a8331f" : "#16263f" }}>{l.buyG > 0 ? gToLb(l.buyG).toFixed(2) : "—"}</td>
                          {mode === "mall" && <td className="n">{l.runway ? l.runway.toFixed(1) : "—"}</td>}
                          <td><Stamp v={l.verdict} /></td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}</tbody>
                </table>
                </div>
                {forecast.totalBuy > 0
                  ? <div className="pt-buybox"><b>Buy before {mode === "event" ? "the event" : "stocking the store"}: {gToLb(forecast.totalBuy).toFixed(2)} lb.</b> Lean target — only materials stamped BUY are short after counting what’s already bagged.</div>
                  : <div className="pt-buybox" style={{ borderColor: "#1f6f68", color: "#1f6f68" }}><b>Cleared.</b> On-hand raw plus finished covers this plan with buffer — no purchase needed.</div>}
                <div className="pt-note">Transparent math: <i>fc bags = demand × velocity share × season, split into 1/2/4oz by the size mix above · need = Σ(bags × size grams) × buffer · buy = need − finished − raw.</i> Velocity comes from your real order counts; set season per tea or click <b>Auto seasonality</b> (month-based, no API).</div>
              </>
            )}
          </div>
        )}

        {tab === "dash" && mode === "event" && (
          <div className="pt-sec">
            <div className="pt-sechead"><h2>Saved forecasts</h2>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className="pt-hint">Save this forecast to compare vs actual sales once {ev.date || "the event date"} is in the 90-day sales window</span>
                <button className="pt-btn sm" disabled={!ev.date} onClick={saveForecastSnapshot}>Save forecast</button>
                {forecastLog.length > 0 && <button className="pt-btn sm ghost" onClick={() => setForecastLog([])}>Clear saved</button>}
              </div>
            </div>
            {forecastLog.length === 0 ? (
              <div className="pt-note">No saved forecasts yet. Save one before an event, then check back once it&rsquo;s within the last 90 days of sales to see predicted vs actual.</div>
            ) : (
              <div className="pt-scroll">
              <table className="pt">
                <thead><tr><th>Saved</th><th>Event</th><th>Date</th><th>Tea</th><th className="n">Predicted (bags)</th><th className="n">Actual (units)</th><th className="n">Accuracy</th></tr></thead>
                <tbody>{forecastAccuracy.map(({ snap, acc }) => (
                  <Fragment key={snap.id}>
                    {acc.lines.map((l, i) => (
                      <tr key={l.id}>
                        {i === 0 && (
                          <>
                            <td rowSpan={acc.lines.length}>{timeAgo(snap.savedAt)}</td>
                            <td rowSpan={acc.lines.length}>{snap.ev.name}</td>
                            <td rowSpan={acc.lines.length}>{snap.ev.date || "—"}</td>
                          </>
                        )}
                        <td>{l.name}</td>
                        <td className="n">{l.predictedBags}</td>
                        <td className="n">{l.actualUnits ?? "—"}</td>
                        <td className="n">{l.accuracyPct != null ? `${l.accuracyPct}%` : acc.status === "pending" ? "pending" : "out of range"}</td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={7} className="pt-hint" style={{ borderBottom: "2px solid #c3b79b" }}>
                        Overall: {acc.overallAccuracyPct != null ? `${acc.overallAccuracyPct.toFixed(1)}%` : acc.status === "pending" ? "Pending — load sales" : "Out of range"}
                      </td>
                    </tr>
                  </Fragment>
                ))}</tbody>
              </table>
              </div>
            )}
          </div>
        )}

        {tab === "raw" && (
          <div className="pt-sec">
            <div className="pt-sechead"><h2>Raw & finished on hand</h2>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span className="pt-hint" style={{ color: reorder.flagged > 0 ? "#a8331f" : "#6c6453" }}>
                  {reorder.flagged > 0 ? `${reorder.flagged} below reorder point` : "all materials above reorder point"}
                </span>
                <button className="pt-btn sm ghost" disabled={!!busy} onClick={syncShopify}>{busy === "shopify" ? "Syncing…" : "Sync finished from Shopify"}</button>
                <button className="pt-btn sm ghost" disabled={!!busy} onClick={syncVelocity}>{busy === "sales" ? "Loading…" : "Sync velocity from sales"}</button>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <span className="pt-hint">Finished bags shown:</span>
              <div className="pt-seg">
                <button className={locView === "total" ? "on" : ""} onClick={() => setLocView("total")}>Combined</button>
                {LOCATIONS.map(l => (
                  <button key={l.key} className={locView === l.key ? "on" : ""} onClick={() => setLocView(l.key)}>{l.label}</button>
                ))}
              </div>
              <span className="pt-hint">(reorder math always uses the combined total)</span>
            </div>

            <div className="pt-grid">
              <div className="pt-field"><label>Log batch — tea</label>
                <select className="pt-in" value={batchForm.teaId} onChange={e => pickTea(e.target.value)}>
                  {rows.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
              <div className="pt-field"><label>Bag size</label>
                <select className="pt-in" value={batchForm.variantId} onChange={e => pickSize(e.target.value)}>
                  {selTea?.sizes.map(z => <option key={z.variantId} value={z.variantId}>{z.label} ({z.grams} g)</option>)}
                </select>
              </div>
              <div className="pt-field"><label>Bags produced</label><input className="pt-in n" type="number" value={batchForm.bags} onChange={e => pickBags(+e.target.value)} /></div>
              <div className="pt-field"><label>Raw used (g)</label><input className="pt-in n" type="number" value={batchForm.rawUsed} onChange={e => setBatchForm(f => ({ ...f, rawUsed: +e.target.value }))} /></div>
              <div className="pt-field"><label>Write to</label>
                <select className="pt-in" value={batchForm.location} onChange={e => setBatchForm(f => ({ ...f, location: e.target.value as LocationKey }))}>
                  {LOCATIONS.map(l => <option key={l.key} value={l.key}>{l.label}</option>)}
                </select>
              </div>
              <div className="pt-field">
                <label>&nbsp;</label>
                <button className="pt-btn" style={{ width: "100%" }} disabled={!!busy} onClick={logBatch}>{busy === "batch" ? "Logging…" : "Log batch"}</button>
              </div>
            </div>

            <div className="pt-scroll wide">
            <table className="pt">
              <thead><tr><th>Tea</th>{locView !== "mall" && <th className="n">Raw (g)</th>}<th>Finished (bags)</th><th className="c">Vel<br/>(bags/wk)</th><th className="c">Lead<br/>(days)</th><th className="n">{locView === "mall" ? "Cover (days)" : "Cover (wk)"}</th><th className="n">{locView === "mall" ? "Restock at (bags)" : <>Reorder<br/>at (lb)</>}</th><th>Status</th></tr></thead>
              <tbody>{groupByType(visibleReorderLines).map(grp => (
                <Fragment key={grp.type}>
                  <TypeHeader type={grp.type} count={grp.items.length} span={locView === "mall" ? 7 : 8} />
                  {grp.items.map(r => (
                    <tr key={r.id} style={{ background: typeMeta(r.id).bg }}>
                      <td className="pt-acc" style={{ fontWeight: 600, minWidth: 150, ["--acc" as string]: typeMeta(r.id).accent }}>{r.name}</td>
                      {locView !== "mall" && (
                        <td className="n" style={{ width: 90 }}>
                          <input className="pt-in n" type="number" value={r.raw} onChange={e => upd(r.id, "raw", e.target.value)} />
                        </td>
                      )}
                      <td style={{ minWidth: 175 }}>
                        <div style={{ fontWeight: 600 }}>{locView === "total" ? finBags(r) : locBags(r, locView)}<span style={{ fontSize: 10, color: "#6c6453", fontWeight: 400 }}> bags · {gToLb(locView === "total" ? r.fin : locG(r, locView)).toFixed(2)} lb</span></div>
                        <div className="pt-szrow">{r.sizes.map(z => `${z.label.replace(" ", "")} ${sizeBags(z, locView)}`).join("  ·  ")}</div>
                      </td>
                      <td className="c" style={{ width: 76 }}>
                        <input className="pt-in mini" type="number" value={r.vel} onChange={e => upd(r.id, "vel", e.target.value)} />
                        {realVel && <div className="pt-szrow" style={{ textAlign: "center" }}>real {realVel[r.id].toFixed(1)}</div>}
                        {salesSpark?.[r.id] && <div style={{ display: "flex", justifyContent: "center", marginTop: 2 }}><Sparkline data={salesSpark[r.id]} /></div>}
                      </td>
                      <td className="c" style={{ width: 70 }}><input className="pt-in mini" type="number" value={r.lead} onChange={e => upd(r.id, "lead", e.target.value)} /></td>
                      <td className="n" style={{ fontWeight: 600, color: r.verdict === "REORDER" ? "#a8331f" : r.verdict === "LOW" ? "#bf6b2c" : "#16263f" }}>
                        {locView === "mall"
                          ? (r.vel > 0 ? ((locBags(r, "mall") / r.vel) * 7).toFixed(1) : "—")
                          : (r.coverWk != null ? r.coverWk.toFixed(1) : "—")}
                      </td>
                      <td className="n">
                        {locView === "mall"
                          ? <>{Math.round(r.vel * (r.lead / 7) * REORDER_BUFFER)}<span style={{ fontSize: 10, color: "#6c6453" }}> bags</span></>
                          : <>{gToLb(r.reorderG).toFixed(1)}<span style={{ fontSize: 10, color: "#6c6453" }}> lb</span></>}
                      </td>
                      <td><Stamp v={r.verdict} /></td>
                    </tr>
                  ))}
                </Fragment>
              ))}
              {visibleReorderLines.length === 0 && (
                <tr><td colSpan={locView === "mall" ? 7 : 8} style={{ textAlign: "center", color: "#6c6453", padding: 16 }}>
                  Nothing on hand at {LOCATIONS.find(l => l.key === locView)?.label ?? locView}.
                </td></tr>
              )}
              </tbody>
            </table>
            </div>
            <div className="pt-note"><b>Finished bags mirror Shopify</b> (read-only here) — “Sync finished from Shopify” pulls live counts; logging a batch adds bags <b>and pushes them to Shopify</b>. Edit raw, velocity (bags/wk) and lead inline — or click <b>Sync velocity from sales</b> to replace velocity with real 90-day sell-through per tea (shown as “real X.X” under each Vel field once sales are loaded; still editable afterward for one-off adjustments). <b>Cover</b> = weeks the on-hand raw + finished covers sales. <b>Reorder at</b> is the trigger level — once raw + finished (combined) drops to around this much, status flips to LOW/REORDER. It&apos;s <i>not</i> the amount to buy; see the Report tab&apos;s Reorder Actions for how much raw to order.</div>

            {locView === "mall" && (
              <div className="pt-sec">
                <div className="pt-sechead"><h2>Mall reconciliation</h2>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <span className="pt-hint">Enter the mall&apos;s own counted bags to compare against Shopify&apos;s mall tracking</span>
                    {Object.keys(mallCounts).length > 0 && <button className="pt-btn sm ghost" onClick={() => setMallCounts({})}>Clear counts</button>}
                  </div>
                </div>
                <div className="pt-scroll">
                <table className="pt">
                  <thead><tr><th>Tea</th><th>Size</th><th className="n">Shopify (mall)</th><th className="n">Counted</th><th className="n">Δ</th></tr></thead>
                  <tbody>{groupByType(mallRows).map(grp => (
                    <Fragment key={grp.type}>
                      <TypeHeader type={grp.type} count={grp.items.length} span={5} />
                      {grp.items.map(r => r.sizes.map(z => {
                        const shopifyMall = sizeBags(z, "mall");
                        const counted = mallCounts[z.variantId];
                        const delta = counted !== undefined ? counted - shopifyMall : null;
                        return (
                          <tr key={z.variantId} style={{ background: typeMeta(r.id).bg }}>
                            <td className="pt-acc" style={{ fontWeight: 600, minWidth: 150, ["--acc" as string]: typeMeta(r.id).accent }}>{r.name}</td>
                            <td>{z.label}</td>
                            <td className="n">{shopifyMall}</td>
                            <td className="n" style={{ width: 90 }}>
                              <input className="pt-in n" type="number" placeholder="—" value={counted ?? ""}
                                onChange={e => setMallCounts(m => {
                                  if (e.target.value === "") {
                                    const rest = { ...m };
                                    delete rest[z.variantId];
                                    return rest;
                                  }
                                  return { ...m, [z.variantId]: +e.target.value };
                                })} />
                            </td>
                            <td className="n" style={{ fontWeight: 600, color: delta == null || delta === 0 ? "#6c6453" : "#a8331f" }}>{delta == null ? "—" : (delta > 0 ? `+${delta}` : delta)}</td>
                          </tr>
                        );
                      }))}
                    </Fragment>
                  ))}
                  {mallRows.length === 0 && (
                    <tr><td colSpan={5} style={{ textAlign: "center", color: "#6c6453", padding: 16 }}>
                      Nothing on hand at {LOCATIONS.find(l => l.key === "mall")?.label ?? "the mall"}.
                    </td></tr>
                  )}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            <div className="pt-sec">
              <div className="pt-sechead"><h2>Cycle count</h2>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="pt-hint">Physical count vs Shopify (combined warehouse + mall)</span>
                  {Object.keys(cycleCounts).length > 0 && <button className="pt-btn sm ghost" onClick={() => setCycleCounts({})}>Clear entries</button>}
                  <button className="pt-btn sm" disabled={Object.keys(cycleCounts).length === 0} onClick={saveCycleCount}>Save cycle count</button>
                </div>
              </div>
              <div className="pt-scroll">
              <table className="pt">
                <thead><tr><th>Tea</th><th>Size</th><th className="n">Shopify</th><th className="n">Counted</th><th className="n">Δ</th></tr></thead>
                <tbody>{groupByType(rows).map(grp => (
                  <Fragment key={grp.type}>
                    <TypeHeader type={grp.type} count={grp.items.length} span={5} />
                    {grp.items.map(r => r.sizes.map(z => {
                      const shopifyTotal = z.bags;
                      const counted = cycleCounts[z.variantId];
                      const delta = counted !== undefined ? counted - shopifyTotal : null;
                      return (
                        <tr key={z.variantId} style={{ background: typeMeta(r.id).bg }}>
                          <td className="pt-acc" style={{ fontWeight: 600, minWidth: 150, ["--acc" as string]: typeMeta(r.id).accent }}>{r.name}</td>
                          <td>{z.label}</td>
                          <td className="n">{shopifyTotal}</td>
                          <td className="n" style={{ width: 90 }}>
                            <input className="pt-in n" type="number" placeholder="—" value={counted ?? ""}
                              onChange={e => setCycleCounts(m => {
                                if (e.target.value === "") {
                                  const rest = { ...m };
                                  delete rest[z.variantId];
                                  return rest;
                                }
                                return { ...m, [z.variantId]: +e.target.value };
                              })} />
                          </td>
                          <td className="n" style={{ fontWeight: 600, color: delta == null || delta === 0 ? "#6c6453" : "#a8331f" }}>{delta == null ? "—" : (delta > 0 ? `+${delta}` : delta)}</td>
                        </tr>
                      );
                    }))}
                  </Fragment>
                ))}</tbody>
              </table>
              </div>
            </div>

            {cycleCountLog.length > 0 && (
              <div className="pt-sec">
                <div className="pt-sechead"><h2>Cycle count log</h2><span className="pt-hint">last {Math.min(cycleCountLog.length, 12)} counts</span></div>
                <div className="pt-scroll">
                <table className="pt">
                  <thead><tr><th>Date</th><th className="n">Items counted</th><th className="n">Accuracy</th><th>Details</th></tr></thead>
                  <tbody>{cycleCountLog.slice(0, 12).map(c => (
                    <tr key={c.id}>
                      <td>{c.date}</td>
                      <td className="n">{c.lines.length}</td>
                      <td className="n" style={{ fontWeight: 600, color: c.accuracyPct >= 95 ? "#1f6f68" : c.accuracyPct >= 85 ? "#bf6b2c" : "#a8331f" }}>{c.accuracyPct}%</td>
                      <td className="pt-hint">{c.lines.filter(l => l.countedBags !== l.shopifyBags).map(l => `${l.teaName} ${l.sizeLabel} (${l.countedBags - l.shopifyBags > 0 ? "+" : ""}${l.countedBags - l.shopifyBags})`).join(", ") || "all matched"}</td>
                    </tr>
                  ))}</tbody>
                </table>
                </div>
              </div>
            )}

            {batches.length > 0 && (
              <div className="pt-sec">
                <div className="pt-sechead"><h2>Recent batches</h2><span className="pt-hint">last {Math.min(batches.length, 8)} logged</span></div>
                <div className="pt-scroll">
                <table className="pt">
                  <thead><tr><th>Date</th><th>Tea</th><th>Size</th><th className="n">Bags produced</th><th className="n">Raw used (g)</th><th>To</th><th /></tr></thead>
                  <tbody>{batches.slice(0, 8).map((b, i) => (
                    <tr key={b.id}>
                      <td>{b.date}</td><td>{b.teaName}</td><td>{b.sizeLabel}</td>
                      <td className="n">{b.bags || "—"}</td>
                      <td className="n">{b.rawUsed || "—"}</td>
                      <td>{LOCATIONS.find(l => l.key === b.location)?.label ?? "Warehouse"}</td>
                      <td>{i === 0 && <button className="pt-btn sm ghost" disabled={!!busy} onClick={undoLastBatch}>Undo</button>}</td>
                    </tr>
                  ))}</tbody>
                </table>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "report" && (
          <div className="pt-sec">
            <div className="pt-sechead"><h2>Warehouse health</h2>
              <span className="pt-hint" style={{ color: health.re > 0 ? "#a8331f" : "#6c6453" }}>
                {health.re > 0 ? `${health.re} tea${health.re > 1 ? "s" : ""} to reorder now` : "stock healthy"}
              </span>
            </div>
            <div className="pt-kpis" style={{ borderTop: "2px solid #16263f" }}>
              <div className="pt-kpi"><div className="k">Health score</div><div className="v" style={{ color: health.score >= 80 ? "#1f6f68" : health.score >= 60 ? "#bf6b2c" : "#a8331f" }}>{health.score}<small> / 100</small></div></div>
              <div className="pt-kpi"><div className="k">Avg cover</div><div className="v">{health.avgCover != null ? health.avgCover.toFixed(1) : "—"}<small> wk</small></div></div>
              <div className="pt-kpi"><div className="k">Reorder / Low</div><div className="v">{health.re}<small> / {health.low}</small></div></div>
              <div className="pt-kpi"><div className="k">Raw · Finished</div><div className="v">{(totRaw / 1000).toFixed(1)}<small> kg · {totFinBags} bags</small></div></div>
            </div>

            {health.toOrder.length > 0 ? (
              <table className="pt" style={{ marginTop: 14 }}>
                <thead><tr><th>Buy raw for</th><th>Status</th><th className="n">Suggested raw (g)</th><th>Purchase order</th></tr></thead>
                <tbody>{health.toOrder.map(o => {
                  const openPO = pos.find(p => !p.received && p.teaId === o.id);
                  return (
                    <tr key={o.name}>
                      <td style={{ fontWeight: 600 }}>{o.name}</td><td><Stamp v={o.verdict} /></td><td className="n">{o.buyG}</td>
                      <td>
                        {openPO ? (
                          <span className="pt-hint" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            On order · ETA {openPO.etaDate}
                            <button className="pt-btn sm ghost" onClick={() => receivePO(openPO.id)}>Mark received</button>
                          </span>
                        ) : (
                          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <input className="pt-in" type="date" value={poEta[o.id] ?? ""} placeholder={`~${o.lead}d lead`} onChange={e => setPoEta(m => ({ ...m, [o.id]: e.target.value }))} style={{ width: 130 }} />
                            <button className="pt-btn sm" onClick={() => placePO(o.id, o.name, o.buyG, poEta[o.id] || addDays(o.lead))}>Mark ordered</button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            ) : <div className="pt-buybox" style={{ borderColor: "#1f6f68", color: "#1f6f68" }}><b>No raw to order.</b> Every tea covers its lead-time demand with safety margin.</div>}

            {pos.some(p => !p.received) && (
              <div style={{ marginTop: 18 }}>
                <div className="pt-sechead"><h2>Open purchase orders</h2><span className="pt-hint">{pos.filter(p => !p.received).length} pending</span></div>
                <table className="pt">
                  <thead><tr><th>Tea</th><th className="n">Ordered (lb)</th><th>Ordered</th><th>ETA</th><th /></tr></thead>
                  <tbody>{pos.filter(p => !p.received).map(p => (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600 }}>{p.teaName}</td>
                      <td className="n">{gToLb(p.qtyG).toFixed(1)}</td>
                      <td>{p.orderedDate}</td>
                      <td>{p.etaDate}</td>
                      <td><button className="pt-btn sm ghost" onClick={() => receivePO(p.id)}>Mark received</button></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}

            <div className="pt-sechead" style={{ marginTop: 26 }}><h2>Shopify sales</h2>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                {sales && <span className="pt-hint">{sales.window.days}d · {sales.totals.orders} orders · {sales.totals.units} units · ${sales.totals.revenue.toLocaleString()}</span>}
                <button className="pt-btn sm ghost" disabled={!!busy} onClick={loadSales}>{busy === "sales" ? "Loading…" : sales ? "Refresh sales" : "Load Shopify sales (90d)"}</button>
              </div>
            </div>
            {sales ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 18, marginTop: 6 }}>
                <div>
                  <div className="pt-hint" style={{ marginBottom: 4, fontWeight: 600 }}>Top sellers</div>
                  <table className="pt"><thead><tr><th>Product</th><th className="n">Units</th><th className="n">Revenue</th></tr></thead>
                    <tbody>{sales.topSellers.map(s => (
                      <tr key={s.productId}><td>{s.title}</td><td className="n">{s.units}</td><td className="n">${s.revenue.toLocaleString()}</td></tr>
                    ))}</tbody></table>
                </div>
                <div>
                  <div className="pt-hint" style={{ marginBottom: 4, fontWeight: 600 }}>Slow movers (stuck stock)</div>
                  <table className="pt"><thead><tr><th>Product</th><th className="n">Units</th><th className="n">On hand</th></tr></thead>
                    <tbody>{sales.slowMovers.map(s => (
                      <tr key={s.productId}><td>{s.title}</td><td className="n" style={{ color: s.units === 0 ? "#a8331f" : "#16263f" }}>{s.units}</td><td className="n">{s.inventory}</td></tr>
                    ))}</tbody></table>
                </div>
              </div>
            ) : <div className="pt-note">Load live Shopify sales to see top sellers and slow-moving stock across the whole catalog. Needs the <i>read_orders</i> scope on the app.</div>}

            <div className="pt-sechead" style={{ marginTop: 26 }}><h2>Summary</h2><span className="pt-hint">health + sales → actions</span></div>
            <button className="pt-btn" onClick={buildReport}>Build this week’s report</button>
            {report && <div className="pt-ai">{report}</div>}
            {!report && <div className="pt-note">Builds a Monday status from warehouse health, reorder actions, and {sales ? "the loaded Shopify sales" : "Shopify sales (load them above first for the commercial half)"} — generated locally, no API or extra cost.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
