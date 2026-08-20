/**
 * Parser tests for src/lib/subscription-usage.ts.
 *
 * Run with `npm test`, which bundles the module first with @raycast/api
 * aliased to ./stub-raycast.js — the real one only loads inside Raycast.
 * `fetch` is stubbed per case, so nothing here touches the network or needs
 * a token.
 */
import {
  getSubscriptionUsage,
  usageBar,
  formatReset,
  formatPercent,
} from "./bundle.mjs";

function mockFetch(status, body) {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

const inThreeHours = new Date(Date.now() + 3 * 3600_000 + 12 * 60_000);
const inFourDays = new Date(Date.now() + 4 * 86400_000 + 2 * 3600_000);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

// --- Case 1: `limits[]` present (the richer representation) ---
console.log("\nCase 1: limits[] path");
mockFetch(200, {
  five_hour: { utilization: 34, resets_at: inThreeHours.toISOString() },
  seven_day: { utilization: 61, resets_at: inFourDays.toISOString() },
  limits: [
    {
      kind: "rate_limit",
      group: "five_hour",
      percent: 34,
      resets_at: inThreeHours.toISOString(),
      scope: null,
    },
    {
      kind: "rate_limit",
      group: "seven_day_opus",
      percent: 88.4,
      resets_at: inFourDays.toISOString(),
      scope: { model: { display_name: "Opus 4.7" } },
    },
  ],
  extra_usage: {
    is_enabled: true,
    monthly_limit: 200,
    used_credits: 43.17,
    utilization: 21.6,
    currency: "USD",
  },
});
let usage = await getSubscriptionUsage(true);
console.log(JSON.stringify(usage, null, 2).slice(0, 500));
check("two buckets parsed", usage.buckets.length === 2);
check("scope display name folded into label",
  usage.buckets[1].label === "Weekly (Opus) — Opus 4.7",
  `got "${usage.buckets[1].label}"`);
check("percent preserved", usage.buckets[1].percent === 88.4);
check("resets_at parsed to Date", usage.buckets[0].resetsAt instanceof Date);
check("extra usage parsed", usage.extraUsage?.usedCredits === 43.17);

// --- Case 2: no limits[], fall back to named windows ---
console.log("\nCase 2: bucket fallback + ordering");
mockFetch(200, {
  seven_day_sonnet: { utilization: 12, resets_at: inFourDays.toISOString() },
  five_hour: { utilization: 5.5, resets_at: inThreeHours.toISOString() },
  seven_day: { utilization: 61, resets_at: null },
  cinder_cove: { utilization: null, resets_at: null },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
});
usage = await getSubscriptionUsage(true);
console.log("  order:", usage.buckets.map((b) => b.label).join(" | "));
check("five_hour sorted first", usage.buckets[0].key === "five_hour");
check("null utilization dropped",
  !usage.buckets.some((b) => b.key === "cinder_cove"));
check("null resets_at tolerated", usage.buckets[1].resetsAt === null);
check("extra usage disabled", usage.extraUsage?.isEnabled === false);

// --- Case 3: unknown future bucket is humanized, not dropped ---
console.log("\nCase 3: unknown bucket key");
mockFetch(200, { thirty_day_beta: { utilization: 7, resets_at: null } });
usage = await getSubscriptionUsage(true);
check("unknown key humanized",
  usage.buckets[0]?.label === "Thirty Day Beta",
  `got "${usage.buckets[0]?.label}"`);

// --- Case 4: garbage payload degrades quietly ---
console.log("\nCase 4: garbage payload");
mockFetch(200, { five_hour: "not-an-object", limits: "nope" });
usage = await getSubscriptionUsage(true);
check("no buckets, no throw", usage.buckets.length === 0);

// --- Case 5: auth failure is typed ---
console.log("\nCase 5: 401");
mockFetch(401, {});
try {
  await getSubscriptionUsage(true);
  check("401 throws", false);
} catch (e) {
  check("401 -> unauthorized reason", e.reason === "unauthorized");
  console.log(`  message: ${e.message}`);
}

// --- Formatting helpers ---
console.log("\nFormatters");
console.log(`  0%   |${usageBar(0)}|`);
console.log(`  34%  |${usageBar(34)}|`);
console.log(`  88.4%|${usageBar(88.4)}|`);
console.log(`  100% |${usageBar(100)}|`);
check("bar is 20 cells", [...usageBar(34)].length === 20);
// formatReset floors, and a few ms elapse between constructing the target and
// formatting it, so match the shape rather than an exact minute.
check("reset formats hours", /^in 3h (11|12)m$/.test(formatReset(inThreeHours)),
  `got "${formatReset(inThreeHours)}"`);
check("reset formats days", /^in 4d (1|2)h$/.test(formatReset(inFourDays)),
  `got "${formatReset(inFourDays)}"`);
check("past reset -> now", formatReset(new Date(Date.now() - 1000)) === "now");
check("percent rounds above 10", formatPercent(88.4) === "88%");
check("percent keeps decimal below 10", formatPercent(5.5) === "5.5%");

// --- The open question: what if utilization is 0-1, not 0-100? ---
console.log("\nScale check (0-1 hypothesis)");
mockFetch(200, { five_hour: { utilization: 0.34, resets_at: null } });
usage = await getSubscriptionUsage(true);
console.log(
  `  utilization 0.34 renders as ${formatPercent(usage.buckets[0].percent)} ` +
    `|${usageBar(usage.buckets[0].percent)}|`,
);
console.log("  ^ if the live response looks like this, the scale assumption is wrong");

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
