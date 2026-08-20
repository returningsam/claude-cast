import {
  MenuBarExtra,
  Icon,
  launchCommand,
  LaunchType,
  Color,
  environment,
  openCommandPreferences,
  getPreferenceValues,
} from "@raycast/api";
import { useState, useEffect } from "react";
import {
  getTodayStats,
  isClaudeActive,
  formatTokens,
  UsageStats,
} from "./lib/usage-stats";
import { getMostRecentProject } from "./lib/project-discovery";
import {
  formatPercent,
  formatReset,
  getSubscriptionUsage,
  SubscriptionUsage,
} from "./lib/subscription-usage";
import { formatCost } from "./lib/pricing";
import { getUsageMode } from "./lib/usage-mode";

function percentColor(percent: number): Color {
  if (percent >= 90) return Color.Red;
  if (percent >= 70) return Color.Orange;
  return Color.Green;
}

export default function MenuBarMonitor() {
  const [isLoading, setIsLoading] = useState(true);
  const [isActive, setIsActive] = useState(false);
  const [todayStats, setTodayStats] = useState<UsageStats | null>(null);
  const [recentProject, setRecentProject] = useState<string | null>(null);
  const [usage, setUsage] = useState<SubscriptionUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const isBackground = environment.launchType === LaunchType.Background;

      // Cheap signals always: process check + LocalStorage-cached today stats.
      // Skip the full-history "last project" scan on background ticks; only run
      // it when the user actually opens the menu.
      const fetches: Promise<unknown>[] = [isClaudeActive(), getTodayStats()];
      if (!isBackground) {
        fetches.push(getMostRecentProject());
      }

      const results = await Promise.all(fetches);
      setIsActive(results[0] as boolean);
      setTodayStats(results[1] as UsageStats);
      if (!isBackground) {
        const recent = results[2] as { name?: string } | null;
        setRecentProject(recent?.name || null);
      }

      // Limits drive the menu bar title in subscription mode, so they are
      // fetched even on background ticks. The 60s cache inside
      // getSubscriptionUsage keeps this to roughly one request per minute
      // regardless of how often the tick fires. A failure here must not blank
      // the whole menu bar, so it is caught separately from the local signals
      // above. API mode never needs the network.
      if (getUsageMode() === "api") {
        setUsage(null);
      } else {
        try {
          setUsage(await getSubscriptionUsage());
        } catch {
          setUsage(null);
        }
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const preferences = getPreferenceValues<Preferences.MenuBarMonitor>();

  const getIcon = () => {
    if (error) {
      return { source: Icon.ExclamationMark, tintColor: Color.Red };
    }
    return "command-icon.png";
  };

  const isApi = getUsageMode() === "api";

  // The 5h window is the one that actually gates work, so it gets the title.
  const fiveHour = usage?.buckets.find(
    (b) => b.key === "five_hour" || b.key.includes("five_hour"),
  );

  const getTitle = () => {
    if (isLoading) return undefined;
    if (!preferences.showUsageInMenuBar) return undefined;
    if (isApi) {
      return todayStats && todayStats.totalCost > 0
        ? formatCost(todayStats.totalCost)
        : undefined;
    }
    if (fiveHour) return formatPercent(fiveHour.percent);
    // Limits unavailable (no token / offline): fall back to local token counts
    // rather than showing nothing.
    if (todayStats && todayStats.totalTokens > 0) {
      return formatTokens(todayStats.totalTokens);
    }
    return undefined;
  };

  const tooltip = fiveHour
    ? `5h window: ${formatPercent(fiveHour.percent)} used${
        fiveHour.resetsAt ? `, resets ${formatReset(fiveHour.resetsAt)}` : ""
      }`
    : isActive
      ? "Claude Code is running"
      : `Today: ${todayStats?.totalSessions || 0} sessions`;

  return (
    <MenuBarExtra
      icon={getIcon()}
      title={getTitle()}
      tooltip={tooltip}
      isLoading={isLoading}
    >
      {/* Status Section */}
      <MenuBarExtra.Section title="Status">
        <MenuBarExtra.Item
          title={isActive ? "Claude Code is running" : "Idle"}
          icon={
            isActive
              ? { source: Icon.CircleFilled, tintColor: Color.Green }
              : Icon.Circle
          }
        />
        {recentProject && (
          <MenuBarExtra.Item
            title={`Last project: ${recentProject}`}
            icon={Icon.Folder}
          />
        )}
      </MenuBarExtra.Section>

      {/* Subscription Limits */}
      {usage && usage.buckets.length > 0 && (
        <MenuBarExtra.Section title="Limits">
          {usage.buckets.map((bucket) => (
            <MenuBarExtra.Item
              key={bucket.key}
              title={`${bucket.label}: ${formatPercent(bucket.percent)}`}
              subtitle={
                bucket.resetsAt ? `resets ${formatReset(bucket.resetsAt)}` : ""
              }
              icon={{
                source: Icon.CircleProgress100,
                tintColor: percentColor(bucket.percent),
              }}
            />
          ))}
        </MenuBarExtra.Section>
      )}

      {/* Today's Stats */}
      <MenuBarExtra.Section title="Today">
        <MenuBarExtra.Item
          title={`Sessions: ${todayStats?.totalSessions || 0}`}
          icon={Icon.Message}
        />
        <MenuBarExtra.Item
          title={
            isApi
              ? `Cost: ${formatCost(todayStats?.totalCost || 0)}`
              : `Tokens: ${formatTokens(todayStats?.totalTokens || 0)}`
          }
          icon={Icon.Coin}
        />
      </MenuBarExtra.Section>

      {/* Quick Actions */}
      <MenuBarExtra.Section title="Quick Actions">
        <MenuBarExtra.Item
          title="Ask Claude Code"
          icon={Icon.Message}
          shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          onAction={() => {
            launchCommand({
              name: "ask-claude",
              type: LaunchType.UserInitiated,
            });
          }}
        />
        <MenuBarExtra.Item
          title="Quick Continue"
          icon={Icon.ArrowRight}
          shortcut={{ modifiers: ["cmd", "opt"], key: "r" }}
          onAction={() => {
            launchCommand({
              name: "quick-continue",
              type: LaunchType.UserInitiated,
            });
          }}
        />
        <MenuBarExtra.Item
          title="Browse Sessions"
          icon={Icon.List}
          shortcut={{ modifiers: ["cmd", "opt"], key: "s" }}
          onAction={() => {
            launchCommand({
              name: "browse-sessions",
              type: LaunchType.UserInitiated,
            });
          }}
        />
        <MenuBarExtra.Item
          title="Launch Project"
          icon={Icon.Folder}
          shortcut={{ modifiers: ["cmd", "opt"], key: "l" }}
          onAction={() => {
            launchCommand({
              name: "launch-project",
              type: LaunchType.UserInitiated,
            });
          }}
        />
      </MenuBarExtra.Section>

      {/* More */}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          title="View Usage Dashboard"
          icon={Icon.BarChart}
          onAction={() => {
            launchCommand({
              name: "usage-dashboard",
              type: LaunchType.UserInitiated,
            });
          }}
        />
        <MenuBarExtra.Item
          title="Preferences..."
          icon={Icon.Gear}
          shortcut={{ modifiers: ["cmd"], key: "," }}
          onAction={openCommandPreferences}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
