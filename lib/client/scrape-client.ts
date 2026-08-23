/**
 * Client transport for AI-engine scrapes.
 *
 * Bright Data snapshots take minutes, and the server can't hold a request
 * open that long (Netlify sync functions cap at 60s; the proxy.ts rate-limit
 * middleware caps responses at 40s). So the flow is:
 *
 *   1. POST /api/scrape        → { status: "pending", snapshotId } (fast)
 *   2. POST /api/scrape/status → batch-poll ALL pending ids in ONE request
 *      per tick until each is ready | failed.
 *
 * This module also protects the app from its own proxy.ts rate limiter:
 *   - trigger POSTs are spaced ≥ TRIGGER_SPACING_MS apart globally
 *     (/api/scrape allows 20/min per IP — spacing at 3.5s stays under it),
 *   - polling is ONE shared interval for every in-flight job (12/min,
 *     against a 60/min budget on /api/scrape/status),
 *   - 429s honour Retry-After and retry instead of failing silently.
 */

export type ScrapeRequestBody = {
  provider: string;
  prompt: string;
  requireSources?: boolean;
  country?: string;
};

export type ScrapeResultData = {
  provider: string;
  prompt: string;
  answer: string;
  sources: string[];
  snapshotId?: string;
  cached: boolean;
  createdAt: string;
};

const TRIGGER_SPACING_MS = 3_500;
const POLL_INTERVAL_MS = 5_000;
const JOB_DEADLINE_MS = 10 * 60_000;
const MAX_TRIGGER_ATTEMPTS = 5;
const STATUS_BATCH_MAX = 40;

type PendingJob = {
  snapshotId: string;
  provider: string;
  prompt: string;
  requireSources?: boolean;
  deadline: number;
  resolve: (result: ScrapeResultData) => void;
  reject: (error: Error) => void;
};

const pendingJobs = new Map<string, PendingJob>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

// Serializes trigger POSTs with a minimum gap between launches.
let triggerChain: Promise<void> = Promise.resolve();
let lastTriggerAt = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttledTrigger(body: ScrapeRequestBody): Promise<Response> {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const previous = triggerChain;
  triggerChain = triggerChain.then(() => gate);
  await previous;

  try {
    const wait = lastTriggerAt + TRIGGER_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastTriggerAt = Date.now();
    return await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    release();
  }
}

function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);
}

function stopPollingIfIdle() {
  if (pendingJobs.size === 0 && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollOnce() {
  if (pollInFlight || pendingJobs.size === 0) return;
  pollInFlight = true;
  try {
    const now = Date.now();
    for (const [id, job] of pendingJobs) {
      if (job.deadline <= now) {
        pendingJobs.delete(id);
        job.reject(
          new Error(
            `${job.provider} scrape timed out after ${Math.round(JOB_DEADLINE_MS / 60000)} minutes.`,
          ),
        );
      }
    }
    if (pendingJobs.size === 0) return;

    const batch = [...pendingJobs.values()].slice(0, STATUS_BATCH_MAX);
    const response = await fetch("/api/scrape/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: batch.map((job) => ({
          snapshotId: job.snapshotId,
          provider: job.provider,
          prompt: job.prompt,
          requireSources: job.requireSources,
        })),
      }),
    });

    // 429 or transient server error: skip this tick; the next one retries.
    if (!response.ok) return;

    const data = (await response.json()) as {
      results?: Array<
        | { snapshotId: string; status: "pending" }
        | { snapshotId: string; status: "failed"; error: string }
        | { snapshotId: string; status: "ready"; result: ScrapeResultData }
      >;
    };

    for (const item of data.results ?? []) {
      const job = pendingJobs.get(item.snapshotId);
      if (!job) continue;
      if (item.status === "ready") {
        pendingJobs.delete(item.snapshotId);
        job.resolve(item.result);
      } else if (item.status === "failed") {
        pendingJobs.delete(item.snapshotId);
        job.reject(new Error(`${job.provider} scrape failed: ${item.error}`));
      }
    }
  } catch {
    // Network hiccup — next tick retries. Jobs stay pending.
  } finally {
    pollInFlight = false;
    stopPollingIfIdle();
  }
}

/**
 * Runs one scrape end-to-end (trigger, then poll until done). Resolves with
 * the normalized result or rejects with a descriptive error.
 */
export async function runScrape(
  body: ScrapeRequestBody,
): Promise<ScrapeResultData> {
  let lastError = "Scrape request failed";

  for (let attempt = 0; attempt < MAX_TRIGGER_ATTEMPTS; attempt += 1) {
    const response = await throttledTrigger(body);

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 10_000,
      );
      lastError = "Rate limited while starting the scrape.";
      continue;
    }

    const data = (await response.json().catch(() => ({}))) as {
      status?: "ready" | "pending";
      result?: ScrapeResultData;
      snapshotId?: string;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(data.error || `Scrape trigger failed (${response.status})`);
    }

    if (data.status === "ready" && data.result) {
      return data.result;
    }

    if (data.status === "pending" && data.snapshotId) {
      return new Promise<ScrapeResultData>((resolve, reject) => {
        pendingJobs.set(data.snapshotId as string, {
          snapshotId: data.snapshotId as string,
          provider: body.provider,
          prompt: body.prompt,
          requireSources: body.requireSources,
          deadline: Date.now() + JOB_DEADLINE_MS,
          resolve,
          reject,
        });
        ensurePolling();
      });
    }

    throw new Error("Unexpected response from scrape trigger.");
  }

  throw new Error(lastError);
}
