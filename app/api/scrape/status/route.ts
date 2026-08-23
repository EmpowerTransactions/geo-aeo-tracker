import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  checkAiScrapes,
  ProviderSchema,
} from "@/lib/server/brightdata-scraper";

// Batch status endpoint for jobs started by POST /api/scrape. The client
// polls this with ALL of its pending snapshot ids in ONE request per tick, so
// polling load is constant regardless of how many jobs are in flight (the
// proxy.ts rate limiter would 429 per-job polling). Each check is a short
// progress call; ready snapshots are downloaded and normalized server-side —
// BRIGHT_DATA_KEY never reaches the browser.
export const runtime = "nodejs";

const ItemSchema = z.object({
  snapshotId: z.string().min(4).max(128),
  provider: ProviderSchema,
  prompt: z.string().min(3),
  requireSources: z.boolean().optional(),
});

const InputSchema = z.object({
  items: z.array(ItemSchema).min(1).max(40),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { items } = InputSchema.parse(body);
    const results = await checkAiScrapes(items);
    return NextResponse.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
