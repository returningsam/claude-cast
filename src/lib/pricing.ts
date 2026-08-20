import { MessageUsage } from "./session-parser";

/**
 * API list-rate pricing, used only by the "API usage" display mode.
 *
 * These figures are what usage WOULD have cost on pay-as-you-go billing. On a
 * subscription nothing here is charged — see subscription-usage.ts for what is
 * actually metered. The table is hardcoded and goes stale whenever Anthropic
 * changes rates, so treat every number as an estimate.
 */

/**
 * Per-model pricing. Rows are matched by substring against `usage.model`,
 * most-specific first. Sonnet 4.x has a 200K-input-token tier where the rate
 * doubles. The tier applies per-message (per-request), not per-session, so a
 * session with several messages each below 200K still pays the base rate.
 *
 * Pricing source: https://docs.anthropic.com/en/docs/about-claude/pricing
 */
interface Pricing {
  match: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  /** Optional tier applied to per-message tokens above thresholdTokens. */
  tier?: {
    thresholdTokens: number;
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok: number;
    cacheWritePerMTok: number;
  };
}

const MODEL_PRICING: Pricing[] = [
  // Opus 4.7 (latest, $5/$25 tier). MUST come before bare "opus" so substring
  // match resolves here first; without this row, opus-4-7 sessions fall through
  // to the older $15/$75 "opus" row.
  {
    match: "opus-4-7",
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
  },
  // Opus 4.5/4.6 ($5/$25 tier)
  {
    match: "opus-4-5",
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
  },
  {
    match: "opus-4-6",
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
  },
  // Opus 4.1 (older $15/$75 tier)
  {
    match: "opus-4-1",
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
  },
  // Opus 4 / generic opus fallback ($15/$75 tier)
  {
    match: "opus",
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
  },
  // Sonnet 4.x: 200K-token tier doubles the rate above the threshold.
  {
    match: "sonnet",
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
    tier: {
      thresholdTokens: 200_000,
      inputPerMTok: 6,
      outputPerMTok: 22.5,
      cacheReadPerMTok: 0.6,
      cacheWritePerMTok: 7.5,
    },
  },
  // Haiku 4.5 ($1/$5 tier)
  {
    match: "haiku-4",
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
  // Haiku 3.5 ($0.80/$4 tier)
  {
    match: "haiku",
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.08,
    cacheWritePerMTok: 1,
  },
];

const DEFAULT_PRICING = MODEL_PRICING.find((p) => p.match === "sonnet")!;

function resolvePricing(model?: string): Pricing {
  if (!model) return DEFAULT_PRICING;
  const lower = model.toLowerCase();
  for (const pricing of MODEL_PRICING) {
    if (lower.includes(pricing.match)) return pricing;
  }
  return DEFAULT_PRICING;
}

/**
 * Compute the cost of a single deduplicated message using tier-aware pricing.
 * The streaming-chunk dedup inside streamSessionUsage ensures `msg` represents
 * the cumulative final usage for one request, not double-counted chunks.
 *
 * Per Anthropic, the 200K-token tier is keyed on *input tokens per request*:
 * if a single request crosses the threshold, ALL token types (input, output,
 * cache read, cache write) bill at the high-tier flat rate for that request.
 * The high tier is not a split-at-threshold calculation per token type.
 */
export function calculateMessageCost(msg: MessageUsage): number {
  const p = resolvePricing(msg.model);
  const inHighTier =
    p.tier !== undefined && msg.inputTokens > p.tier.thresholdTokens;
  const inputRate = inHighTier ? p.tier!.inputPerMTok : p.inputPerMTok;
  const outputRate = inHighTier ? p.tier!.outputPerMTok : p.outputPerMTok;
  const cacheReadRate = inHighTier
    ? p.tier!.cacheReadPerMTok
    : p.cacheReadPerMTok;
  const cacheWriteRate = inHighTier
    ? p.tier!.cacheWritePerMTok
    : p.cacheWritePerMTok;
  return (
    (msg.inputTokens / 1_000_000) * inputRate +
    (msg.outputTokens / 1_000_000) * outputRate +
    (msg.cacheReadTokens / 1_000_000) * cacheReadRate +
    (msg.cacheCreationTokens / 1_000_000) * cacheWriteRate
  );
}

/**
 * Format cost as currency string
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}
