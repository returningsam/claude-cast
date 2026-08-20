import { Action, ActionPanel, Color, Detail, Icon } from "@raycast/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DailyStats,
  formatTokens,
  generateProjectTable,
  getAllTimeStats,
  getDailyStats,
  getMonthStats,
  getTodayStats,
  getWeekStats,
  TopSessionSummary,
  UsageStats,
} from "./lib/usage-stats";
import { renderBarChartToFile } from "./lib/svg-chart";
import {
  formatPercent,
  formatReset,
  getSubscriptionUsage,
  SubscriptionUsage,
  SubscriptionUsageError,
  usageBar,
} from "./lib/subscription-usage";
import { formatCost } from "./lib/pricing";
import { getUsageMode, UsageMode } from "./lib/usage-mode";

type RangeKey = "today" | "week" | "month" | "all";

const RANGE_LABEL: Record<RangeKey, string> = {
  today: "Today",
  week: "This Week",
  month: "This Month",
  all: "All Time",
};

export default function UsageDashboard() {
  const [statsByRange, setStatsByRange] = useState<
    Partial<Record<RangeKey, UsageStats>>
  >({});
  const [statsLoading, setStatsLoading] = useState(true);
  const [daily, setDaily] = useState<DailyStats[]>([]);
  // Tracks which range `daily` was fetched for. Without this, switching range
  // briefly aggregates stale data with the new range (e.g. 7 daily points
  // bucketed as "monthly"), producing a mismatched chart for ~100ms before
  // the new fetch lands. By aggregating against `dailyRange`, the chart
  // keeps showing the previous range's correct view until the new data is
  // ready, then swaps atomically.
  const [dailyRange, setDailyRange] = useState<RangeKey>("today");
  const [range, setRange] = useState<RangeKey>("today");
  const mode = getUsageMode();
  const [usage, setUsage] = useState<SubscriptionUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  // Live subscription limits. Independent of the local-JSONL stats: a failure
  // here (no token, offline) hides the section but leaves the dashboard usable.
  const loadUsage = useCallback(
    (force = false) => {
      if (mode === "api") return;
      getSubscriptionUsage(force)
        .then((data) => {
          setUsage(data);
          setUsageError(null);
        })
        .catch((error: unknown) => {
          setUsage(null);
          setUsageError(
            error instanceof SubscriptionUsageError
              ? error.message
              : "Could not load subscription limits.",
          );
        });
    },
    [mode],
  );

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  // Fetch a daily series sized for the selected range. Cancellation token
  // protects against stale responses from rapid range switches.
  useEffect(() => {
    let cancelled = false;
    getDailyStats(daysForRange(range)).then((data) => {
      if (cancelled) return;
      setDaily(data);
      setDailyRange(range);
    });
    return () => {
      cancelled = true;
    };
  }, [range]);

  useEffect(() => {
    setStatsLoading(true);
    Promise.all([
      getTodayStats().then((s) => ["today" as const, s] as const),
      getWeekStats().then((s) => ["week" as const, s] as const),
      getMonthStats().then((s) => ["month" as const, s] as const),
      getAllTimeStats().then((s) => ["all" as const, s] as const),
    ])
      .then((entries) => {
        const next: Partial<Record<RangeKey, UsageStats>> = {};
        for (const [k, v] of entries) next[k] = v;
        setStatsByRange(next);
      })
      .finally(() => setStatsLoading(false));
  }, []);

  const chart = useMemo(() => {
    if (daily.length === 0) return null;
    // Aggregate against dailyRange (the range `daily` was fetched for), not
    // the current `range`. During a range switch the chart keeps showing the
    // previous range's correct view; when the new fetch lands, dailyRange and
    // range realign and the chart updates cleanly.
    const { points, header } = aggregateForChart(daily, dailyRange, mode);
    if (points.length === 0) return null;
    const path = renderBarChartToFile(points, {
      valueFormatter: (n) =>
        n > 0 ? (mode === "api" ? formatCost(n) : formatTokens(n)) : "",
    });
    const total = points.reduce((s, p) => s + p.value, 0);
    return { path, header, total };
  }, [daily, dailyRange, mode]);

  const stats = statsByRange[range];

  const markdown = buildMarkdown({
    range,
    stats,
    chart,
    statsLoading,
    usage,
    usageError,
    mode,
  });

  return (
    <Detail
      isLoading={statsLoading}
      markdown={markdown}
      navigationTitle={`Usage: ${RANGE_LABEL[range]}`}
      metadata={<Sidebar stats={stats} usage={usage} mode={mode} />}
      actions={
        <ActionPanel>
          {mode !== "api" && (
            <ActionPanel.Section title="Subscription">
              <Action
                title="Refresh Limits"
                icon={Icon.ArrowClockwise}
                shortcut={{ modifiers: ["cmd"], key: "r" }}
                onAction={() => loadUsage(true)}
              />
            </ActionPanel.Section>
          )}
          <ActionPanel.Section title="Time Range">
            <Action
              title="Today"
              icon={range === "today" ? Icon.CheckCircle : Icon.Calendar}
              onAction={() => setRange("today")}
            />
            <Action
              title="This Week"
              icon={range === "week" ? Icon.CheckCircle : Icon.Calendar}
              onAction={() => setRange("week")}
            />
            <Action
              title="This Month"
              icon={range === "month" ? Icon.CheckCircle : Icon.Calendar}
              onAction={() => setRange("month")}
            />
            <Action
              title="All Time"
              icon={range === "all" ? Icon.CheckCircle : Icon.Calendar}
              onAction={() => setRange("all")}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

function Sidebar({
  stats,
  usage,
  mode,
}: {
  stats: UsageStats | undefined;
  usage: SubscriptionUsage | null;
  mode: UsageMode;
}) {
  const isApi = mode === "api";
  // Limits resolve from one HTTP call; the local stats need a full JSONL scan.
  // Render the limits alone rather than holding them behind the slower half.
  if (!stats) {
    return (
      <Detail.Metadata>
        {!isApi &&
          usage?.buckets.map((bucket) => (
            <Detail.Metadata.Label
              key={bucket.key}
              title={bucket.label}
              text={formatPercent(bucket.percent)}
              icon={{
                source: Icon.CircleProgress100,
                tintColor: percentColor(bucket.percent),
              }}
            />
          ))}
        <Detail.Metadata.Label title="Loading usage..." text="" />
      </Detail.Metadata>
    );
  }

  const topProjects = Object.entries(stats.sessionsByProject)
    .sort(([, a], [, b]) => (isApi ? b.cost - a.cost : b.tokens - a.tokens))
    .slice(0, 5);

  // topSessions is pre-sorted by tokens; re-rank when costs are on display.
  const topSession = isApi
    ? [...stats.topSessions].sort((a, b) => b.cost - a.cost)[0]
    : stats.topSessions[0];

  return (
    <Detail.Metadata>
      {!isApi && usage && usage.buckets.length > 0 && (
        <>
          {usage.buckets.map((bucket) => (
            <Detail.Metadata.Label
              key={bucket.key}
              title={bucket.label}
              text={
                bucket.resetsAt
                  ? `${formatPercent(bucket.percent)} · resets ${formatReset(bucket.resetsAt)}`
                  : formatPercent(bucket.percent)
              }
              icon={{
                source: Icon.CircleProgress100,
                tintColor: percentColor(bucket.percent),
              }}
            />
          ))}
          <Detail.Metadata.Separator />
        </>
      )}

      <Detail.Metadata.Label
        title={isApi ? "API-Equivalent" : "Tokens"}
        text={
          isApi ? formatCost(stats.totalCost) : formatTokens(stats.totalTokens)
        }
        icon={{ source: Icon.Coin, tintColor: Color.Yellow }}
      />
      <Detail.Metadata.Label
        title="Sessions"
        text={stats.totalSessions.toString()}
        icon={Icon.Message}
      />
      <Detail.Metadata.Label
        title="Avg / Session"
        text={
          isApi
            ? formatCost(
                stats.totalSessions > 0
                  ? stats.totalCost / stats.totalSessions
                  : 0,
              )
            : formatTokens(
                stats.totalSessions > 0
                  ? Math.round(stats.totalTokens / stats.totalSessions)
                  : 0,
              )
        }
      />

      <Detail.Metadata.Separator />

      <Detail.Metadata.Label
        title="Input Tokens"
        text={formatTokens(stats.totalInputTokens)}
      />
      <Detail.Metadata.Label
        title="Output Tokens"
        text={formatTokens(stats.totalOutputTokens)}
      />
      <Detail.Metadata.Label
        title="Cache Read"
        text={formatTokens(stats.totalCacheReadTokens)}
      />
      <Detail.Metadata.Label
        title="Cache Write"
        text={formatTokens(stats.totalCacheCreationTokens)}
      />

      {topProjects.length > 0 && (
        <>
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="Top Projects">
            {topProjects.map(([project, data]) => (
              <Detail.Metadata.TagList.Item
                key={project}
                text={`${project} (${isApi ? formatCost(data.cost) : formatTokens(data.tokens)})`}
                color={Color.Blue}
              />
            ))}
          </Detail.Metadata.TagList>
        </>
      )}

      {topSession && (
        <>
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title={isApi ? "Most Expensive Session" : "Largest Session"}
            text={`${isApi ? formatCost(topSession.cost) : formatTokens(topSession.tokens)} in ${topSession.projectName}`}
            icon={{ source: Icon.BarChart, tintColor: Color.Orange }}
          />
        </>
      )}
    </Detail.Metadata>
  );
}

// How many days of underlying daily data to fetch per range. The chart later
// aggregates into the right bin size so the X axis stays readable.
function daysForRange(range: RangeKey): number {
  switch (range) {
    case "today":
    case "week":
      return 7;
    case "month":
      return 30;
    case "all":
      return 365;
  }
}

// Bucket daily data into chart points sized for the selected range:
//   today/week => one bar per day
//   month      => one bar per 7-day chunk (4-5 weekly bars)
//   all        => one bar per calendar month (up to 12 most recent)
// Returns chart points and a header label that describes the binning.
function aggregateForChart(
  daily: DailyStats[],
  range: RangeKey,
  mode: UsageMode,
): { points: { label: string; value: number }[]; header: string } {
  const valueOf = (d: DailyStats) => (mode === "api" ? d.cost : d.tokens);
  const unit = mode === "api" ? "Cost" : "Tokens";
  if (range === "month") {
    const points: { label: string; value: number }[] = [];
    for (let i = 0; i < daily.length; i += 7) {
      const chunk = daily.slice(i, i + 7);
      const total = chunk.reduce((s, d) => s + valueOf(d), 0);
      const start = chunk[0].date.slice(5);
      const end = chunk[chunk.length - 1].date.slice(5);
      points.push({
        label: chunk.length > 1 ? `${start} to ${end}` : start,
        value: total,
      });
    }
    return { points, header: `Weekly ${unit} (Last 30 Days)` };
  }

  if (range === "all") {
    const monthMap = new Map<string, number>();
    for (const d of daily) {
      const monthKey = d.date.slice(0, 7); // YYYY-MM
      monthMap.set(monthKey, (monthMap.get(monthKey) || 0) + valueOf(d));
    }
    const sorted = Array.from(monthMap.entries()).sort();
    const recent = sorted.slice(-12);
    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const points = recent.map(([key, value]) => {
      const [year, month] = key.split("-");
      return {
        label: `${monthNames[parseInt(month, 10) - 1]} ${year.slice(2)}`,
        value,
      };
    });
    const header =
      recent.length > 0
        ? `Monthly ${unit} (Last ${recent.length} Months)`
        : `Monthly ${unit}`;
    return { points, header };
  }

  // today / week: one bar per day, MM-DD label.
  return {
    points: daily.map((d) => ({ label: d.date.slice(5), value: valueOf(d) })),
    header: `Daily ${unit} (Last ${daily.length} Days)`,
  };
}

function percentColor(percent: number): Color {
  if (percent >= 90) return Color.Red;
  if (percent >= 70) return Color.Orange;
  return Color.Green;
}

const NEAR_LIMIT_PERCENT = 80;

function anyWindowNearLimit(usage: SubscriptionUsage): boolean {
  return usage.buckets.some((b) => b.percent >= NEAR_LIMIT_PERCENT);
}

function formatMoney(amount: number, currency: string): string {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${amount.toFixed(2)}`;
}

// Live subscription limits, rendered above the historical stats. This is the
// only section that reflects actual subscription billing; everything below it
// prices local token counts at API list rates.
function buildUsageSection(
  usage: SubscriptionUsage | null,
  usageError: string | null,
): string {
  if (usageError) {
    return `## Subscription Limits\n\n_${usageError}_\n\n`;
  }
  if (!usage) {
    return `## Subscription Limits\n\n_Loading limits..._\n\n`;
  }
  if (usage.buckets.length === 0 && !usage.extraUsage?.isEnabled) {
    return "";
  }

  let md = `## Subscription Limits\n\n`;
  if (usage.buckets.length > 0) {
    md += `| Window | Used | Resets |\n`;
    md += `|--------|------|--------|\n`;
    for (const bucket of usage.buckets) {
      const reset = bucket.resetsAt ? formatReset(bucket.resetsAt) : "—";
      md += `| ${escapeMd(bucket.label)} | \`${usageBar(bucket.percent)}\` ${formatPercent(bucket.percent)} | ${reset} |\n`;
    }
    md += `\n`;
  }

  // The only dollar figure in the extension, and only once it is real money.
  // At zero spend the line says nothing useful, so it stays hidden.
  const extra = usage.extraUsage;
  const spent = extra?.usedCredits ?? 0;
  if (extra?.isEnabled && spent > 0) {
    const currency = extra.currency ?? "USD";
    const cap =
      extra.monthlyLimit !== null
        ? ` of ${formatMoney(extra.monthlyLimit, currency)} cap`
        : "";
    md += `⚠️ **Extra usage: ${formatMoney(spent, currency)}${cap}** — billed on top of the subscription.\n\n`;
  } else if (extra && !extra.isEnabled && anyWindowNearLimit(usage)) {
    md += `_Extra usage is off, so work stops when a window above hits 100%._\n\n`;
  }

  return md;
}

function buildMarkdown(args: {
  range: RangeKey;
  stats: UsageStats | undefined;
  chart: { path: string; header: string; total: number } | null;
  statsLoading: boolean;
  usage: SubscriptionUsage | null;
  usageError: string | null;
  mode: UsageMode;
}): string {
  const { range, stats, chart, statsLoading, usage, usageError, mode } = args;
  const isApi = mode === "api";

  let md = `# Claude Code Usage: ${RANGE_LABEL[range]}\n\n`;
  // API mode is explicitly a cost-estimate view; the live limits section has no
  // dollar equivalent, so it is omitted rather than shown in mixed units.
  if (!isApi) md += buildUsageSection(usage, usageError);

  // Range-adapted chart. The aggregator picks the right granularity (daily,
  // weekly, or monthly) so the X-axis stays readable regardless of window.
  if (chart) {
    md += `## ${chart.header}\n\n`;
    md += `![${chart.header}](file://${chart.path}?raycast-width=820)\n\n`;
    md += isApi
      ? `_Total: **${formatCost(chart.total)}** at API list rates — an estimate, not a bill._\n\n`
      : `_Total: **${formatTokens(chart.total)}** tokens (input + output)._\n\n`;
  }

  if (!stats) {
    md += statsLoading
      ? `_Loading ${RANGE_LABEL[range]}..._\n`
      : `_No data for ${RANGE_LABEL[range]}._\n`;
    return md;
  }

  // Project breakdown for the selected range.
  const projectKeys = Object.keys(stats.sessionsByProject);
  if (projectKeys.length > 0) {
    md += `## ${isApi ? "Cost" : "Usage"} by Project (${RANGE_LABEL[range]})\n\n`;
    md += generateProjectTable(stats.sessionsByProject, mode);
    md += `\n`;
  }

  // Top sessions for the selected range.
  if (stats.topSessions.length > 0) {
    md += `## Top Sessions (${RANGE_LABEL[range]})\n\n`;
    md += `| # | Project | First Message | ${isApi ? "Cost" : "Tokens"} |\n`;
    md += `|--:|---------|---------------|-------:|\n`;
    const ranked = isApi
      ? [...stats.topSessions].sort((a, b) => b.cost - a.cost)
      : stats.topSessions;
    ranked.slice(0, 10).forEach((s, i) => {
      const preview = sessionPreview(s);
      md += `| ${i + 1} | ${escapeMd(s.projectName)} | ${escapeMd(preview)} | ${isApi ? formatCost(s.cost) : formatTokens(s.tokens)} |\n`;
    });
    md += `\n`;
  }

  md += `\n---\n\n`;
  md += isApi
    ? `_Tip: ⌘K to switch range. Figures are API list-rate estimates — switch to Subscription usage in preferences (⌘,) for real limits._\n`
    : `_Tip: ⌘K to switch range, ⌘R to refresh limits. Token counts are input + output; cache totals are in the sidebar._\n`;

  return md;
}

function sessionPreview(s: TopSessionSummary): string {
  const text = s.firstMessage || "(no message)";
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

// Markdown table cells get broken by raw `|` and `\n`. Replace newlines and
// escape pipes so the table still renders.
function escapeMd(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
