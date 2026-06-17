import { format } from "date-fns";
import type { ParsedSession } from "../types";

export function downloadJson(fileName: string, data: unknown) {
  downloadText(fileName, JSON.stringify(data, null, 2), "application/json");
}

export function downloadCsv(fileName: string, sessions: ParsedSession[]) {
  const headers = [
    "date",
    "duration",
    "duration_ms",
    "session_name",
    "task_heading",
    "workspace",
    "model",
    "thread_source",
    "child_sessions",
    "total_tokens",
    "input_tokens",
    "cached_tokens",
    "non_cached_input_tokens",
    "output_tokens",
    "reasoning_level",
    "reasoning_tokens",
    "approximated_cost",
    "approximated_credits",
    "messages",
    "tool_calls",
    "file_path",
  ];
  const rows = sessions.map((session) => [
    session.date,
    formatDuration(session.durationMs),
    session.durationMs ?? "",
    session.sessionName,
    session.taskHeading,
    session.workspace,
    session.model,
    session.threadSource ?? "user",
    session.childSessions?.length ?? 0,
    session.usage.totalTokens,
    session.usage.inputTokens,
    session.usage.cachedInputTokens,
    session.nonCachedInputTokens,
    session.usage.outputTokens,
    session.reasoningEffort ?? "",
    session.usage.reasoningOutputTokens,
    session.estimatedCost.toFixed(6),
    session.estimatedCredits.toFixed(4),
    session.userMessages + session.assistantMessages,
    session.toolCalls,
    session.filePath,
  ]);
  const csv = [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
  downloadText(fileName, csv, "text/csv");
}

export function downloadMonthlySummary(sessions: ParsedSession[]) {
  const summary = sessions.reduce<Record<string, { sessions: number; tokens: number; cost: number; messages: number }>>(
    (acc, session) => {
      const key = format(new Date(session.date), "yyyy-MM");
      acc[key] ??= { sessions: 0, tokens: 0, cost: 0, messages: 0 };
      acc[key].sessions += 1;
      acc[key].tokens += session.usage.totalTokens;
      acc[key].cost += session.estimatedCost;
      acc[key].messages += session.userMessages + session.assistantMessages;
      return acc;
    },
    {},
  );
  downloadJson("codex-monthly-summary.json", summary);
}

export function downloadSessionReport(session: ParsedSession) {
  downloadJson(`codex-session-${safeFileName(session.sessionName)}.json`, session);
}

function downloadText(fileName: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function escapeCsv(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "";
  }

  const totalSeconds = Math.max(Math.round(value / 1000), 0);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function safeFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
}
