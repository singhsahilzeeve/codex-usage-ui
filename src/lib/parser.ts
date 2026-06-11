import { estimateCost, estimateCredits } from "./pricing";
import type { ParsedSession, PricingSettings, TokenTimelinePoint, TokenUsage } from "../types";

type RawFile = {
  name: string;
  path: string;
  text: string;
};

type MutableSession = {
  sessionId?: string;
  parentThreadId?: string;
  threadSource?: string;
  source?: string;
  date?: string;
  workspace?: string;
  model?: string;
  firstUserPrompt?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  latestUsage: TokenUsage;
  modelContextWindow?: number;
  rateLimits?: unknown;
  creditsRaw?: unknown;
  timeline: Array<Omit<TokenTimelinePoint, "estimatedCost">>;
  warnings: string[];
};

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

export function isSessionFile(path: string): boolean {
  const lower = path.toLowerCase();
  const fileName = lower.split("/").pop() ?? lower;
  return lower.endsWith(".jsonl") || /^rollout-.*\.jsonl$/.test(fileName);
}

export async function readFilesFromDirectory(
  handle: FileSystemDirectoryHandle,
  onProgress?: (processed: number, total: number, path: string) => void,
): Promise<RawFile[]> {
  const files: RawFile[] = [];
  const fileHandles: Array<{ handle: FileSystemFileHandle; path: string }> = [];

  async function walk(directory: FileSystemDirectoryHandle, prefix: string) {
    for await (const [name, entry] of directory.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === "directory") {
        await walk(entry, path);
      } else if (isSessionFile(path)) {
        fileHandles.push({ handle: entry, path });
      }
    }
  }

  await walk(handle, handle.name || "sessions");

  for (const [index, entry] of fileHandles.entries()) {
    onProgress?.(index, fileHandles.length, entry.path);
    const file = await entry.handle.getFile();
    files.push({ name: file.name, path: entry.path, text: await file.text() });
  }

  return files;
}

export async function readJsonlFiles(files: FileList | File[]): Promise<RawFile[]> {
  const result: RawFile[] = [];
  for (const file of Array.from(files)) {
    const path = file.webkitRelativePath || file.name;
    if (isSessionFile(path)) {
      result.push({ name: file.name, path, text: await file.text() });
    }
  }
  return result;
}

export function parseSessionFile(file: RawFile, pricing: PricingSettings): ParsedSession | null {
  const session: MutableSession = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    latestUsage: { ...EMPTY_USAGE },
    timeline: [],
    warnings: [],
  };

  const lines = file.text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }

  const rawPreview = lines.slice(0, 12).join("\n");
  let parsedLines = 0;

  lines.forEach((line, index) => {
    try {
      const event = JSON.parse(line);
      parsedLines += 1;
      consumeEvent(event, session);
    } catch {
      session.warnings.push(`Line ${index + 1} could not be parsed as JSON.`);
    }
  });

  if (parsedLines === 0) {
    return null;
  }

  const fallbackDate = inferDateFromPath(file.path) ?? new Date().toISOString();
  const date = session.date ?? fallbackDate;
  const model = session.model ?? "default";
  const cost = estimateCost(session.latestUsage, model, pricing);
  const sessionName = buildSessionName(session.firstUserPrompt, file.name);
  const tokenTimeline = session.timeline.map((point) => ({
    ...point,
    estimatedCost: estimateCost(
      {
        inputTokens: point.inputTokens,
        cachedInputTokens: point.cachedInputTokens,
        outputTokens: point.outputTokens,
        reasoningOutputTokens: point.reasoningOutputTokens,
        totalTokens: point.totalTokens,
      },
      model,
      pricing,
    ),
  }));

  return {
    id: `${file.path}-${date}`,
    sessionId: session.sessionId,
    parentThreadId: session.parentThreadId,
    threadSource: session.threadSource,
    source: session.source,
    sessionName,
    taskHeading: sessionName,
    fileName: file.name,
    filePath: file.path,
    date,
    workspace: session.workspace ?? "Unknown workspace",
    model,
    firstUserPrompt: session.firstUserPrompt ?? "",
    userMessages: session.userMessages,
    assistantMessages: session.assistantMessages,
    toolCalls: session.toolCalls,
    usage: session.latestUsage,
    nonCachedInputTokens: Math.max(session.latestUsage.inputTokens - session.latestUsage.cachedInputTokens, 0),
    estimatedCost: cost,
    estimatedCredits: estimateCredits(cost, pricing),
    modelContextWindow: session.modelContextWindow,
    rateLimits: session.rateLimits,
    creditsRaw: session.creditsRaw,
    tokenTimeline,
    rawPreview,
    warnings: session.warnings,
  };
}

function consumeEvent(event: any, session: MutableSession) {
  const timestamp = readString(event.timestamp) ?? readString(event.payload?.timestamp);
  if (timestamp && (!session.date || new Date(timestamp).getTime() < new Date(session.date).getTime())) {
    session.date = timestamp;
  }

  if (event.type === "session_meta") {
    session.sessionId = readString(event.payload?.id) ?? session.sessionId;
    session.parentThreadId = readString(event.payload?.parent_thread_id) ?? session.parentThreadId;
    session.threadSource = readThreadSource(event.payload?.thread_source) ?? session.threadSource;
    session.source = readEventSource(event.payload?.source) ?? session.source;
    session.workspace = readString(event.payload?.cwd) ?? session.workspace;
    session.model = readString(event.payload?.model) ?? readString(event.payload?.model_slug) ?? session.model;
    if (readString(event.payload?.timestamp)) {
      session.date = readString(event.payload?.timestamp);
    }
  }

  const directModel =
    readString(event.model) ??
    readString(event.payload?.model) ??
    readString(event.payload?.model_slug) ??
    readString(event.payload?.model_name);
  if (directModel) {
    session.model = directModel;
  }

  const cwd = readString(event.cwd) ?? readString(event.payload?.cwd) ?? readString(event.payload?.metadata?.cwd);
  if (cwd) {
    session.workspace = cwd;
  }

  if (event.type === "token_count" || event.payload?.type === "token_count") {
    const info = event.info ?? event.payload?.info ?? {};
    const usage = normalizeUsage(info.total_token_usage ?? info.totalTokenUsage ?? info.usage ?? {});
    session.latestUsage = pickCumulativeUsage(session.latestUsage, usage);
    session.modelContextWindow = readNumber(info.model_context_window) ?? session.modelContextWindow;
    session.rateLimits = event.rate_limits ?? event.payload?.rate_limits ?? event.payload?.rateLimits ?? session.rateLimits;
    session.creditsRaw = event.credits ?? event.payload?.credits ?? session.creditsRaw;
    session.timeline.push({ timestamp: timestamp ?? new Date().toISOString(), ...session.latestUsage });
  }

  const message = extractMessage(event);
  if (message.role === "user") {
    session.userMessages += 1;
    if (!session.firstUserPrompt && message.text) {
      const cleaned = cleanPrompt(message.text);
      if (cleaned) {
        session.firstUserPrompt = cleaned;
      }
    }
  }
  if (message.role === "assistant") {
    session.assistantMessages += 1;
  }

  if (isToolCall(event)) {
    session.toolCalls += 1;
  }
}

function extractMessage(event: any): { role?: string; text?: string } {
  const payload = event.payload ?? {};
  const role =
    readString(event.role) ??
    readString(payload.role) ??
    readString(payload.message?.role) ??
    readString(payload.item?.role);

  const type = readString(event.type) ?? readString(payload.type);
  const phase = readString(payload.phase);
  const text =
    readString(event.message) ??
    readString(payload.message) ??
    readString(payload.text) ??
    readString(payload.content) ??
    extractContentText(payload.content) ??
    extractContentText(payload.message?.content);

  if (role) {
    return { role, text };
  }

  if (type === "event_msg" && phase === "commentary") {
    return { role: "assistant", text };
  }

  if (type === "response_item" && payload.type === "message") {
    return { role: readString(payload.role), text };
  }

  return {};
}

function isToolCall(event: any): boolean {
  const payload = event.payload ?? {};
  const type = readString(event.type) ?? readString(payload.type);
  return (
    type === "function_call" ||
    type === "tool_call" ||
    payload.type === "function_call" ||
    Boolean(payload.call_id && payload.name) ||
    Boolean(event.call_id && event.name)
  );
}

function normalizeUsage(raw: any): TokenUsage {
  return {
    inputTokens: readNumber(raw.input_tokens) ?? readNumber(raw.inputTokens) ?? 0,
    cachedInputTokens: readNumber(raw.cached_input_tokens) ?? readNumber(raw.cachedInputTokens) ?? 0,
    outputTokens: readNumber(raw.output_tokens) ?? readNumber(raw.outputTokens) ?? 0,
    reasoningOutputTokens: readNumber(raw.reasoning_output_tokens) ?? readNumber(raw.reasoningOutputTokens) ?? 0,
    totalTokens: readNumber(raw.total_tokens) ?? readNumber(raw.totalTokens) ?? 0,
  };
}

function pickCumulativeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return b.totalTokens >= a.totalTokens ? b : a;
}

function buildSessionName(prompt: string | undefined, fileName: string): string {
  const source = cleanPrompt(prompt ?? "") || fileName || "Untitled session";
  return source.length > 60 ? `${source.slice(0, 57).trim()}...` : source;
}

function cleanPrompt(prompt: string): string {
  const withoutMetadata = prompt
    .replace(/# Files mentioned by the user:[\s\S]*?## My request for Codex:/i, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .replace(/<cwd>[\s\S]*?<\/cwd>/gi, "")
    .replace(/<shell>[\s\S]*?<\/shell>/gi, "")
    .replace(/<current_date>[\s\S]*?<\/current_date>/gi, "")
    .replace(/<timezone>[\s\S]*?<\/timezone>/gi, "")
    .replace(/<filesystem>[\s\S]*?<\/filesystem>/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return withoutMetadata.replace(/^## My request for Codex:\s*/i, "").trim();
}

function extractContentText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        return readString(item?.text) ?? readString(item?.content) ?? readString(item?.output_text);
      })
      .filter(Boolean)
      .join(" ");
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readThreadSource(value: unknown): string | undefined {
  return readString(value);
}

function readEventSource(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const subagent = (value as { subagent?: unknown }).subagent;
    if (typeof subagent === "string") {
      return subagent;
    }
    if (subagent && typeof subagent === "object") {
      return readString((subagent as { other?: unknown }).other) ?? "subagent";
    }
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function inferDateFromPath(path: string): string | undefined {
  const match = path.match(/(20\d{2})[/-](\d{2})[/-](\d{2})/);
  if (!match) {
    return undefined;
  }
  return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`).toISOString();
}
