import { z } from "zod";
import { fetchWithTimeout } from "./http";

export const ProviderSchema = z.enum([
  "chatgpt",
  "perplexity",
  "copilot",
  "gemini",
  "google_ai",
  "grok",
]);

type Provider = z.infer<typeof ProviderSchema>;

const OUTPUT_CACHE_TTL_MS = 1000 * 60 * 20;

const inMemoryCache = new Map<
  string,
  { expiresAt: number; value: NormalizedScrapeResult }
>();

const providerToDatasetEnv: Record<Provider, string> = {
  chatgpt: "BRIGHT_DATA_DATASET_CHATGPT",
  perplexity: "BRIGHT_DATA_DATASET_PERPLEXITY",
  copilot: "BRIGHT_DATA_DATASET_COPILOT",
  gemini: "BRIGHT_DATA_DATASET_GEMINI",
  google_ai: "BRIGHT_DATA_DATASET_GOOGLE_AI",
  grok: "BRIGHT_DATA_DATASET_GROK",
};

const providerBaseUrl: Record<Provider, string> = {
  chatgpt: "https://chatgpt.com/",
  perplexity: "https://www.perplexity.ai/",
  copilot: "https://copilot.microsoft.com/",
  gemini: "https://gemini.google.com/",
  google_ai: "https://www.google.com/",
  grok: "https://grok.com/",
};

type ScrapeRequest = {
  provider: Provider;
  prompt: string;
  requireSources?: boolean;
  country?: string;
};

type NormalizedScrapeResult = {
  provider: Provider;
  prompt: string;
  answer: string;
  sources: string[];
  snapshotId?: string;
  cached: boolean;
  raw: unknown;
  createdAt: string;
};

function getApiKey() {
  return process.env.BRIGHT_DATA_KEY;
}

function getDatasetId(provider: Provider) {
  return process.env[providerToDatasetEnv[provider]];
}

function buildCacheKey(input: ScrapeRequest) {
  return JSON.stringify(input);
}

function withAuthHeaders() {
  const key = getApiKey();
  if (!key) {
    throw new Error("Missing BRIGHT_DATA_KEY");
  }

  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

function stripAnswerHtml(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripAnswerHtml(entry));
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(obj)) {
      if (key.toLowerCase() === "answer_html") {
        continue;
      }
      cleaned[key] = stripAnswerHtml(entry);
    }

    return cleaned;
  }

  return value;
}

function extractSourcesFromAnswer(answer: string) {
  const found = new Set<string>();

  const blockedHostFragments = [
    // AI platforms
    "chatgpt.com",
    "openai.com",
    "oaiusercontent.com",
    "perplexity.ai",
    "pplx.ai",
    "copilot.microsoft.com",
    "grok.com",
    "x.ai",
    "gemini.google.com",
    "bard.google.com",
    "google.com/ai",
    // CDN / asset hosts
    "cloudfront.net",
    "cdn.prod.website-files.com",
    "cdn.jsdelivr.net",
    "cdnjs.cloudflare.com",
    "unpkg.com",
    "fastly.net",
    "akamaihd.net",
    "cloudflare.com",
    "amazonaws.com",
    // Tracking / analytics / pixels
    "connect.facebook.net",
    "facebook.net",
    "google-analytics.com",
    "googletagmanager.com",
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "hotjar.com",
    "segment.io",
    "segment.com",
    "mixpanel.com",
    "amplitude.com",
    "sentry.io",
    // Namespace / spec URIs
    "w3.org",
    "schema.org",
    "xmlns.com",
  ];

  const assetPathPattern =
    /\.(js|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|mp4|webm|mp3)(\?|$)/i;

  const junkPathFragments = [
    "/signals/",
    "/pixel",
    "/tracking",
    "/beacon",
    "/analytics",
    "/__",
    "/wp-content/uploads/",
    "/wp-includes/",
  ];

  const isThirdPartyCitation = (urlValue: string) => {
    try {
      const parsed = new URL(urlValue);
      const host = parsed.hostname.toLowerCase();
      const full = `${host}${parsed.pathname}`.toLowerCase();

      if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
        return false;
      }

      if (
        blockedHostFragments.some(
          (entry) => host === entry || host.endsWith(`.${entry}`),
        )
      ) {
        return false;
      }

      if (assetPathPattern.test(parsed.pathname)) {
        return false;
      }

      if (junkPathFragments.some((frag) => full.includes(frag))) {
        return false;
      }

      if (
        parsed.pathname.includes("/_spa/") ||
        parsed.pathname.includes("/assets/") ||
        full.includes("static")
      ) {
        return false;
      }

      // Reject overly long query strings (tracking params, base64 images, etc.)
      if (parsed.search.length > 200) {
        return false;
      }

      // Reject data URIs or blob-like things that somehow parsed
      if (host === "" || host === "localhost") {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  };

  const normalize = (urlValue: string) => {
    try {
      const parsed = new URL(urlValue);
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return urlValue;
    }
  };

  const plainUrls = answer.match(/https?:\/\/[^\s)\]}"']+/g) ?? [];
  plainUrls
    .map((entry) => entry.replace(/[),.;:!?]+$/, ""))
    .filter(isThirdPartyCitation)
    .map(normalize)
    .forEach((entry) => found.add(entry));

  const markdownLinks = answer.match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g) ?? [];
  markdownLinks.forEach((entry) => {
    const urlMatch = entry.match(/\((https?:\/\/[^)]+)\)/);
    if (!urlMatch?.[1]) return;
    const candidate = urlMatch[1].replace(/[),.;:!?]+$/, "");
    if (isThirdPartyCitation(candidate)) {
      found.add(normalize(candidate));
    }
  });

  return [...found];
}

function normalizeAnswer(rawRecord: Record<string, unknown>) {
  const answerCandidates = [
    rawRecord.answer_text, // Bright Data primary field
    rawRecord.answer_text_markdown, // Markdown variant (Perplexity, Grok, Copilot)
    rawRecord.answer, // Legacy / fallback
    rawRecord.response_raw, // Grok raw response
    rawRecord.response,
    rawRecord.output,
    rawRecord.result,
    rawRecord.text,
    rawRecord.content,
  ];

  for (const item of answerCandidates) {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }

  // Deep extraction: look inside nested objects/arrays for text content
  function extractDeepText(obj: unknown, depth: number): string | null {
    if (depth > 3) return null;
    if (typeof obj === "string" && obj.trim().length > 20) return obj.trim();
    if (Array.isArray(obj)) {
      for (const entry of obj) {
        const found = extractDeepText(entry, depth + 1);
        if (found) return found;
      }
    }
    if (obj && typeof obj === "object") {
      const record = obj as Record<string, unknown>;
      // Check common text field names
      for (const key of [
        "answer_text",
        "answer_text_markdown",
        "answer",
        "response_raw",
        "response",
        "output",
        "result",
        "text",
        "content",
        "message",
        "body",
        "summary",
        "description",
      ]) {
        if (
          typeof record[key] === "string" &&
          (record[key] as string).trim().length > 20
        ) {
          return (record[key] as string).trim();
        }
      }
      // Recurse into any value
      for (const val of Object.values(record)) {
        const found = extractDeepText(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  const deepText = extractDeepText(rawRecord, 0);
  if (deepText) return deepText;

  // Last resort: stringify but strip obvious noise
  const raw = JSON.stringify(rawRecord);
  // If it's tiny JSON, just return it — user will see something
  if (raw.length < 500) return raw;
  // For large blobs, try to extract readable text by stripping JSON structure
  return raw
    .replace(/[{}\[\]"]/g, " ")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 2000);
}

async function monitorUntilReady(snapshotId: string) {
  const maxAttempts = 60;
  const BASE_DELAY = 2000;
  const MAX_DELAY = 10000;
  let elapsed = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const monitorRes = await fetchWithTimeout(
      `https://api.brightdata.com/datasets/v3/progress/${snapshotId}`,
      {
        method: "GET",
        headers: withAuthHeaders(),
      },
      20_000,
    );

    if (!monitorRes.ok) {
      throw new Error(`Monitor failed (${monitorRes.status})`);
    }

    const monitorJson = (await monitorRes.json()) as {
      status: "starting" | "running" | "ready" | "failed";
    };

    if (monitorJson.status === "ready") {
      return;
    }

    if (monitorJson.status === "failed") {
      throw new Error("Snapshot failed");
    }

    // Exponential backoff: 2s → 4s → 8s → 10s (capped)
    const delay = Math.min(
      BASE_DELAY * Math.pow(2, Math.floor(attempt / 5)),
      MAX_DELAY,
    );
    elapsed += delay;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error(
    `Timed out after ~${Math.round(elapsed / 1000)}s waiting for snapshot ${snapshotId}`,
  );
}

async function downloadSnapshot(snapshotId: string) {
  const response = await fetchWithTimeout(
    `https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`,
    {
      method: "GET",
      headers: withAuthHeaders(),
    },
    60_000,
  );

  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }

  return response.json();
}

function normalizeScrapePayload(
  payload: unknown,
  parsed: Provider,
  prompt: string,
): NormalizedScrapeResult {
  // Keep unsanitized first record for structured source extraction
  const rawFirst = Array.isArray(payload)
    ? (payload as Record<string, unknown>[])[0]
    : (payload as Record<string, unknown>);
  const rawRecord = (rawFirst ?? {}) as Record<string, unknown>;

  const sanitizedPayload = stripAnswerHtml(payload);
  const sanitizedFirst = Array.isArray(sanitizedPayload)
    ? sanitizedPayload[0]
    : (sanitizedPayload as Record<string, unknown>);
  const record = (sanitizedFirst ?? {}) as Record<string, unknown>;
  const answer = normalizeAnswer(record);

  // Extract sources from answer text
  const textSources = extractSourcesFromAnswer(answer);

  // Also extract from Bright Data's structured citation fields
  const structuredSources: string[] = [];
  for (const field of ["citations", "links_attached", "sources"]) {
    const arr = rawRecord[field];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === "string" && item.startsWith("http")) {
          structuredSources.push(item);
        } else if (item && typeof item === "object") {
          const url = (item as Record<string, unknown>).url;
          if (typeof url === "string" && url.startsWith("http")) {
            structuredSources.push(url);
          }
        }
      }
    }
  }

  // Merge and deduplicate
  const allSources = [...new Set([...textSources, ...structuredSources])];

  const normalized: NormalizedScrapeResult = {
    provider: parsed,
    prompt: prompt,
    answer,
    sources: allSources,
    snapshotId:
      typeof record.snapshot_id === "string" ? record.snapshot_id : undefined,
    cached: false,
    raw: sanitizedPayload,
    createdAt: new Date().toISOString(),
  };

  return normalized;
}

export async function runAiScraper(
  request: ScrapeRequest,
): Promise<NormalizedScrapeResult> {
  const parsed = ProviderSchema.parse(request.provider);
  const datasetId = getDatasetId(parsed);

  if (!datasetId) {
    throw new Error(
      `${parsed} is not configured. Set ${providerToDatasetEnv[parsed]} in your .env to enable it, ` +
        `or deselect ${parsed} in the dashboard. This engine is optional and the others run without it.`,
    );
  }

  const cacheKey = buildCacheKey(request);
  const cacheHit = inMemoryCache.get(cacheKey);
  if (cacheHit && cacheHit.expiresAt > Date.now()) {
    return {
      ...cacheHit.value,
      cached: true,
    };
  }

  const inputRecord: Record<string, unknown> = {
    url: providerBaseUrl[parsed],
    prompt: request.prompt,
    index: 1,
  };

  if (request.country && parsed !== "chatgpt" && parsed !== "gemini") {
    inputRecord.country = request.country;
  }

  const scrapeResponse = await fetchWithTimeout(
    `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${datasetId}&notify=false&include_errors=true&format=json`,
    {
      method: "POST",
      headers: withAuthHeaders(),
      body: JSON.stringify({ input: [inputRecord] }),
    },
    60_000,
  );

  let payload: unknown;

  if (scrapeResponse.status === 202) {
    const pending = (await scrapeResponse.json()) as {
      snapshot_id: string;
    };
    await monitorUntilReady(pending.snapshot_id);
    payload = await downloadSnapshot(pending.snapshot_id);
  } else {
    if (!scrapeResponse.ok) {
      const text = await scrapeResponse.text();
      throw new Error(`Scrape failed (${scrapeResponse.status}): ${text}`);
    }
    payload = await scrapeResponse.json();
  }

  const normalized = normalizeScrapePayload(payload, parsed, request.prompt);

  // Bound the cache: drop expired entries (and, if still oversized, the oldest)
  // so a long-lived process can't leak memory on high-cardinality prompts.
  if (inMemoryCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of inMemoryCache)
      if (v.expiresAt <= now) inMemoryCache.delete(k);
    while (inMemoryCache.size > 500) {
      const oldest = inMemoryCache.keys().next().value;
      if (oldest === undefined) break;
      inMemoryCache.delete(oldest);
    }
  }
  inMemoryCache.set(cacheKey, {
    expiresAt: Date.now() + OUTPUT_CACHE_TTL_MS,
    value: normalized,
  });

  return normalized;
}

// ---------------------------------------------------------------------------
// Async split (trigger + status poll)
//
// Netlify fronts every /api route with the proxy.ts rate-limit middleware,
// deployed as an Edge Function with a hard 40s response cap, and synchronous
// Netlify Functions cap at 60s. Bright Data dataset snapshots routinely take
// minutes, so no single request may wait for one. startAiScrape() fires the
// job via /datasets/v3/trigger (returns a snapshot_id immediately) and
// checkAiScrapes() resolves progress/downloads in short batch calls driven by
// the client's poller.
// ---------------------------------------------------------------------------

export type ScrapeTriggerResult =
  | { status: "ready"; result: NormalizedScrapeResult }
  | {
      status: "pending";
      snapshotId: string;
      provider: Provider;
      prompt: string;
    };

export async function startAiScrape(
  request: ScrapeRequest,
): Promise<ScrapeTriggerResult> {
  const parsed = ProviderSchema.parse(request.provider);
  const datasetId = getDatasetId(parsed);

  if (!datasetId) {
    throw new Error(
      `${parsed} is not configured. Set ${providerToDatasetEnv[parsed]} in your .env to enable it, ` +
        `or deselect ${parsed} in the dashboard. This engine is optional and the others run without it.`,
    );
  }

  const cacheKey = buildCacheKey(request);
  const cacheHit = inMemoryCache.get(cacheKey);
  if (cacheHit && cacheHit.expiresAt > Date.now()) {
    return { status: "ready", result: { ...cacheHit.value, cached: true } };
  }

  const inputRecord: Record<string, unknown> = {
    url: providerBaseUrl[parsed],
    prompt: request.prompt,
    index: 1,
  };

  // ChatGPT and Gemini datasets reject `country` at validation (HTTP 400).
  if (request.country && parsed !== "chatgpt" && parsed !== "gemini") {
    inputRecord.country = request.country;
  }

  // /trigger takes a BARE JSON array and returns { snapshot_id } immediately.
  const res = await fetchWithTimeout(
    `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${datasetId}&include_errors=true`,
    {
      method: "POST",
      headers: withAuthHeaders(),
      body: JSON.stringify([inputRecord]),
    },
    25_000,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trigger failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as { snapshot_id?: string };
  if (!json.snapshot_id) {
    throw new Error(
      `Trigger returned no snapshot_id: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  return {
    status: "pending",
    snapshotId: json.snapshot_id,
    provider: parsed,
    prompt: request.prompt,
  };
}

export type ScrapeStatusItem = {
  snapshotId: string;
  provider: Provider;
  prompt: string;
  requireSources?: boolean;
};

export type ScrapeStatusResult =
  | { snapshotId: string; status: "pending" }
  | { snapshotId: string; status: "failed"; error: string }
  | { snapshotId: string; status: "ready"; result: NormalizedScrapeResult };

async function checkOneScrape(
  item: ScrapeStatusItem,
): Promise<ScrapeStatusResult> {
  const parsed = ProviderSchema.parse(item.provider);
  try {
    const progressRes = await fetchWithTimeout(
      `https://api.brightdata.com/datasets/v3/progress/${item.snapshotId}`,
      { method: "GET", headers: withAuthHeaders() },
      10_000,
    );
    if (!progressRes.ok) {
      // Transient monitor failure: report pending so the next tick retries.
      return { snapshotId: item.snapshotId, status: "pending" };
    }
    const progress = (await progressRes.json()) as {
      status: "starting" | "running" | "ready" | "failed";
    };
    if (progress.status === "failed") {
      return {
        snapshotId: item.snapshotId,
        status: "failed",
        error: "Bright Data reported the snapshot as failed.",
      };
    }
    if (progress.status !== "ready") {
      return { snapshotId: item.snapshotId, status: "pending" };
    }

    const payload = await downloadSnapshot(item.snapshotId);
    const result = normalizeScrapePayload(payload, parsed, item.prompt);

    // Best-effort per-instance cache so a duplicate prompt within the TTL can
    // resolve instantly at trigger time.
    inMemoryCache.set(
      buildCacheKey({
        provider: parsed,
        prompt: item.prompt,
        requireSources: item.requireSources,
      }),
      { expiresAt: Date.now() + OUTPUT_CACHE_TTL_MS, value: result },
    );

    return { snapshotId: item.snapshotId, status: "ready", result };
  } catch (error) {
    // Download/parse hiccups are retryable — the snapshot persists on Bright
    // Data's side, so report pending rather than failing the job.
    void error;
    return { snapshotId: item.snapshotId, status: "pending" };
  }
}

export async function checkAiScrapes(
  items: ScrapeStatusItem[],
): Promise<ScrapeStatusResult[]> {
  return Promise.all(items.map((item) => checkOneScrape(item)));
}
