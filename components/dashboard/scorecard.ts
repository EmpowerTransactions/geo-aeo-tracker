import type { Provider, ScrapeRun, TaggedPrompt } from "@/components/dashboard/types";
import { ALL_PROVIDERS } from "@/components/dashboard/types";

/**
 * A model counts as measured only when its latest answers cover at least this
 * share of the questions. Below it (a scraper that timed out, a model switched on
 * but never wired up) its numbers say nothing about visibility and are left out
 * of the headline instead of being averaged in as zeros.
 */
export const MIN_COVERAGE = 0.5;

const UNTAGGED = "(no tag)";

export type ProviderScore = {
  provider: Provider;
  /** Questions this model has a latest answer for */
  answered: number;
  coverage: number;
  measured: boolean;
  avg: number;
  named: number;
  cited: number;
};

export type TagScore = {
  tag: string;
  questions: number;
  /** Latest answers from measured models */
  answers: number;
  named: number;
  avg: number;
};

export type Scorecard = {
  questions: number;
  /** Equal weight per measured model, latest answer per question */
  score: number | null;
  /** Share of latest answers that name the brand, equal weight per model */
  namedRate: number | null;
  citedRate: number | null;
  providers: ProviderScore[];
  tags: TagScore[];
};

const runKey = (prompt: string, provider: Provider) => `${prompt}|||${provider}`;

/** Newest run for each question × model. Older runs are history, not the current state. */
export function latestRuns(runs: ScrapeRun[]): ScrapeRun[] {
  const latest = new Map<string, ScrapeRun>();
  runs.forEach((run) => {
    const key = runKey(run.prompt, run.provider);
    const prev = latest.get(key);
    if (!prev || new Date(run.createdAt).getTime() > new Date(prev.createdAt).getTime()) {
      latest.set(key, run);
    }
  });
  return [...latest.values()];
}

function siteDomains(websites: string[]): string[] {
  return websites
    .map((w) => w.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase())
    .filter(Boolean);
}

const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

export function computeScorecard({
  runs,
  prompts,
  activeProviders,
  websites,
  country,
}: {
  runs: ScrapeRun[];
  prompts: TaggedPrompt[];
  activeProviders: Provider[];
  websites: string[];
  country?: string;
}): Scorecard {
  const inCountry = country ? runs.filter((r) => !r.country || r.country === country) : runs;
  const latest = latestRuns(inCountry);

  // Every question in the library plus any that only exist in stored answers
  const tagsByPrompt = new Map<string, string[]>();
  prompts.forEach((p) => tagsByPrompt.set(p.text, p.tags.length > 0 ? p.tags : [UNTAGGED]));
  latest.forEach((r) => {
    if (!tagsByPrompt.has(r.prompt)) tagsByPrompt.set(r.prompt, [UNTAGGED]);
  });
  const questions = tagsByPrompt.size;

  const domains = siteDomains(websites);
  const isCited = (r: ScrapeRun) =>
    domains.length > 0 && r.sources.some((s) => domains.some((d) => s.toLowerCase().includes(d)));
  const isNamed = (r: ScrapeRun) => (r.brandMentions?.length ?? 0) > 0;

  const byProvider = new Map<Provider, ScrapeRun[]>();
  latest.forEach((r) => {
    const list = byProvider.get(r.provider) ?? [];
    list.push(r);
    byProvider.set(r.provider, list);
  });

  const shown = ALL_PROVIDERS.filter((p) => byProvider.has(p) || activeProviders.includes(p));
  const providers: ProviderScore[] = shown.map((provider) => {
    const list = byProvider.get(provider) ?? [];
    const coverage = questions > 0 ? list.length / questions : 0;
    return {
      provider,
      answered: list.length,
      coverage,
      measured: list.length > 0 && coverage >= MIN_COVERAGE,
      avg: Math.round(mean(list.map((r) => r.visibilityScore ?? 0)) ?? 0),
      named: list.filter(isNamed).length,
      cited: list.filter(isCited).length,
    };
  });

  const measured = providers.filter((p) => p.measured);
  const measuredSet = new Set(measured.map((p) => p.provider));
  const score = mean(measured.map((p) => p.avg));
  const namedRate = mean(measured.map((p) => p.named / p.answered));
  const citedRate = mean(measured.map((p) => p.cited / p.answered));

  const tagRows = new Map<string, { questions: Set<string>; runs: ScrapeRun[] }>();
  tagsByPrompt.forEach((tags, prompt) => {
    tags.forEach((tag) => {
      const row = tagRows.get(tag) ?? { questions: new Set<string>(), runs: [] };
      row.questions.add(prompt);
      tagRows.set(tag, row);
    });
  });
  latest.forEach((r) => {
    if (!measuredSet.has(r.provider)) return;
    (tagsByPrompt.get(r.prompt) ?? [UNTAGGED]).forEach((tag) => tagRows.get(tag)?.runs.push(r));
  });

  const tags: TagScore[] = [...tagRows.entries()]
    .map(([tag, row]) => ({
      tag,
      questions: row.questions.size,
      answers: row.runs.length,
      named: row.runs.filter(isNamed).length,
      avg: Math.round(mean(row.runs.map((r) => r.visibilityScore ?? 0)) ?? 0),
    }))
    .sort((a, b) => {
      const ra = a.answers > 0 ? a.named / a.answers : 0;
      const rb = b.answers > 0 ? b.named / b.answers : 0;
      return ra - rb || b.questions - a.questions;
    });

  return {
    questions,
    score: score == null ? null : Math.round(score),
    namedRate,
    citedRate,
    providers,
    tags,
  };
}

/** Average of the newest answer from each model, so a model run five times does not count five times. */
export function latestAverage(runs: ScrapeRun[]): number {
  const latest = latestRuns(runs);
  if (latest.length === 0) return 0;
  return Math.round(latest.reduce((a, r) => a + (r.visibilityScore ?? 0), 0) / latest.length);
}
