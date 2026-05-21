import { NextResponse } from "next/server";
import { disableTailscale } from "@/lib/tunnel/tunnelManager";

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const result = await disableTailscale();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tailscale disable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
