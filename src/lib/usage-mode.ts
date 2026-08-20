import { getPreferenceValues } from "@raycast/api";

/**
 * Which units the usage surfaces report in.
 *
 * "subscription" — live limit utilization plus token counts. What a Claude
 *   subscription actually meters.
 * "api" — API list-rate dollar estimates, and the limits section is hidden.
 *   What the usage would have cost on pay-as-you-go billing; not a bill.
 *
 * The two are not interchangeable views of one number: limits are live and
 * account-wide with no history, costs are historical and per-project with no
 * live equivalent. Hence a mode switch rather than a unit toggle.
 */
export type UsageMode = "subscription" | "api";

export function getUsageMode(): UsageMode {
  const { usageMode } = getPreferenceValues<Preferences>();
  return usageMode === "api" ? "api" : "subscription";
}
