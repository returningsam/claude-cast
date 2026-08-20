import { Cache, getPreferenceValues } from "@raycast/api";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Live subscription limit utilization, as shown by Claude Code's `/usage`.
 *
 * This is the counterpart to usage-stats.ts: that module reads local session
 * JSONL and prices tokens at published *API list rates*, which is what the
 * usage would have cost pay-as-you-go — not what a subscriber is billed. This
 * module reports what a subscription actually meters: percent of the rolling
 * 5-hour and 7-day windows consumed.
 *
 * Endpoint is undocumented and carries no stability guarantee; every field is
 * treated as optional and a parse failure degrades to a hidden section rather
 * than breaking the dashboard.
 */
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const ANTHROPIC_VERSION = "2023-06-01";

const REQUEST_TIMEOUT_MS = 8000;
const CACHE_KEY = "subscription-usage-v1";
const CACHE_TTL_MS = 60_000;

const cache = new Cache();

export type UsageErrorReason =
  | "no-token"
  | "unauthorized"
  | "network"
  | "bad-response";

export class SubscriptionUsageError extends Error {
  constructor(
    readonly reason: UsageErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "SubscriptionUsageError";
  }
}

export interface UsageBucket {
  key: string;
  label: string;
  /** 0-100. */
  percent: number;
  resetsAt: Date | null;
}

export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  percent: number | null;
  currency: string | null;
  disabledReason: string | null;
}

export interface SubscriptionUsage {
  buckets: UsageBucket[];
  extraUsage: ExtraUsage | null;
  fetchedAt: number;
}

/**
 * Bucket keys the API is known to return, in the order `/usage` presents them.
 * Unknown keys still render (humanized) so a newly-added window isn't silently
 * dropped; only buckets with a non-null utilization are shown.
 */
const BUCKET_LABELS: Record<string, string> = {
  five_hour: "Session (5h)",
  seven_day: "Weekly (all models)",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
  seven_day_oauth_apps: "Weekly (OAuth apps)",
  seven_day_overage_included: "Weekly (incl. overage)",
};

const BUCKET_ORDER = Object.keys(BUCKET_LABELS);

/**
 * Resolves an OAuth token, cheapest source first:
 *   1. the extension's `oauthToken` preference
 *   2. CLAUDE_CODE_OAUTH_TOKEN in the environment
 *   3. the login keychain entry Claude Code itself writes
 *
 * Step 3 shells out to `security`, which can raise a one-time macOS keychain
 * prompt the first time Raycast asks for the item. Set the preference to skip
 * it entirely.
 */
async function resolveToken(): Promise<string> {
  const preferences = getPreferenceValues<Preferences>();
  if (preferences.oauthToken) return preferences.oauthToken;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;

  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: REQUEST_TIMEOUT_MS },
    );
    const token = JSON.parse(stdout)?.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.length > 0) return token;
  } catch {
    // Fall through to the actionable error below.
  }

  throw new SubscriptionUsageError(
    "no-token",
    "No OAuth token. Run `claude setup-token` and paste the result into the extension's OAuth Token preference.",
  );
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function humanize(key: string): string {
  return key
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The API reports utilization already scaled to 0-100 (the header-derived path
 * in Claude Code multiplies its 0-1 values by 100 to match this shape). Values
 * are clamped rather than trusted, so a scale change upstream degrades to a
 * full bar instead of a nonsense one.
 */
function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function parseBuckets(payload: Record<string, unknown>): UsageBucket[] {
  // `limits` is the richer representation when present: it carries display
  // names for the model/surface a window applies to.
  const limits = payload.limits;
  if (Array.isArray(limits) && limits.length > 0) {
    const parsed: UsageBucket[] = [];
    for (const raw of limits) {
      if (!raw || typeof raw !== "object") continue;
      const limit = raw as Record<string, unknown>;
      const percent = toNumber(limit.percent);
      if (percent === null) continue;
      const scope = (limit.scope ?? {}) as Record<string, unknown>;
      const model = (scope.model ?? {}) as Record<string, unknown>;
      const surface = (scope.surface ?? {}) as Record<string, unknown>;
      const scopeName =
        (typeof model.display_name === "string" && model.display_name) ||
        (typeof surface.display_name === "string" && surface.display_name) ||
        null;
      const group = typeof limit.group === "string" ? limit.group : "";
      const kind = typeof limit.kind === "string" ? limit.kind : "";
      const base = BUCKET_LABELS[group] ?? BUCKET_LABELS[kind];
      const label = base
        ? scopeName
          ? `${base} — ${scopeName}`
          : base
        : scopeName || humanize(group || kind || "Limit");
      parsed.push({
        key: `${kind}:${group}:${scopeName ?? ""}`,
        label,
        percent: clampPercent(percent),
        resetsAt: toDate(limit.resets_at),
      });
    }
    if (parsed.length > 0) return parsed;
  }

  // Fall back to the named top-level windows.
  const keys = Object.keys(payload).filter((key) => {
    const value = payload[key];
    return (
      value !== null &&
      typeof value === "object" &&
      "utilization" in (value as Record<string, unknown>)
    );
  });
  keys.sort((a, b) => {
    const ai = BUCKET_ORDER.indexOf(a);
    const bi = BUCKET_ORDER.indexOf(b);
    return (
      (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) -
      (bi === -1 ? Number.MAX_SAFE_INTEGER : bi)
    );
  });

  const buckets: UsageBucket[] = [];
  for (const key of keys) {
    const value = payload[key] as Record<string, unknown>;
    const percent = toNumber(value.utilization);
    if (percent === null) continue;
    buckets.push({
      key,
      label: BUCKET_LABELS[key] ?? humanize(key),
      percent: clampPercent(percent),
      resetsAt: toDate(value.resets_at),
    });
  }
  return buckets;
}

function parseExtraUsage(payload: Record<string, unknown>): ExtraUsage | null {
  const raw = payload.extra_usage;
  if (!raw || typeof raw !== "object") return null;
  const extra = raw as Record<string, unknown>;
  return {
    isEnabled: extra.is_enabled === true,
    monthlyLimit: toNumber(extra.monthly_limit),
    usedCredits: toNumber(extra.used_credits),
    percent: toNumber(extra.utilization),
    currency: typeof extra.currency === "string" ? extra.currency : null,
    disabledReason:
      typeof extra.disabled_reason === "string" ? extra.disabled_reason : null,
  };
}

/**
 * Fetches live limit utilization. Results are cached for CACHE_TTL_MS so
 * reopening the dashboard or switching ranges doesn't re-hit the API; pass
 * `force` to bypass (wired to the manual Refresh action).
 */
export async function getSubscriptionUsage(
  force = false,
): Promise<SubscriptionUsage> {
  if (!force) {
    const cached = cache.get(CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as SubscriptionUsage;
        if (Date.now() - parsed.fetchedAt < CACHE_TTL_MS) {
          return {
            ...parsed,
            buckets: parsed.buckets.map((bucket) => ({
              ...bucket,
              resetsAt: bucket.resetsAt ? new Date(bucket.resetsAt) : null,
            })),
          };
        }
      } catch {
        // Corrupt cache entry: fall through and refetch.
      }
    }
  }

  const token = await resolveToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      signal: controller.signal,
    });
  } catch (error) {
    throw new SubscriptionUsageError(
      "network",
      `Could not reach the usage endpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new SubscriptionUsageError(
      "unauthorized",
      "Token rejected. Run `claude setup-token` for a fresh one.",
    );
  }
  if (!response.ok) {
    throw new SubscriptionUsageError(
      "bad-response",
      `Usage endpoint returned ${response.status}.`,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new SubscriptionUsageError(
      "bad-response",
      "Usage endpoint returned a non-JSON body.",
    );
  }

  const usage: SubscriptionUsage = {
    buckets: parseBuckets(payload),
    extraUsage: parseExtraUsage(payload),
    fetchedAt: Date.now(),
  };

  cache.set(CACHE_KEY, JSON.stringify(usage));
  return usage;
}

/** Renders a 20-cell bar for markdown. */
export function usageBar(percent: number, width = 20): string {
  const filled = Math.round((clampPercent(percent) / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** "in 3h 12m" / "in 4d 2h" / "now" — relative reset time for a window. */
export function formatReset(resetsAt: Date | null): string {
  if (!resetsAt) return "";
  const deltaMs = resetsAt.getTime() - Date.now();
  if (deltaMs <= 0) return "now";
  const minutes = Math.floor(deltaMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `in ${days}d ${hours % 24}h`;
  if (hours > 0) return `in ${hours}h ${minutes % 60}m`;
  return `in ${minutes}m`;
}

export function formatPercent(percent: number): string {
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}
