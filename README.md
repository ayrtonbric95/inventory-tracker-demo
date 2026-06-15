# Inventory Control Tower — Demo

A demand-forecasting and inventory "control tower" for a multi-location specialty
tea retailer (**Demo Tea Co.**, a fictional brand). It turns raw on-hand material
and finished-goods bag counts into reorder alerts, event/seasonal demand forecasts,
and a one-click weekly status report.

> **This is a portfolio demo.** It runs entirely on **synthetic, deterministic data** —
> there is **no backend, no database, and no credentials**. Every figure (stock,
> per-location splits, 90-day sales, sparklines) is generated locally in
> [`lib/demo-data.ts`](lib/demo-data.ts). Nothing here reflects real business data.

## What it does

- **Reorder health** — combines raw material + finished bags against a lead-time-scaled
  reorder point to flag each tea as OK / LOW / REORDER, with a rolled-up health score.
- **Forecast modes** — *Event* (attendee-based demand), *Mall* (foot-traffic-based),
  and *Restock* (build to N weeks of cover from real sell-through). Forecast accuracy is
  scored against later sales.
- **Multi-location views** — finished stock is split across a Warehouse and a Mall Store.
  The Mall view shows location-specific bags, cover in days, and a bag-count restock
  threshold, plus a reconciliation table for counted-vs-tracked deltas.
- **"Shopify-style" sync** — *Sync finished from Shopify* pulls current bag counts;
  *Sync velocity from sales* replaces typed velocities with real 90-day sell-through
  (with per-tea sparklines). In this demo these are served by mock API routes.
- **Operational logs** — production batch logging, cycle counts (with accuracy %),
  and purchase-order tracking from "ordered" to "received".
- **Weekly report** — a Monday status (health + reorder actions + top sellers / slow
  movers) generated locally, no API or AI cost.

All forecast/reorder math lives in a pure, unit-tested module
([`lib/forecast.ts`](lib/forecast.ts) — see [`lib/forecast.test.ts`](lib/forecast.test.ts)).

## Tech

Next.js 16 (App Router) · React 19 · TypeScript · Vitest. No runtime services.

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). No environment variables required.

```bash
npm run lint    # eslint
npm test        # vitest (forecast math)
npm run build   # production build
```

## Deploy

Deploys as-is to any Next.js host. On **Vercel**: import the repo and deploy — there
are **no environment variables to set**.

## Notes

Edits in the demo (logging a batch, editing counts, saving a forecast) are kept only
in the browser tab and **reset on reload**, so the demo stays clean for the next visitor.
The synthetic data is deterministic, so the numbers are stable across reloads and builds.
