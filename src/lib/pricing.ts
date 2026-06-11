import type { ModelPricing, PricingSettings, TokenUsage } from "../types";

export const DEFAULT_PRICING: PricingSettings = {
  mode: "both",
  creditConversionRate: 1,
  models: [
    {
      model: "gpt-5",
      inputPerMillion: 1.25,
      cachedInputPerMillion: 0.125,
      outputPerMillion: 10,
      reasoningOutputPerMillion: 0,
    },
    {
      model: "gpt-5-codex",
      inputPerMillion: 1.25,
      cachedInputPerMillion: 0.125,
      outputPerMillion: 10,
      reasoningOutputPerMillion: 0,
    },
    {
      model: "default",
      inputPerMillion: 1.25,
      cachedInputPerMillion: 0.125,
      outputPerMillion: 10,
      reasoningOutputPerMillion: 0,
    },
  ],
};

export function findPricing(settings: PricingSettings, model: string): ModelPricing {
  const normalized = model.trim().toLowerCase();
  return (
    settings.models.find((item) => item.model.trim().toLowerCase() === normalized) ??
    settings.models.find((item) => item.model === "default") ??
    DEFAULT_PRICING.models[DEFAULT_PRICING.models.length - 1]
  );
}

export function estimateCost(usage: TokenUsage, model: string, settings: PricingSettings): number {
  const pricing = findPricing(settings, model);
  const cached = Math.max(usage.cachedInputTokens, 0);
  const nonCachedInput = Math.max(usage.inputTokens - cached, 0);

  return (
    (nonCachedInput / 1_000_000) * pricing.inputPerMillion +
    (cached / 1_000_000) * pricing.cachedInputPerMillion +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

export function estimateCredits(cost: number, settings: PricingSettings): number {
  if (!Number.isFinite(cost) || !Number.isFinite(settings.creditConversionRate)) {
    return 0;
  }
  return cost * settings.creditConversionRate;
}
