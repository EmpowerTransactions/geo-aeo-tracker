import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { startAiScrape } from "@/lib/server/brightdata-scraper";

// Bright Data snapshots take minutes; this route only TRIGGERS the job (fast)
// and returns { status: "pending", snapshotId } — or { status: "ready",
// result } on a warm cache hit. The client resolves pending jobs through
// POST /api/scrape/status. Nothing here may wait on a snapshot: Netlify sync
// functions cap at 60s and the proxy.ts rate-limit middleware (an Edge
// Function) caps responses at 40s.
export const runtime = "nodejs";

const InputSchema = z.object({
  provider: z.enum([
    "chatgpt",
    "perplexity",
    "copilot",
    "gemini",
    "google_ai",
    "grok",
  ]),
  prompt: z.string().min(3),
  requireSources: z.boolean().optional(),
  country: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = InputSchema.parse(body);
    const result = await startAiScrape(parsed);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
