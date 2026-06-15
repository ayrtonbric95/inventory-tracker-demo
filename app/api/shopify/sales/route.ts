import { NextResponse } from "next/server";
import { demoSales } from "@/lib/demo-data";

// DEMO build: serve a deterministic synthetic 90-day sales aggregate (per-variant
// totals + weekly counts for sparklines, plus product roll-ups). No Shopify, no
// cache. See lib/demo-data.ts.
//
// GET /api/shopify/sales?days=90
//   -> { window, totals, topSellers, slowMovers, byVariant, byVariantWeekly, fetchedAt }
export async function GET(req: Request) {
  const url = new URL(req.url);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 90));
  return NextResponse.json(demoSales(days));
}
