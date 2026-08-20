import { LocalStorage } from "@raycast/api";
import {
  listAllSessions,
  streamSessionUsage,
  SessionMetadata,
} from "./session-parser";
import { calculateMessageCost, formatCost } from "./pricing";
import { UsageMode } from "./usage-mode";

/**
 * Headline "tokens" throughout this module means input + output — the
 * generation work. Cache reads routinely run 10-50x that and would otherwise
 * dominate every ranking, turning "heaviest project" into "longest-running
 * project". The cache figures stay available as separate totals.
 */
function workTokens(usage: {
  inputTokens: number;
  outputTokens: number;
}): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * Lightweight projection of a session, used for "Top Sessions" lists in
 * UsageStats. Avoids retaining the full SessionMetadata reference inside the
 * cached stats object (which previously aliased the same memory across the
 * in-memory cache and React state).
 */
export interface TopSessionSummary {
  id: string;
  projectName: string;
  firstMessage: string;
  tokens: number;
  /** API list-rate estimate; only meaningful in "api" display mode. */
  cost: number;
}

export interface UsageStats {
  totalSessions: number;
  /** input + output; see workTokens. */
  totalTokens: number;
  /** API list-rate estimate; only meaningful in "api" display mode. */
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  sessionsByProject: Record<
    string,
    { count: number; tokens: number; cost: number }
  >;
  topSessions: TopSessionSummary[];
}

export interface DailyStats {
  date: string;
  sessions: number;
  tokens: number;
  /** API list-rate estimate; only meaningful in "api" display mode. */
  cost: number;
}

// Cache keys are versioned against the shape of UsageStats. The v2/v1 pair held
// `cost` fields; reusing those keys would deserialize stale objects whose
// `tokens` are undefined and render as NaN until the TTL expired.
const STATS_CACHE_KEY = "claudecast-stats-v4";
const STATS_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const TODAY_STATS_LOCALSTORAGE_KEY = "claudecast-today-stats-v3";

// In-memory cache for today's stats to prevent repeated disk reads
// This is especially important for menu bar monitors that refresh frequently
let todayStatsCache: {
  stats: UsageStats;
  timestamp: number;
  date: string;
} | null = null;
const TODAY_STATS_CACHE_TTL = 30 * 1000; // 30 seconds

interface CachedStats {
  stats: UsageStats;
  timestamp: number;
}

interface PersistedTodayStats {
  stats: UsageStats;
  timestamp: number;
  date: string;
}

/**
 * Get usage statistics for today.
 * Two-tier cache: in-memory (fast, lost on worker restart) + LocalStorage
 * (persists across Raycast menu-bar cold starts so the 30s background tick
 * doesn't pay full disk cost on every refresh).
 */
export async function getTodayStats(): Promise<UsageStats> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split("T")[0];

  // Tier 1: in-memory cache.
  if (
    todayStatsCache &&
    todayStatsCache.date === todayStr &&
    Date.now() - todayStatsCache.timestamp < TODAY_STATS_CACHE_TTL
  ) {
    return todayStatsCache.stats;
  }

  // Tier 2: LocalStorage. Survives worker restarts.
  try {
    const persisted = await LocalStorage.getItem<string>(
      TODAY_STATS_LOCALSTORAGE_KEY,
    );
    if (persisted) {
      const parsed: PersistedTodayStats = JSON.parse(persisted);
      if (
        parsed.date === todayStr &&
        Date.now() - parsed.timestamp < TODAY_STATS_CACHE_TTL
      ) {
        todayStatsCache = parsed;
        return parsed.stats;
      }
    }
  } catch {
    // ignore parse / storage errors and fall through to recompute
  }

  // Compute fresh.
  const todaySessions = await listAllSessions({ afterDate: today });
  const stats = await calculateStatsWithUsage(todaySessions, today);

  todayStatsCache = { stats, timestamp: Date.now(), date: todayStr };
  try {
    await LocalStorage.setItem(
      TODAY_STATS_LOCALSTORAGE_KEY,
      JSON.stringify(todayStatsCache),
    );
  } catch {
    // ignore storage errors
  }

  return stats;
}

/**
 * Get usage statistics for this week
 */
export async function getWeekStats(): Promise<UsageStats> {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  weekAgo.setHours(0, 0, 0, 0);

  const weekSessions = await listAllSessions({ afterDate: weekAgo });
  return calculateStatsWithUsage(weekSessions, weekAgo);
}

/**
 * Get usage statistics for this month
 */
export async function getMonthStats(): Promise<UsageStats> {
  const monthAgo = new Date();
  monthAgo.setMonth(monthAgo.getMonth() - 1);
  monthAgo.setHours(0, 0, 0, 0);

  const monthSessions = await listAllSessions({ afterDate: monthAgo });
  return calculateStatsWithUsage(monthSessions, monthAgo);
}

/**
 * Get all-time usage statistics (cached for 1 hour).
 * No truncation: bounded streaming plus per-message processing keeps memory low
 * even across thousands of sessions.
 */
export async function getAllTimeStats(): Promise<UsageStats> {
  const cached = await LocalStorage.getItem<string>(STATS_CACHE_KEY);
  if (cached) {
    const cachedStats: CachedStats = JSON.parse(cached);
    if (Date.now() - cachedStats.timestamp < STATS_CACHE_TTL) {
      return cachedStats.stats;
    }
  }

  const allSessions = await listAllSessions();
  const stats = await calculateStatsWithUsage(allSessions);

  await LocalStorage.setItem(
    STATS_CACHE_KEY,
    JSON.stringify({
      stats,
      timestamp: Date.now(),
    }),
  );

  return stats;
}

/**
 * Invalidate the stats cache.
 * Call this after creating/deleting sessions to ensure fresh data.
 */
export async function invalidateStatsCache(): Promise<void> {
  await LocalStorage.removeItem(STATS_CACHE_KEY);
  await LocalStorage.removeItem(TODAY_STATS_LOCALSTORAGE_KEY);
  todayStatsCache = null;
}

/**
 * Get daily stats for the last N days.
 * Buckets tokens by per-entry timestamp (not file mtime), so a multi-day
 * session gets its usage attributed to each day it was actually used on.
 */
export async function getDailyStats(days: number = 7): Promise<DailyStats[]> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days + 1);
  startDate.setHours(0, 0, 0, 0);

  const allSessions = await listAllSessions({ afterDate: startDate });

  // Per-day map: dateStr → { unique session ids, summed tokens }.
  const dailyMap = new Map<
    string,
    { sessions: Set<string>; tokens: number; cost: number }
  >();

  for (const session of allSessions) {
    const usage = await streamSessionUsage(session.filePath, startDate, {
      bucketByDay: true,
    });
    if (!usage.dailyByDate) continue;
    for (const [dateStr, msgs] of usage.dailyByDate) {
      let entry = dailyMap.get(dateStr);
      if (!entry) {
        entry = { sessions: new Set<string>(), tokens: 0, cost: 0 };
        dailyMap.set(dateStr, entry);
      }
      entry.sessions.add(session.id);
      for (const m of msgs) {
        entry.tokens += workTokens(m);
        entry.cost += calculateMessageCost(m);
      }
    }
  }

  const dailyStats: DailyStats[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];
    const entry = dailyMap.get(dateStr);
    dailyStats.push({
      date: dateStr,
      sessions: entry?.sessions.size || 0,
      tokens: entry?.tokens || 0,
      cost: entry?.cost || 0,
    });
  }

  return dailyStats.reverse();
}

/**
 * Stream each session and aggregate token totals.
 * Does NOT mutate the input session array; per-session tokens are tracked in a
 * local Map and the lightweight TopSessionSummary projection is used for the
 * returned topSessions list.
 *
 * afterDate filters tokens to entries within the time range.
 */
async function calculateStatsWithUsage(
  sessions: SessionMetadata[],
  afterDate?: Date,
): Promise<UsageStats> {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCostCents = 0;
  const sessionsByProject: Record<
    string,
    { count: number; tokens: number; cost: number }
  > = {};
  const projectCostCents: Record<string, number> = {};
  const sessionTokens = new Map<string, number>();
  const sessionCosts = new Map<string, number>();

  for (const session of sessions) {
    const usage = await streamSessionUsage(session.filePath, afterDate);
    const tokens = workTokens(usage);
    sessionTokens.set(session.id, tokens);

    // Tier-aware: sum per-message costs rather than pricing a session rollup.
    // Accumulated in integer hundredths of a cent to avoid float drift across
    // thousands of sessions.
    let cost = 0;
    for (const m of usage.messages) {
      cost += calculateMessageCost(m);
    }
    sessionCosts.set(session.id, cost);
    const costCents = Math.round(cost * 10000);
    totalCostCents += costCents;

    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;
    totalCacheReadTokens += usage.cacheReadTokens;
    totalCacheCreationTokens += usage.cacheCreationTokens;

    if (!sessionsByProject[session.projectName]) {
      sessionsByProject[session.projectName] = { count: 0, tokens: 0, cost: 0 };
      projectCostCents[session.projectName] = 0;
    }
    sessionsByProject[session.projectName].count++;
    sessionsByProject[session.projectName].tokens += tokens;
    projectCostCents[session.projectName] += costCents;
  }

  for (const projectName of Object.keys(sessionsByProject)) {
    sessionsByProject[projectName].cost = projectCostCents[projectName] / 10000;
  }

  // Lightweight projection only. Never retain full SessionMetadata refs
  // inside the cached UsageStats (would alias the same memory across calls).
  const topSessions: TopSessionSummary[] = sessions
    .map((s) => ({
      id: s.id,
      projectName: s.projectName,
      firstMessage: s.firstMessage,
      tokens: sessionTokens.get(s.id) ?? 0,
      cost: sessionCosts.get(s.id) ?? 0,
    }))
    .filter((s) => s.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 10);

  return {
    totalSessions: sessions.length,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCost: totalCostCents / 10000,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    sessionsByProject,
    topSessions,
  };
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return `${count}`;
}

/**
 * Generate project breakdown table
 */
export function generateProjectTable(
  sessionsByProject: Record<
    string,
    { count: number; tokens: number; cost: number }
  >,
  mode: UsageMode = "subscription",
): string {
  const isApi = mode === "api";
  const sorted = Object.entries(sessionsByProject)
    .sort(([, a], [, b]) => (isApi ? b.cost - a.cost : b.tokens - a.tokens))
    .slice(0, 10);

  if (sorted.length === 0) {
    return "No project data available.";
  }

  let table = `| Project | Sessions | ${isApi ? "Cost" : "Tokens"} |\n`;
  table += "|---------|----------|-------:|\n";

  for (const [project, stats] of sorted) {
    const value = isApi ? formatCost(stats.cost) : formatTokens(stats.tokens);
    table += `| ${project} | ${stats.count} | ${value} |\n`;
  }

  return table;
}

/**
 * Check if there's an active Claude Code process
 */
export async function isClaudeActive(): Promise<boolean> {
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execPromise = promisify(exec);

    const { stdout } = await execPromise("pgrep -x claude || true");
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
