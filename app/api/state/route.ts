import { NextResponse } from "next/server";

// DEMO build: state is intentionally NOT persisted. The app boots from its
// built-in seed every time, and edits (logged batches, edited counts, saved
// forecasts) live only in the browser tab until it's reloaded — so anyone can
// poke at the demo without affecting the next visitor.
//
// GET returns "no saved state" (the client falls back to seed); POST is a no-op
// acknowledgement so the client's debounced auto-save resolves cleanly.
export async function GET() {
  return NextResponse.json({ value: null, updatedAt: null });
}

export async function POST() {
  return NextResponse.json({ ok: true, updatedAt: Date.now() });
}
