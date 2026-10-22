import { useCallback } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  PROVIDER_LABELS,
  COUNTRY_LABELS,
  type ScrapeRun,
} from "@/components/dashboard/types";
import type { Scorecard } from "@/components/dashboard/scorecard";

// Brand-ish accent per engine, chosen to stay legible in both themes.
const PROVIDER_COLORS: Record<string, string> = {
  chatgpt: "#10a37f",
  perplexity: "#20b8cd",
  copilot: "#0a84ff",
  gemini: "#4285f4",
  google_ai: "#ea8600",
  grok: "#6b7280",
};

type VisibilityAnalyticsTabProps = {
  data: Array<{ day: string; visibility: number }>;
  runs: ScrapeRun[];
  scorecard: Scorecard;
};

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function VisibilityAnalyticsTab({
  data,
  runs,
  scorecard,
}: VisibilityAnalyticsTabProps) {
  const exportRunsCsv = useCallback(() => {
    const header =
      "Date,Provider,Country,Prompt,Visibility Score,Sentiment,Brand Mentions,Competitor Mentions,Sources Count\n";
    const rows = runs
      .map((r) =>
        [
          r.createdAt,
          r.provider,
          r.country || "US",
          `"${r.prompt.replace(/"/g, '""')}"`,
          r.visibilityScore ?? 0,
          r.sentiment ?? "",
          (r.brandMentions ?? []).join("; "),
          (r.competitorMentions ?? []).join("; "),
          r.sources.length,
        ].join(","),
      )
      .join("\n");
    downloadCsv(
      `aeo-runs-${new Date().toISOString().slice(0, 10)}.csv`,
      header + rows,
    );
  }, [runs]);

  const exportTrendCsv = useCallback(() => {
    const header = "Day,Avg Visibility (%)\n";
    const rows = data.map((d) => `${d.day},${d.visibility}`).join("\n");
    downloadCsv(
      `aeo-trend-${new Date().toISOString().slice(0, 10)}.csv`,
      header + rows,
    );
  }, [data]);

  // Per-engine score from the newest answer to each question, highest first.
  // Engines that answered too few questions are listed as not measured.
  const byProvider = [...scorecard.providers].sort(
    (a, b) => Number(b.measured) - Number(a.measured) || b.avg - a.avg,
  );
  const measured = scorecard.providers.filter((p) => p.measured);
  const latestAnswers = measured.reduce((a, p) => a + p.answered, 0);
  const latestNamed = measured.reduce((a, p) => a + p.named, 0);

  // Per-country average visibility, highest first (geo-scoped runs only).
  const byCountry = Object.values(
    runs.reduce(
      (acc, r) => {
        const code = r.country || "US";
        if (!acc[code]) acc[code] = { code, sum: 0, count: 0 };
        acc[code].sum += r.visibilityScore ?? 0;
        acc[code].count += 1;
        return acc;
      },
      {} as Record<string, { code: string; sum: number; count: number }>,
    ),
  )
    .map((c) => ({ code: c.code, avg: Math.round(c.sum / c.count) }))
    .sort((a, b) => b.avg - a.avg);

  return (
    <div className="space-y-4">
      {/* Visibility by AI engine */}
      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="mb-3 text-xs font-medium uppercase tracking-wider text-th-text-muted">
          Visibility by AI engine
        </div>
        {byProvider.length === 0 ? (
          <p className="text-sm text-th-text-muted">
            Run prompts to see how each AI engine ranks your brand.
          </p>
        ) : (
          <div className="space-y-2.5">
            {byProvider.map(({ provider, avg, measured, answered }) => (
              <div key={provider} className="flex items-center gap-3">
                <span className="flex w-28 shrink-0 items-center gap-1.5 text-sm text-th-text">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: PROVIDER_COLORS[provider] }}
                  />
                  {PROVIDER_LABELS[provider]}
                </span>
                {measured ? (
                  <>
                    <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-th-card-alt">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full transition-all"
                        style={{
                          width: `${avg}%`,
                          backgroundColor: PROVIDER_COLORS[provider],
                        }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums text-th-text">
                      {avg}
                    </span>
                  </>
                ) : (
                  <span className="flex-1 text-xs text-th-text-muted">
                    Not measured — {answered === 0 ? "no answers yet" : `${answered} of ${scorecard.questions} questions answered`}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Visibility by country */}
      {byCountry.length > 0 && (
        <div className="rounded-lg border border-th-border bg-th-card p-4">
          <div className="mb-3 text-xs font-medium uppercase tracking-wider text-th-text-muted">
            Visibility by country
          </div>
          <div className="space-y-2.5">
            {byCountry.map(({ code, avg }) => (
              <div key={code} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-sm text-th-text">
                  {code} — {COUNTRY_LABELS[code] ?? code}
                </span>
                <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-th-card-alt">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-th-accent transition-all"
                    style={{ width: `${avg}%` }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums text-th-text">
                  {avg}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Named vs not named, newest answer per question from each measured engine */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-th-border bg-th-card px-3 py-2.5">
          <div className="text-xs uppercase tracking-wider text-th-text-muted">Named</div>
          <div className="mt-0.5 text-xl font-bold text-th-success">
            {latestNamed}
            <span className="ml-1 text-xs font-normal text-th-text-muted">of {latestAnswers} latest answers</span>
          </div>
        </div>
        <div className="rounded-lg border border-th-border bg-th-card px-3 py-2.5">
          <div className="text-xs uppercase tracking-wider text-th-text-muted">Not named</div>
          <div className="mt-0.5 text-xl font-bold text-th-text-muted">{latestAnswers - latestNamed}</div>
        </div>
      </div>

      {/* Chart */}
      {data.length === 0 ? (
        <div className="rounded-lg border border-th-border bg-th-card-alt p-8 text-center text-sm text-th-text-secondary">
          No trend data yet. Run prompts to populate visibility trend.
        </div>
      ) : (
        <div className="h-80 w-full rounded-lg border border-th-border bg-th-card-alt p-2">
          <ResponsiveContainer>
            <LineChart data={data}>
              <CartesianGrid
                stroke="var(--th-chart-grid)"
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="day"
                tick={{ fill: "var(--th-chart-axis)", fontSize: 12 }}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fill: "var(--th-chart-axis)", fontSize: 12 }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--th-card)",
                  border: "1px solid var(--th-border)",
                  borderRadius: "8px",
                  color: "var(--th-text)",
                }}
              />
              <Line
                type="monotone"
                dataKey="visibility"
                name="Avg Visibility %"
                stroke="var(--th-accent)"
                strokeWidth={2.5}
                dot={{ r: 3, fill: "var(--th-accent)" }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Export buttons */}
      <div className="flex gap-2">
        <button
          onClick={exportRunsCsv}
          disabled={runs.length === 0}
          className="bd-chip rounded-lg px-4 py-2 text-sm disabled:opacity-40"
        >
          Export All Runs (CSV)
        </button>
        <button
          onClick={exportTrendCsv}
          disabled={data.length === 0}
          className="bd-chip rounded-lg px-4 py-2 text-sm disabled:opacity-40"
        >
          Export Trend Data (CSV)
        </button>
      </div>
    </div>
  );
}
