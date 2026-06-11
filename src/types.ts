export type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type TokenTimelinePoint = {
  timestamp: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedCost: number;
};

export type ParsedSession = {
  id: string;
  sessionId?: string;
  parentThreadId?: string;
  threadSource?: string;
  source?: string;
  sessionName: string;
  taskHeading: string;
  fileName: string;
  filePath: string;
  date: string;
  workspace: string;
  model: string;
  firstUserPrompt: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  usage: TokenUsage;
  nonCachedInputTokens: number;
  estimatedCost: number;
  estimatedCredits: number;
  modelContextWindow?: number;
  rateLimits?: unknown;
  creditsRaw?: unknown;
  tokenTimeline: TokenTimelinePoint[];
  rawPreview: string;
  warnings: string[];
  childSessions?: ParsedSession[];
};

export type ImportStats = {
  importedFiles: number;
  parsedSessions: number;
  skippedFiles: number;
  warnings: string[];
  importedAt: string;
};

export type PricingMode = "usd" | "credits" | "both";

export type ModelPricing = {
  model: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  reasoningOutputPerMillion: number;
};

export type PricingSettings = {
  mode: PricingMode;
  creditConversionRate: number;
  models: ModelPricing[];
};

export type Filters = {
  month: string;
  startDate: string;
  endDate: string;
  model: string;
  workspace: string;
  search: string;
  minCost: string;
  maxCost: string;
  minTokens: string;
  maxTokens: string;
};
