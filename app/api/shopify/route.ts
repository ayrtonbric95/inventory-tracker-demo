import { NextResponse } from "next/server";
import { demoStock } from "@/lib/demo-data";

// DEMO build: instead of talking to Shopify, serve deterministic synthetic
// finished-goods stock (per tea, per size, split by location). See lib/demo-data.ts.
export async function GET() {
  return NextResponse.json(demoStock());
}

// Logging a production batch would push a delta to Shopify in the real app; in
// the demo we just acknowledge it. The UI already updates its own state
// optimistically, so the change is visible until the page is reloaded.
export async function POST(req: Request) {
  let body: { changes?: { variantId?: string; delta?: number }[]; location?: string } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  return NextResponse.json({
    ok: true,
    applied: body.changes ?? [],
    location: body.location ?? "warehouse",
    updatedAt: new Date().toISOString(),
  });
}
