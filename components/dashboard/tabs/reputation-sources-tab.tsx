import { useMemo, useState } from "react";
import type { ScrapeRun, TaggedPrompt } from "@/components/dashboard/types";
import { ALL_PROVIDERS, PROVIDER_LABELS, type Provider } from "@/components/dashboard/types";
import type { RunDelta } from "@/components/dashboard/types";
import { computeScorecard, latestAverage, MIN_COVERAGE, type Scorecard } from "@/components/dashboard/scorecard";

type ReputationSourcesTabProps = {
  runs: ScrapeRun[];
  prompts: TaggedPrompt[];
  activeProviders: Provider[];
  websites: string[];
  country: string;
  brandTerms: string[];
  competitorTerms: string[];
  runDeltas?: RunDelta[];
  onDeleteRun?: (index: number) => void;
};

function normalizeAnswerForDisplay(answer: string): string {
  let text = answer;

  // If the answer looks like raw JSON, try to extract the text content
  if (/^\s*[{\[]/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      const extract = (obj: unknown): string => {
        if (typeof obj === "string") return obj;
        if (Array.isArray(obj)) return obj.map(extract).filter(Boolean).join("\n\n");
        if (obj && typeof obj === "object") {
          const rec = obj as Record<string, unknown>;
          for (const key of ["answer", "response", "output", "text", "content", "message", "body"]) {
            if (typeof rec[key] === "string" && (rec[key] as string).trim()) return (rec[key] as string).trim();
          }
          return Object.values(rec).map(extract).filter(Boolean).join("\n\n");
        }
        return String(obj ?? "");
      };
      const extracted = extract(parsed);
      if (extracted.trim().length > 20) text = extracted;
    } catch {
      // Strip JSON structural characters as fallback
      text = text
        .replace(/[{}\[\]"]/g, " ")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, " ");
    }
  }

  return text
    .replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Highlight brand and competitor mentions in text */
function HighlightedText({
  text,
  brandTerms,
  competitorTerms,
}: {
  text: string;
  brandTerms: string[];
  competitorTerms: string[];
}) {
  if (brandTerms.length === 0 && competitorTerms.length === 0) {
    return <span>{text}</span>;
  }

  const allTerms = [
    ...brandTerms.map((t) => ({ term: t, type: "brand" as const })),
    ...competitorTerms.map((t) => ({ term: t, type: "competitor" as const })),
  ].sort((a, b) => b.term.length - a.term.length);

  const escaped = allTerms.map((t) => ({
    ...t,
    pattern: t.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  }));

  const regex = new RegExp(
    `(${escaped.map((t) => t.pattern).join("|")})`,
    "gi",
  );

  const parts = text.split(regex);

  return (
    <span>
      {parts.map((part, i) => {
        const match = allTerms.find(
          (t) => t.term.toLowerCase() === part.toLowerCase(),
        );
        if (match) {
          return (
            <mark
              key={i}
              className={
                match.type === "brand"
                  ? "rounded-sm bg-th-brand-bg px-0.5 font-medium text-th-brand-text"
                  : "rounded-sm bg-th-competitor-bg px-0.5 font-medium text-th-competitor-text"
              }
              title={match.type === "brand" ? "Your brand" : "Competitor"}
            >
              {part}
            </mark>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}

function SentimentBadge({ sentiment }: { sentiment: string }) {
  const colors: Record<string, string> = {
    positive: "bg-th-success-soft text-th-success border-th-success/30",
    neutral: "bg-th-accent-soft text-th-text-accent border-th-accent/30",
    negative: "bg-th-danger-soft text-th-danger border-th-danger/30",
    "not-mentioned": "bg-th-card-alt text-th-text-muted border-th-border",
  };
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium uppercase ${colors[sentiment] ?? colors["neutral"]}`}
    >
      {sentiment}
    </span>
  );
}

const PROVIDER_COLORS: Record<Provider, string> = {
  chatgpt: "#10a37f",
  perplexity: "#1ba1e3",
  copilot: "#7c5bbf",
  gemini: "#4285f4",
  google_ai: "#ea4335",
  grok: "#6b7280",
};

function ProviderBadge({ provider }: { provider: Provider }) {
  const bg = PROVIDER_COLORS[provider] ?? "#4285f4";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={{ backgroundColor: bg + "22", color: bg, border: `1px solid ${bg}44` }}
    >
      {PROVIDER_LABELS[provider] ?? provider}
    </span>
  );
}

function ModelResponseCard({
  run,
  brandTerms,
  competitorTerms,
  delta,
  onDelete,
}: {
  run: ScrapeRun;
  brandTerms: string[];
  competitorTerms: string[];
  delta?: number | null;
  onDelete?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rawDisplay = normalizeAnswerForDisplay(run.answer ?? "");
  // Filter out garbage: answers that just echo the prompt or are just a URL
  const isGarbage =
    !rawDisplay ||
    rawDisplay.toLowerCase().trim() === run.prompt.toLowerCase().trim() ||
    /^https?:\/\/\S+$/i.test(rawDisplay.trim());
  const display = isGarbage ? "" : rawDisplay;
  const preview = display.length > 300 ? display.slice(0, 300) + "…" : display;
  const uniqueSources = [...new Set(run.sources)];

  return (
    <div className="group relative rounded-lg border border-th-border bg-th-card">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-th-card-hover"
      >
        <ProviderBadge provider={run.provider} />
        <div className="flex flex-1 items-center gap-3">
          <span className="text-xs text-th-text-muted">
            Score: <span className="font-semibold text-th-text">{run.visibilityScore}</span>/100
          </span>
          {delta != null && delta !== 0 && (
            <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-bold ${
              delta > 0 ? "bg-th-success-soft text-th-success" : "bg-th-danger-soft text-th-danger"
            }`}>
              {delta > 0 ? "↑" : "↓"}{Math.abs(delta)}
            </span>
          )}
          <SentimentBadge sentiment={run.sentiment ?? "neutral"} />
          {run.brandMentions?.length > 0 && (
            <span className="text-xs text-th-brand-text">
              {run.brandMentions.length} brand mention{run.brandMentions.length > 1 ? "s" : ""}
            </span>
          )}
          {uniqueSources.length > 0 && (
            <span className="text-xs text-th-text-muted">
              {uniqueSources.length} source{uniqueSources.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <span className="text-xs text-th-text-muted">{run.createdAt.slice(0, 10)}</span>
        <span className="text-xs text-th-text-muted">{expanded ? "▲" : "▼"}</span>
      </button>
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm("Delete this response? This cannot be undone.")) onDelete();
          }}
          className="absolute right-2 top-2 rounded p-1 text-th-text-muted opacity-0 transition-opacity hover:bg-th-danger-soft hover:text-th-danger group-hover:opacity-100"
          title="Delete this response"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      )}

      {/* Preview when collapsed */}
      {!expanded && (
        <div className="border-t border-th-border/40 px-4 py-2.5 text-sm leading-relaxed text-th-text-secondary">
          {preview ? (
            <HighlightedText
              text={preview}
              brandTerms={brandTerms}
              competitorTerms={competitorTerms}
            />
          ) : (
            <span className="italic text-th-text-muted">No response text captured — try re-running this prompt.</span>
          )}
        </div>
      )}

      {/* Full content when expanded */}
      {expanded && (
        <div className="space-y-3 border-t border-th-border px-4 py-3">
          {/* Highlight legend */}
          {(brandTerms.length > 0 || competitorTerms.length > 0) && (
            <div className="flex items-center gap-3 text-xs text-th-text-muted">
              {brandTerms.length > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-th-brand-bg" />
                  Brand
                </span>
              )}
              {competitorTerms.length > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-th-competitor-bg" />
                  Competitor
                </span>
              )}
            </div>
          )}

          <div className="max-h-[400px] overflow-auto whitespace-pre-wrap break-words pr-1 text-sm leading-7 text-th-text">
            {display ? (
              <HighlightedText
                text={display}
                brandTerms={brandTerms}
                competitorTerms={competitorTerms}
              />
            ) : (
              <span className="italic text-th-text-muted">No response text captured from this AI model. Re-run the prompt to fetch fresh data.</span>
            )}
          </div>

          {uniqueSources.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-th-text-muted">
                Cited Sources
              </div>
              <div className="flex flex-wrap gap-1.5">
                {uniqueSources.map((source) => (
                  <a
                    key={source}
                    href={source}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block max-w-[300px] truncate rounded-md border border-th-border bg-th-card-alt px-2 py-1 text-xs text-th-text-accent hover:text-th-accent"
                    title={source}
                  >
                    {source}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ReputationSourcesTab({
  runs,
  prompts,
  activeProviders,
  websites,
  country,
  brandTerms,
  competitorTerms,
  runDeltas = [],
  onDeleteRun,
}: ReputationSourcesTabProps) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [filterProvider, setFilterProvider] = useState<Provider | "all">("all");
  const [filterSentiment, setFilterSentiment] = useState<string>("all");
  const [sortField, setSortField] = useState<"date" | "score">("date");

  // Apply filters
  const filteredRuns = useMemo(() => {
    let list = [...runs];
    if (filterProvider !== "all") list = list.filter((r) => r.provider === filterProvider);
    if (filterSentiment !== "all") list = list.filter((r) => r.sentiment === filterSentiment);
    return list;
  }, [runs, filterProvider, filterSentiment]);

  // Group runs by prompt
  const promptGroups = useMemo(() => {
    const m = new Map<string, ScrapeRun[]>();
    filteredRuns.forEach((run) => {
      const key = run.prompt;
      const group = m.get(key) ?? [];
      group.push(run);
      m.set(key, group);
    });
    const groups = [...m.entries()]
      .map(([prompt, groupRuns]) => ({
        prompt,
        runs: groupRuns.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ),
      }));

    if (sortField === "score") {
      return groups.sort((a, b) => latestAverage(b.runs) - latestAverage(a.runs));
    }

    return groups.sort((a, b) => {
      const aLatest = new Date(a.runs[0].createdAt).getTime();
      const bLatest = new Date(b.runs[0].createdAt).getTime();
      return bLatest - aLatest;
    });
  }, [filteredRuns, sortField]);

  // Scorecard: newest answer per question × model, each measured model weighted equally
  const scorecard = useMemo(
    () => computeScorecard({ runs, prompts, activeProviders, websites, country }),
    [runs, prompts, activeProviders, websites, country],
  );

  // Auto-expand first group
  const isGroupOpen = (prompt: string, idx: number) => {
    return expandedGroups[prompt] ?? idx === 0;
  };

  // Build a lookup map of deltas by prompt+provider
  const deltaMap = useMemo(() => {
    const m = new Map<string, number>();
    runDeltas.forEach((d) => m.set(`${d.prompt}|||${d.provider}`, d.delta));
    return m;
  }, [runDeltas]);

  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-th-border bg-th-card-alt p-8 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-th-accent-soft">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-th-text-accent">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <path d="M8 9h8M8 13h6" />
          </svg>
        </div>
        <p className="text-sm font-medium text-th-text">No model responses yet</p>
        <p className="mt-1 text-sm text-th-text-secondary">Run prompts to see brand analysis across AI models.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ScorecardPanel scorecard={scorecard} storedAnswers={runs.length} country={country} />

      {/* ── Filter / sort toolbar ── */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-th-border bg-th-card px-3 py-2.5">
        <span className="text-xs font-medium text-th-text-muted">Filter:</span>

        {/* Provider filter */}
        <select
          value={filterProvider}
          onChange={(e) => setFilterProvider(e.target.value as Provider | "all")}
          className="bd-input rounded-lg px-2.5 py-1.5 text-xs"
        >
          <option value="all">All Models</option>
          {ALL_PROVIDERS.map((p) => (
            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
          ))}
        </select>

        {/* Sentiment filter */}
        <select
          value={filterSentiment}
          onChange={(e) => setFilterSentiment(e.target.value)}
          className="bd-input rounded-lg px-2.5 py-1.5 text-xs"
        >
          <option value="all">All Sentiment</option>
          <option value="positive">Positive</option>
          <option value="neutral">Neutral</option>
          <option value="negative">Negative</option>
          <option value="not-mentioned">Not Mentioned</option>
        </select>

        {/* Sort */}
        <select
          value={sortField}
          onChange={(e) => setSortField(e.target.value as "date" | "score")}
          className="bd-input rounded-lg px-2.5 py-1.5 text-xs"
        >
          <option value="date">Sort: Recent</option>
          <option value="score">Sort: Score</option>
        </select>

        <span className="ml-auto text-xs text-th-text-muted">
          <span className="font-semibold text-th-text">{filteredRuns.length}</span> responses across{" "}
          <span className="font-semibold text-th-text">{promptGroups.length}</span> prompt{promptGroups.length > 1 ? "s" : ""}
        </span>
      </div>

      {/* ── Prompt groups ── */}
      <div className="space-y-2">
        {promptGroups.map(({ prompt, runs: groupRuns }, groupIdx) => {
          const open = isGroupOpen(prompt, groupIdx);
          const avgScore = latestAverage(groupRuns);
          const providers = [...new Set(groupRuns.map((r) => r.provider))];
          const scoreColor =
            avgScore >= 60 ? "text-th-success" : avgScore >= 30 ? "text-th-text-accent" : "text-th-danger";

          // Compute group-level average delta
          const groupDeltas = groupRuns
            .map((r) => deltaMap.get(`${r.prompt}|||${r.provider}`))
            .filter((d): d is number => d != null);
          const avgDelta = groupDeltas.length > 0
            ? Math.round(groupDeltas.reduce((a, b) => a + b, 0) / groupDeltas.length)
            : null;

          return (
            <div key={prompt} className="rounded-xl border border-th-border bg-th-card-alt">
              {/* Prompt header */}
              <button
                onClick={() =>
                  setExpandedGroups((prev) => ({ ...prev, [prompt]: !open }))
                }
                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-th-card-hover transition-colors rounded-t-xl"
              >
                <span className="mt-0.5 text-xs text-th-text-muted">{open ? "▼" : "▶"}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium leading-snug text-th-text">
                    {prompt.length > 120 ? prompt.slice(0, 117) + "…" : prompt}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    {providers.map((p) => (
                      <ProviderBadge key={p} provider={p} />
                    ))}
                    <span className="text-xs text-th-text-muted">
                      {groupRuns.length} response{groupRuns.length > 1 ? "s" : ""}
                    </span>
                    <span className="text-xs text-th-text-muted">·</span>
                    <span
                      className={`text-xs font-semibold ${scoreColor}`}
                      title="Average of the newest answer from each model"
                    >
                      Latest avg: {avgScore}/100
                    </span>
                    {avgDelta != null && avgDelta !== 0 && (
                      <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-bold ${
                        avgDelta > 0 ? "bg-th-success-soft text-th-success" : "bg-th-danger-soft text-th-danger"
                      }`}>
                        {avgDelta > 0 ? "↑" : "↓"}{Math.abs(avgDelta)}
                      </span>
                    )}
                  </div>
                </div>
              </button>

              {/* Model cards */}
              {open && (
                <div className="space-y-2 border-t border-th-border p-3">
                  {groupRuns.map((run, i) => (
                    <ModelResponseCard
                      key={`${run.provider}-${run.createdAt}-${i}`}
                      run={run}
                      brandTerms={brandTerms}
                      competitorTerms={competitorTerms}
                      delta={deltaMap.get(`${run.prompt}|||${run.provider}`) ?? null}
                      onDelete={onDeleteRun ? () => {
                        const origIdx = runs.indexOf(run);
                        if (origIdx !== -1) onDeleteRun(origIdx);
                      } : undefined}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Scorecard ── */
const pct = (rate: number | null) => (rate == null ? "—" : `${Math.round(rate * 100)}%`);

function ScorecardPanel({
  scorecard,
  storedAnswers,
  country,
}: {
  scorecard: Scorecard;
  storedAnswers: number;
  country: string;
}) {
  const [showAllTags, setShowAllTags] = useState(false);
  const measured = scorecard.providers.filter((p) => p.measured);
  const tags = showAllTags ? scorecard.tags : scorecard.tags.slice(0, 8);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <InsightMini
          label="Visibility Score"
          value={scorecard.score == null ? "—" : `${scorecard.score}/100`}
          sub={measured.length > 0 ? "latest" : undefined}
          accent
        />
        <InsightMini label="Named In" value={pct(scorecard.namedRate)} sub="of latest answers" />
        <InsightMini label="Our Site Cited" value={pct(scorecard.citedRate)} sub="of latest answers" />
        <InsightMini label="Models Measured" value={`${measured.length} of ${scorecard.providers.length}`} />
        <InsightMini label="Questions" value={scorecard.questions} />
        <InsightMini label="Stored Answers" value={storedAnswers} sub="incl. history" />
      </div>

      <p className="px-1 text-xs text-th-text-muted">
        Scores use the newest answer to each question from each model, and every measured model counts
        equally{country ? ` (${country} answers only)` : ""}. A model is measured once it has answered at
        least {Math.round(MIN_COVERAGE * 100)}% of the questions; below that it is left out rather than
        counted as zero.
      </p>

      {scorecard.providers.length > 0 && (
        <div className="rounded-xl border border-th-border bg-th-card p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-th-text-muted">
            Score by Model
          </div>
          <div className="flex flex-wrap gap-2">
            {scorecard.providers.map((p) => (
              <div
                key={p.provider}
                className={`flex items-center gap-2 rounded-lg border border-th-border px-3 py-1.5 ${
                  p.measured ? "bg-th-card-alt" : "bg-th-card opacity-70"
                }`}
              >
                <ProviderBadge provider={p.provider} />
                {p.measured ? (
                  <>
                    <span className="text-sm font-semibold text-th-text">{p.avg}</span>
                    <span className="text-xs text-th-text-muted">/ 100</span>
                    <span className="text-xs text-th-text-muted">
                      · named {p.named}/{p.answered} · {p.answered} of {scorecard.questions} questions
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-th-text-muted">
                    Not measured —{" "}
                    {p.answered === 0
                      ? "no answers yet"
                      : `only ${p.answered} of ${scorecard.questions} questions answered`}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {scorecard.tags.length > 0 && measured.length > 0 && (
        <div className="rounded-xl border border-th-border bg-th-card p-3">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <div className="text-xs font-medium uppercase tracking-wider text-th-text-muted">
              Where we are named, by question group
            </div>
            <div className="text-xs text-th-text-muted">Least named first</div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-th-text-muted">
                <tr className="border-b border-th-border">
                  <th className="py-1.5 pr-3 font-medium">Group</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Questions</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Named</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Named %</th>
                  <th className="py-1.5 text-right font-medium">Avg score</th>
                </tr>
              </thead>
              <tbody>
                {tags.map((t) => {
                  const rate = t.answers > 0 ? t.named / t.answers : null;
                  return (
                    <tr key={t.tag} className="border-b border-th-border/40 last:border-0">
                      <td className="py-1.5 pr-3 text-th-text">{t.tag}</td>
                      <td className="py-1.5 pr-3 text-right text-th-text-secondary">{t.questions}</td>
                      <td className="py-1.5 pr-3 text-right text-th-text-secondary">
                        {t.named}/{t.answers}
                      </td>
                      <td
                        className={`py-1.5 pr-3 text-right font-semibold ${
                          rate == null
                            ? "text-th-text-muted"
                            : rate >= 0.5
                              ? "text-th-success"
                              : rate >= 0.2
                                ? "text-th-text-accent"
                                : "text-th-danger"
                        }`}
                      >
                        {pct(rate)}
                      </td>
                      <td className="py-1.5 text-right text-th-text-secondary">{t.avg}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {scorecard.tags.length > 8 && (
            <button
              onClick={() => setShowAllTags(!showAllTags)}
              className="mt-2 text-xs font-medium text-th-text-accent hover:text-th-accent"
            >
              {showAllTags ? "Show fewer" : `Show all ${scorecard.tags.length} groups`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Insight Mini Card ── */
function InsightMini({
  label,
  value,
  sub,
  accent,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
  color?: string;
}) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${accent ? "border-th-accent/30 bg-th-accent-soft" : "border-th-border bg-th-card"}`}>
      <div className="text-xs uppercase tracking-wider text-th-text-muted">{label}</div>
      <div className={`mt-0.5 text-lg font-bold ${color ?? "text-th-text"}`}>
        {value}
        {sub && <span className="ml-1 text-xs font-normal text-th-text-muted">{sub}</span>}
      </div>
    </div>
  );
}
