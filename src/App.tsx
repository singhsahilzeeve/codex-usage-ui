import { ChangeEvent, useMemo, useState } from "react";
import JSZip from "jszip";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { downloadCsv, downloadJson, downloadMonthlySummary, downloadSessionReport } from "./lib/export";
import { DEFAULT_PRICING, estimateCost, estimateCredits } from "./lib/pricing";
import { isSessionFile, parseSessionFile, readFilesFromDirectory } from "./lib/parser";
import type { Filters, ImportStats, ModelPricing, ParsedSession, PricingSettings } from "./types";

type Page = "import" | "dashboard" | "efficiency" | "sessions" | "reports" | "pricing" | "about";
type SortKey = "date" | "sessionName" | "workspace" | "model" | "totalTokens" | "cost" | "messages" | "toolCalls";
type ImportProgress = {
  phase: "idle" | "reading" | "extracting" | "parsing" | "saving";
  total: number;
  processed: number;
  currentFile: string;
};

const SESSIONS_KEY = "codex-usage-tracker:sessions";
const PRICING_KEY = "codex-usage-tracker:pricing";
const STATS_KEY = "codex-usage-tracker:stats";
const COLORS = ["#0f766e", "#2563eb", "#b45309", "#9f1239", "#4f46e5", "#15803d", "#be123c", "#475569"];

const EMPTY_FILTERS: Filters = {
  month: "",
  startDate: "",
  endDate: "",
  model: "",
  workspace: "",
  search: "",
  minCost: "",
  maxCost: "",
  minTokens: "",
  maxTokens: "",
};

function App() {
  const [page, setPage] = useState<Page>("import");
  const [sessions, setSessions] = useState<ParsedSession[]>(() => readStoredSessions());
  const [pricing, setPricing] = useState<PricingSettings>(() => readStoredPricing());
  const [stats, setStats] = useState<ImportStats | null>(() => readStoredStats());
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);

  const pricedSessions = useMemo(() => rollupChildSessions(recalculateSessions(sessions, pricing)), [sessions, pricing]);
  const filteredSessions = useMemo(() => applyFilters(pricedSessions, filters), [pricedSessions, filters]);
  const selectedSession = pricedSessions.find((session) => session.id === selectedId) ?? filteredSessions[0] ?? null;
  const sortedSessions = useMemo(
    () => sortSessions(filteredSessions, sortKey, sortDirection),
    [filteredSessions, sortDirection, sortKey],
  );

  function saveSessions(nextSessions: ParsedSession[], nextStats?: ImportStats) {
    setSessions(nextSessions);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(nextSessions));
    if (nextStats) {
      setStats(nextStats);
      localStorage.setItem(STATS_KEY, JSON.stringify(nextStats));
    }
  }

  function savePricing(nextPricing: PricingSettings) {
    setPricing(nextPricing);
    localStorage.setItem(PRICING_KEY, JSON.stringify(nextPricing));
  }

  async function importRawFiles(rawFiles: Array<{ name: string; path: string; text: string }>) {
    setImporting(true);
    try {
      const warnings: string[] = [];
      const parsed: ParsedSession[] = [];

      for (const [index, file] of rawFiles.entries()) {
        setImportProgress({
          phase: "parsing",
          total: rawFiles.length,
          processed: index,
          currentFile: file.path,
        });
        await yieldToBrowser();
        const session = parseSessionFile(file, pricing);
        if (session) {
          parsed.push(session);
        } else {
          warnings.push(`${file.path} did not contain parseable session events.`);
        }
      }

      const nextStats: ImportStats = {
        importedFiles: rawFiles.length,
        parsedSessions: parsed.length,
        skippedFiles: rawFiles.length - parsed.length,
        warnings,
        importedAt: new Date().toISOString(),
      };
      setImportProgress({
        phase: "saving",
        total: rawFiles.length,
        processed: rawFiles.length,
        currentFile: "Saving parsed sessions",
      });
      await yieldToBrowser();
      saveSessions(parsed, nextStats);
      setSelectedId(parsed.find((session) => !session.parentThreadId)?.id ?? parsed[0]?.id ?? null);
      setPage("dashboard");
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  }

  async function handleDirectoryImport() {
    if (!window.showDirectoryPicker) {
      alert("This browser does not support folder access. Upload a sessions zip or JSONL files instead.");
      return;
    }
    try {
      setImporting(true);
      setImportProgress({ phase: "reading", total: 0, processed: 0, currentFile: "~/.codex/sessions" });
      await yieldToBrowser();
      const handle = await window.showDirectoryPicker();
      const files = await readFilesFromDirectory(handle, (processed, total, currentFile) => {
        setImportProgress({ phase: "reading", total, processed, currentFile });
      });
      await importRawFiles(files);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setImporting(false);
        setImportProgress(null);
        return;
      }
      setImporting(false);
      setImportProgress(null);
      throw error;
    }
  }

  async function handleJsonlUpload(event: ChangeEvent<HTMLInputElement>) {
    if (!event.target.files?.length) {
      return;
    }
    setImporting(true);
    const files = await readJsonlFilesWithProgress(event.target.files, setImportProgress);
    await importRawFiles(files);
    event.target.value = "";
  }

  async function handleZipUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setImporting(true);
    try {
      setImportProgress({ phase: "extracting", total: 0, processed: 0, currentFile: file.name });
      await yieldToBrowser();
      const zip = await JSZip.loadAsync(file);
      const rawFiles: Array<{ name: string; path: string; text: string }> = [];
      const entries = Object.values(zip.files).filter((entry) => !entry.dir && isSessionFile(entry.name));
      for (const [index, entry] of entries.entries()) {
        setImportProgress({
          phase: "extracting",
          total: entries.length,
          processed: index,
          currentFile: entry.name,
        });
        await yieldToBrowser();
        rawFiles.push({
          name: entry.name.split("/").pop() ?? entry.name,
          path: entry.name,
          text: await entry.async("string"),
        });
      }
      await importRawFiles(rawFiles);
    } finally {
      event.target.value = "";
      setImporting(false);
    }
  }

  function clearData() {
    saveSessions([], {
      importedFiles: 0,
      parsedSessions: 0,
      skippedFiles: 0,
      warnings: [],
      importedAt: new Date().toISOString(),
    });
    setSelectedId(null);
  }

  const summary = useMemo(() => buildSummary(filteredSessions), [filteredSessions]);
  const chartData = useMemo(() => buildDailyData(filteredSessions), [filteredSessions]);
  const workspaceData = useMemo(() => groupMoney(filteredSessions, "workspace"), [filteredSessions]);
  const modelData = useMemo(() => groupMoney(filteredSessions, "model"), [filteredSessions]);
  const efficiencyCards = useMemo(() => buildEfficiencyCards(filteredSessions), [filteredSessions]);

  return (
    <div className="min-h-screen bg-slate-100 text-ink">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="label">Local analytics</p>
            <h1 className="text-2xl font-semibold tracking-normal">Codex Usage Tracker</h1>
            <p className="mt-1 text-xs text-slate-500">Times shown in browser timezone: {getBrowserTimeZone()}</p>
          </div>
          <nav className="flex flex-wrap gap-2">
            {[
              ["import", "Import"],
              ["dashboard", "Dashboard"],
              ["efficiency", "Efficiency"],
              ["sessions", "Sessions"],
              ["reports", "Reports"],
              ["pricing", "Pricing"],
              ["about", "About"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={`btn ${page === key ? "btn-primary" : ""}`}
                onClick={() => setPage(key as Page)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {page !== "import" && (
          <FiltersPanel
            sessions={pricedSessions}
            filters={filters}
            onChange={setFilters}
            onClear={() => setFilters(EMPTY_FILTERS)}
          />
        )}

        {page === "import" && (
          <ImportPage
            importing={importing}
            stats={stats}
            sessionCount={pricedSessions.length}
            onDirectoryImport={handleDirectoryImport}
            onZipUpload={handleZipUpload}
            onJsonlUpload={handleJsonlUpload}
            onClear={clearData}
            progress={importProgress}
          />
        )}
        {page === "dashboard" && (
          <DashboardPage
            summary={summary}
            chartData={chartData}
            workspaceData={workspaceData}
            modelData={modelData}
            sessions={filteredSessions}
            pricing={pricing}
          />
        )}
        {page === "efficiency" && (
          <EfficiencyPage cards={efficiencyCards} sessions={filteredSessions} summary={summary} />
        )}
        {page === "sessions" && (
          <SessionsPage
            sessions={sortedSessions}
            selectedSession={selectedSession}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={(key) => {
              if (sortKey === key) {
                setSortDirection(sortDirection === "asc" ? "desc" : "asc");
              } else {
                setSortKey(key);
                setSortDirection("desc");
              }
            }}
            onSelect={(session) => setSelectedId(session.id)}
          />
        )}
        {page === "reports" && <ReportsPage sessions={filteredSessions} selectedSession={selectedSession} />}
        {page === "pricing" && <PricingPage pricing={pricing} onChange={savePricing} />}
        {page === "about" && <AboutPage />}
      </main>
    </div>
  );
}

function ImportPage({
  importing,
  stats,
  sessionCount,
  onDirectoryImport,
  onZipUpload,
  onJsonlUpload,
  onClear,
  progress,
}: {
  importing: boolean;
  stats: ImportStats | null;
  sessionCount: number;
  onDirectoryImport: () => void;
  onZipUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onJsonlUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  progress: ImportProgress | null;
}) {
  const progressPercent =
    progress && progress.total > 0 ? Math.round((Math.min(progress.processed + 1, progress.total) / progress.total) * 100) : 0;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <section className="card p-5">
        <div className="mb-5">
          <p className="label">Import sources</p>
          <h2 className="mt-1 text-xl font-semibold">Select local Codex session logs</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border border-line bg-slate-50 p-4">
            <h3 className="font-semibold">Sessions folder</h3>
            <p className="mt-2 text-sm text-slate-600">
              Pick the `~/.codex/sessions` directory. The app recursively scans year, month, and day folders.
            </p>
            <button className="btn btn-primary mt-4 w-full" disabled={importing} onClick={onDirectoryImport}>
              {importing ? "Importing..." : "Select Codex sessions folder"}
            </button>
            {!window.showDirectoryPicker && (
              <p className="mt-2 text-xs text-amber">Folder access is unavailable in this browser.</p>
            )}
          </div>
          <label className="rounded-md border border-line bg-slate-50 p-4">
            <h3 className="font-semibold">Sessions zip</h3>
            <p className="mt-2 text-sm text-slate-600">
              Upload a zip that contains `.jsonl` or `rollout-*.jsonl` files from the sessions tree.
            </p>
            <span className={`btn mt-4 w-full ${importing ? "opacity-50" : ""}`}>Upload sessions zip</span>
            <input className="hidden" type="file" accept=".zip" disabled={importing} onChange={onZipUpload} />
          </label>
          <label className="rounded-md border border-line bg-slate-50 p-4">
            <h3 className="font-semibold">JSONL files</h3>
            <p className="mt-2 text-sm text-slate-600">
              Upload individual session files manually, including the sample `codex-metrics.jsonl`.
            </p>
            <span className={`btn mt-4 w-full ${importing ? "opacity-50" : ""}`}>Upload JSONL files</span>
            <input className="hidden" type="file" accept=".jsonl" multiple disabled={importing} onChange={onJsonlUpload} />
          </label>
        </div>
        {importing && progress ? (
          <div className="mt-5 rounded-md border border-teal-200 bg-teal-50 p-4">
            <div className="flex flex-col gap-1 text-sm md:flex-row md:items-center md:justify-between">
              <span className="font-semibold capitalize">{progress.phase} session files</span>
              <span className="text-slate-600">
                {progress.total > 0
                  ? `${Math.min(progress.processed + 1, progress.total)} of ${progress.total}`
                  : "Scanning files"}
              </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
              <div
                className="h-full rounded-full bg-signal transition-all"
                style={{ width: progress.total > 0 ? `${progressPercent}%` : "25%" }}
              />
            </div>
            <p className="mt-2 break-all text-xs text-slate-600">{progress.currentFile}</p>
          </div>
        ) : null}
      </section>
      <aside className="card p-5">
        <p className="label">Cache</p>
        <div className="mt-4 grid gap-3 text-sm">
          <MetricLine label="Parsed sessions" value={formatNumber(sessionCount)} />
          <MetricLine label="Imported files" value={formatNumber(stats?.importedFiles ?? 0)} />
          <MetricLine label="Skipped files" value={formatNumber(stats?.skippedFiles ?? 0)} />
          <MetricLine label="Last import" value={stats ? formatDateTime(stats.importedAt) : "Never"} />
          <MetricLine label="Timezone" value={getBrowserTimeZone()} />
        </div>
        <button className="btn mt-5 w-full" onClick={onClear}>
          Clear cached data
        </button>
        {stats?.warnings.length ? (
          <div className="mt-5 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber">
            <p className="font-semibold">Import warnings</p>
            {stats.warnings.slice(0, 4).map((warning) => (
              <p key={warning} className="mt-1">
                {warning}
              </p>
            ))}
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function FiltersPanel({
  sessions,
  filters,
  onChange,
  onClear,
}: {
  sessions: ParsedSession[];
  filters: Filters;
  onChange: (filters: Filters) => void;
  onClear: () => void;
}) {
  const models = unique(sessions.map((session) => session.model));
  const workspaces = unique(sessions.map((session) => session.workspace));
  const months = unique(sessions.map((session) => localMonthKey(session.date)));
  const update = (key: keyof Filters, value: string) => onChange({ ...filters, [key]: value });

  return (
    <section className="card mb-5 p-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <label>
          <span className="label">Month</span>
          <select className="field mt-1" value={filters.month} onChange={(event) => update("month", event.target.value)}>
            <option value="">All months</option>
            {months.map((month) => (
              <option key={month}>{month}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Start date</span>
          <input className="field mt-1" type="date" value={filters.startDate} onChange={(event) => update("startDate", event.target.value)} />
        </label>
        <label>
          <span className="label">End date</span>
          <input className="field mt-1" type="date" value={filters.endDate} onChange={(event) => update("endDate", event.target.value)} />
        </label>
        <label>
          <span className="label">Model</span>
          <select className="field mt-1" value={filters.model} onChange={(event) => update("model", event.target.value)}>
            <option value="">All models</option>
            {models.map((model) => (
              <option key={model}>{model}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Workspace</span>
          <select className="field mt-1" value={filters.workspace} onChange={(event) => update("workspace", event.target.value)}>
            <option value="">All workspaces</option>
            {workspaces.map((workspace) => (
              <option key={workspace}>{shortPath(workspace)}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Search</span>
          <input className="field mt-1" value={filters.search} onChange={(event) => update("search", event.target.value)} placeholder="Task or session" />
        </label>
        <label>
          <span className="label">Min cost</span>
          <input className="field mt-1" type="number" min="0" value={filters.minCost} onChange={(event) => update("minCost", event.target.value)} />
        </label>
        <label>
          <span className="label">Max cost</span>
          <input className="field mt-1" type="number" min="0" value={filters.maxCost} onChange={(event) => update("maxCost", event.target.value)} />
        </label>
        <label>
          <span className="label">Min tokens</span>
          <input className="field mt-1" type="number" min="0" value={filters.minTokens} onChange={(event) => update("minTokens", event.target.value)} />
        </label>
        <label>
          <span className="label">Max tokens</span>
          <input className="field mt-1" type="number" min="0" value={filters.maxTokens} onChange={(event) => update("maxTokens", event.target.value)} />
        </label>
        <div className="flex items-end">
          <button className="btn w-full" onClick={onClear}>
            Clear filters
          </button>
        </div>
      </div>
    </section>
  );
}

function DashboardPage({
  summary,
  chartData,
  workspaceData,
  modelData,
  sessions,
  pricing,
}: {
  summary: ReturnType<typeof buildSummary>;
  chartData: Array<Record<string, number | string>>;
  workspaceData: Array<{ name: string; value: number }>;
  modelData: Array<{ name: string; value: number }>;
  sessions: ParsedSession[];
  pricing: PricingSettings;
}) {
  const topSessions = [...sessions].sort((a, b) => b.estimatedCost - a.estimatedCost).slice(0, 10);

  return (
    <div className="grid gap-5">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <Kpi title="Total estimated spend" value={formatCurrency(summary.totalCost)} />
        <Kpi title="Total estimated credits" value={formatNumber(summary.totalCredits)} />
        <Kpi title="Total tokens" value={formatNumber(summary.totalTokens)} />
        <Kpi title="Input tokens" value={formatNumber(summary.inputTokens)} />
        <Kpi title="Cached tokens" value={formatNumber(summary.cachedTokens)} />
        <Kpi title="Output tokens" value={formatNumber(summary.outputTokens)} />
        <Kpi title="Reasoning tokens" value={formatNumber(summary.reasoningTokens)} />
        <Kpi title="Sessions" value={formatNumber(summary.sessions)} />
        <Kpi title="Messages" value={formatNumber(summary.messages)} />
        <Kpi title="Avg cost/session" value={formatCurrency(summary.avgCostPerSession)} />
        <Kpi title="Avg cost/message" value={formatCurrency(summary.avgCostPerMessage)} />
        <Kpi title="Cache hit rate" value={`${summary.cacheHitRate.toFixed(1)}%`} />
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <ChartCard title="Daily estimated spend trend">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip formatter={(value) => formatCurrency(Number(value))} />
              <Area type="monotone" dataKey="cost" stroke="#0f766e" fill="#99f6e4" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Daily total tokens trend">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip formatter={(value) => formatNumber(Number(value))} />
              <Line type="monotone" dataKey="tokens" stroke="#2563eb" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Input vs output vs cached token stacked chart">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip formatter={(value) => formatNumber(Number(value))} />
              <Legend />
              <Bar dataKey="nonCachedInput" stackId="tokens" fill="#2563eb" name="Non-cached input" />
              <Bar dataKey="cached" stackId="tokens" fill="#0f766e" name="Cached input" />
              <Bar dataKey="output" stackId="tokens" fill="#b45309" name="Output" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Sessions by day">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="sessions" fill="#4f46e5" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Cost by workspace">
          <PieBlock data={workspaceData} />
        </ChartCard>
        <ChartCard title="Cost by model">
          <PieBlock data={modelData} />
        </ChartCard>
        <ChartCard title="Messages per session trend">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Line type="monotone" dataKey="messagesPerSession" stroke="#9f1239" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Cache hit rate trend">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip formatter={(value) => `${Number(value).toFixed(1)}%`} />
              <Line type="monotone" dataKey="cacheHitRate" stroke="#15803d" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Cost per message trend">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip formatter={(value) => formatCurrency(Number(value))} />
              <Line type="monotone" dataKey="costPerMessage" stroke="#be123c" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
        <div className="card p-4 xl:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-semibold">Top 10 most expensive sessions</h3>
            <p className="text-xs text-slate-500">Pricing mode: {pricing.mode}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-line text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2">Session</th>
                  <th>Workspace</th>
                  <th>Model</th>
                  <th className="text-right">Tokens</th>
                  <th className="text-right">Estimated cost</th>
                </tr>
              </thead>
              <tbody>
                {topSessions.map((session) => (
                  <tr key={session.id} className="border-b border-slate-100">
                    <td className="py-2 font-medium">{session.sessionName}</td>
                    <td>{shortPath(session.workspace)}</td>
                    <td>{session.model}</td>
                    <td className="text-right">{formatNumber(session.usage.totalTokens)}</td>
                    <td className="text-right">{formatCurrency(session.estimatedCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

function EfficiencyPage({
  cards,
  sessions,
  summary,
}: {
  cards: Array<{ title: string; reason: string; sessions: ParsedSession[]; wastedCost: number; action: string }>;
  sessions: ParsedSession[];
  summary: ReturnType<typeof buildSummary>;
}) {
  const highTokenSessions = [...sessions].sort((a, b) => b.usage.totalTokens - a.usage.totalTokens).slice(0, 8);
  const lowMessageHighCost = [...sessions]
    .filter((session) => session.userMessages + session.assistantMessages <= 4)
    .sort((a, b) => b.estimatedCost - a.estimatedCost)
    .slice(0, 8);
  const repeatedContext = [...sessions]
    .filter((session) => session.usage.inputTokens > 0)
    .sort((a, b) => b.usage.cachedInputTokens / b.usage.inputTokens - a.usage.cachedInputTokens / a.usage.inputTokens)
    .slice(0, 8);
  const highOutput = [...sessions].sort((a, b) => b.usage.outputTokens - a.usage.outputTokens).slice(0, 8);

  return (
    <div className="grid gap-5">
      <section className="grid gap-3 md:grid-cols-5">
        <Kpi title="Spend efficiency" value={`${formatNumber(summary.messagesPerDollar)} msg/$`} />
        <Kpi title="Messages per dollar" value={formatNumber(summary.messagesPerDollar)} />
        <Kpi title="Tokens per message" value={formatNumber(summary.tokensPerMessage)} />
        <Kpi title="Output/input ratio" value={`${summary.outputInputRatio.toFixed(2)}x`} />
        <Kpi title="Cache hit rate" value={`${summary.cacheHitRate.toFixed(1)}%`} />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {cards.map((card) => (
          <div className="card p-4" key={card.title}>
            <p className="label">{formatCurrency(card.wastedCost)} estimated impact</p>
            <h3 className="mt-1 font-semibold">{card.title}</h3>
            <p className="mt-2 text-sm text-slate-600">{card.reason}</p>
            <div className="mt-3 text-sm">
              {card.sessions.slice(0, 3).map((session) => (
                <p key={session.id} className="truncate font-medium">
                  {session.sessionName}
                </p>
              ))}
            </div>
            <p className="mt-3 text-sm text-signal">{card.action}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <MiniSessionList title="Sessions with high token usage" sessions={highTokenSessions} />
        <MiniSessionList title="Low message count but high cost" sessions={lowMessageHighCost} />
        <MiniSessionList title="Large repeated context" sessions={repeatedContext} />
        <MiniSessionList title="Very high output tokens" sessions={highOutput} />
      </section>
    </div>
  );
}

function SessionsPage({
  sessions,
  selectedSession,
  sortKey,
  sortDirection,
  onSort,
  onSelect,
}: {
  sessions: ParsedSession[];
  selectedSession: ParsedSession | null;
  sortKey: SortKey;
  sortDirection: "asc" | "desc";
  onSort: (key: SortKey) => void;
  onSelect: (session: ParsedSession) => void;
}) {
  return (
    <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,420px)]">
      <section className="card min-w-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="border-b border-line bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <SortableHeader label="Date" sortKey="date" active={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHeader label="Session name" sortKey="sessionName" active={sortKey} direction={sortDirection} onSort={onSort} />
                <th className="px-3 py-2">Task heading</th>
                <SortableHeader label="Workspace" sortKey="workspace" active={sortKey} direction={sortDirection} onSort={onSort} />
                <th className="px-3 py-2 text-right">Child sessions</th>
                <SortableHeader label="Model" sortKey="model" active={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHeader label="Total tokens" sortKey="totalTokens" active={sortKey} direction={sortDirection} onSort={onSort} align="right" />
                <th className="px-3 py-2 text-right">Input</th>
                <th className="px-3 py-2 text-right">Cached</th>
                <th className="px-3 py-2 text-right">Output</th>
                <th className="px-3 py-2 text-right">Reasoning</th>
                <SortableHeader label="Estimated cost" sortKey="cost" active={sortKey} direction={sortDirection} onSort={onSort} align="right" />
                <SortableHeader label="Messages" sortKey="messages" active={sortKey} direction={sortDirection} onSort={onSort} align="right" />
                <SortableHeader label="Tool calls" sortKey="toolCalls" active={sortKey} direction={sortDirection} onSort={onSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr
                  key={session.id}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => onSelect(session)}
                >
                  <td className="whitespace-nowrap px-3 py-2">{formatDateTime(session.date)}</td>
                  <td className="px-3 py-2 font-medium">{session.sessionName}</td>
                  <td className="px-3 py-2">{session.taskHeading}</td>
                  <td className="px-3 py-2">{shortPath(session.workspace)}</td>
                  <td className="px-3 py-2 text-right">{formatNumber(session.childSessions?.length ?? 0)}</td>
                  <td className="px-3 py-2">{session.model}</td>
                  <td className="px-3 py-2 text-right">{formatNumber(session.usage.totalTokens)}</td>
                  <td className="px-3 py-2 text-right">{formatNumber(session.usage.inputTokens)}</td>
                  <td className="px-3 py-2 text-right">{formatNumber(session.usage.cachedInputTokens)}</td>
                  <td className="px-3 py-2 text-right">{formatNumber(session.usage.outputTokens)}</td>
                  <td className="px-3 py-2 text-right">{formatNumber(session.usage.reasoningOutputTokens)}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(session.estimatedCost)}</td>
                  <td className="px-3 py-2 text-right">{formatNumber(session.userMessages + session.assistantMessages)}</td>
                  <td className="px-3 py-2 text-right">{formatNumber(session.toolCalls)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="min-w-0">
        <SessionDetail session={selectedSession} />
      </div>
    </div>
  );
}

function SessionDetail({ session }: { session: ParsedSession | null }) {
  if (!session) {
    return <section className="card p-5 text-sm text-slate-600">Import sessions to see details.</section>;
  }

  const splitData = [
    { name: "Non-cached input", value: session.nonCachedInputTokens },
    { name: "Cached input", value: session.usage.cachedInputTokens },
    { name: "Output", value: session.usage.outputTokens },
  ];

  return (
    <aside className="grid min-w-0 gap-5">
      <section className="card min-w-0 p-5">
        <p className="label">Session detail</p>
        <h2 className="mt-1 break-words text-lg font-semibold">{session.sessionName}</h2>
        <p className="mt-2 break-words text-sm text-slate-600">{session.firstUserPrompt || "No user prompt was found."}</p>
        <div className="mt-4 grid gap-2 text-sm">
          <MetricLine label="Date" value={formatDateTime(session.date)} />
          <MetricLine label="Workspace" value={shortPath(session.workspace)} />
          <MetricLine label="Model" value={session.model} />
          <MetricLine label="Thread source" value={session.threadSource ?? "user"} />
          <MetricLine label="Child sessions" value={formatNumber(session.childSessions?.length ?? 0)} />
          <MetricLine label="Raw file" value={session.filePath} />
          <MetricLine label="Context window" value={session.modelContextWindow ? formatNumber(session.modelContextWindow) : "Unknown"} />
          <MetricLine label="Messages" value={formatNumber(session.userMessages + session.assistantMessages)} />
          <MetricLine label="Tool calls" value={formatNumber(session.toolCalls)} />
        </div>
      </section>

      <section className="card min-w-0 p-5">
        <h3 className="font-semibold">Estimated cost breakdown</h3>
        {session.childSessions?.length ? (
          <p className="mt-1 text-xs text-slate-500">Totals include this session plus child/subagent sessions.</p>
        ) : null}
        <div className="mt-3 grid gap-2 text-sm">
          <MetricLine label="Input tokens" value={formatNumber(session.usage.inputTokens)} />
          <MetricLine label="Cached input tokens" value={formatNumber(session.usage.cachedInputTokens)} />
          <MetricLine label="Non-cached input" value={formatNumber(session.nonCachedInputTokens)} />
          <MetricLine label="Output tokens" value={formatNumber(session.usage.outputTokens)} />
          <MetricLine label="Reasoning tokens" value={formatNumber(session.usage.reasoningOutputTokens)} />
          <MetricLine label="Estimated cost" value={formatCurrency(session.estimatedCost)} />
        </div>
      </section>

      {session.childSessions?.length ? (
        <section className="card min-w-0 p-5">
          <h3 className="font-semibold">Included child sessions</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="border-b border-line text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2">Time</th>
                  <th>Source</th>
                  <th className="text-right">Tokens</th>
                  <th className="text-right">Estimated cost</th>
                </tr>
              </thead>
              <tbody>
                {session.childSessions.map((child) => (
                  <tr key={child.id} className="border-b border-slate-100">
                    <td className="py-2">{formatDateTime(child.date)}</td>
                    <td>{child.source ?? child.threadSource ?? "child"}</td>
                    <td className="text-right">{formatNumber(child.usage.totalTokens)}</td>
                    <td className="text-right">{formatCurrency(child.estimatedCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <ChartCard title="Token growth through the session">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={session.tokenTimeline}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="timestamp" tickFormatter={(value) => formatLocalTime(String(value))} />
            <YAxis />
            <Tooltip labelFormatter={(value) => formatDateTime(String(value))} formatter={(value) => formatNumber(Number(value))} />
            <Line type="monotone" dataKey="totalTokens" stroke="#2563eb" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Cost growth through the session">
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={session.tokenTimeline}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="timestamp" tickFormatter={(value) => formatLocalTime(String(value))} />
            <YAxis />
            <Tooltip formatter={(value) => formatCurrency(Number(value))} />
            <Area type="monotone" dataKey="estimatedCost" stroke="#0f766e" fill="#99f6e4" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Input/output/cached token split">
        <PieBlock data={splitData} />
      </ChartCard>

      <section className="card min-w-0 p-5">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Parsed JSON preview</h3>
          <button className="btn" onClick={() => downloadSessionReport(session)}>
            Export session report
          </button>
        </div>
        {session.warnings.length ? (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber">
            {session.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ) : null}
        <pre className="mt-3 max-h-80 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
          {session.rawPreview}
        </pre>
      </section>
    </aside>
  );
}

function ReportsPage({ sessions, selectedSession }: { sessions: ParsedSession[]; selectedSession: ParsedSession | null }) {
  return (
    <section className="card p-5">
      <p className="label">Exports</p>
      <h2 className="mt-1 text-xl font-semibold">Download usage reports</h2>
      <div className="mt-5 grid gap-3 md:grid-cols-4">
        <button className="btn btn-primary" onClick={() => downloadCsv("codex-sessions.csv", sessions)}>
          Export CSV
        </button>
        <button className="btn" onClick={() => downloadJson("codex-sessions.json", sessions)}>
          Export JSON
        </button>
        <button className="btn" onClick={() => downloadMonthlySummary(sessions)}>
          Export monthly summary
        </button>
        <button className="btn" disabled={!selectedSession} onClick={() => selectedSession && downloadSessionReport(selectedSession)}>
          Export session-level report
        </button>
      </div>
    </section>
  );
}

function PricingPage({ pricing, onChange }: { pricing: PricingSettings; onChange: (pricing: PricingSettings) => void }) {
  function updateModel(index: number, key: keyof ModelPricing, value: string) {
    const models = pricing.models.map((model, currentIndex) =>
      currentIndex === index
        ? {
            ...model,
            [key]: key === "model" ? value : Number(value),
          }
        : model,
    );
    onChange({ ...pricing, models });
  }

  return (
    <section className="card p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="label">Estimated pricing</p>
          <h2 className="mt-1 text-xl font-semibold">Pricing settings</h2>
        </div>
        <button
          className="btn"
          onClick={() =>
            onChange({
              ...pricing,
              models: [...pricing.models, { model: "new-model", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0, reasoningOutputPerMillion: 0 }],
            })
          }
        >
          Add model
        </button>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <label>
          <span className="label">Display mode</span>
          <select className="field mt-1" value={pricing.mode} onChange={(event) => onChange({ ...pricing, mode: event.target.value as PricingSettings["mode"] })}>
            <option value="usd">USD mode</option>
            <option value="credits">Credits mode</option>
            <option value="both">Both</option>
          </select>
        </label>
        <label>
          <span className="label">Credit conversion rate</span>
          <input
            className="field mt-1"
            type="number"
            min="0"
            step="0.01"
            value={pricing.creditConversionRate}
            onChange={(event) => onChange({ ...pricing, creditConversionRate: Number(event.target.value) })}
          />
        </label>
        <div className="rounded-md border border-line bg-slate-50 p-3 text-sm text-slate-600">
          Reasoning tokens are shown as diagnostic data. They are not double-counted when already included in output tokens.
        </div>
      </div>

      <div className="mt-5 rounded-md border border-line bg-slate-50 p-4 text-sm text-slate-700">
        <h3 className="font-semibold text-ink">Cost formula</h3>
        <pre className="mt-3 overflow-auto rounded-md bg-white p-3 text-xs text-slate-800">
{`non_cached_input_tokens = max(input_tokens - cached_input_tokens, 0)

estimated_cost =
  (non_cached_input_tokens / 1,000,000 * input_price_per_1m)
  + (cached_input_tokens / 1,000,000 * cached_input_price_per_1m)
  + (output_tokens / 1,000,000 * output_price_per_1m)

estimated_credits = estimated_cost * credit_conversion_rate`}
        </pre>
        <p className="mt-3">
          Assumptions: `token_count.info.total_token_usage` is cumulative for the session, the largest/latest cumulative event is the final session total, output tokens already include reasoning tokens when the log reports both, and configured prices are user-maintained estimates.
        </p>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="border-b border-line text-xs uppercase text-slate-500">
            <tr>
              <th className="py-2">Model</th>
              <th>Input / 1M</th>
              <th>Cached input / 1M</th>
              <th>Output / 1M</th>
              <th>Reasoning output / 1M</th>
            </tr>
          </thead>
          <tbody>
            {pricing.models.map((model, index) => (
              <tr key={`${model.model}-${index}`} className="border-b border-slate-100">
                <td className="py-2 pr-3">
                  <input className="field" value={model.model} onChange={(event) => updateModel(index, "model", event.target.value)} />
                </td>
                <td className="pr-3">
                  <input className="field" type="number" step="0.001" value={model.inputPerMillion} onChange={(event) => updateModel(index, "inputPerMillion", event.target.value)} />
                </td>
                <td className="pr-3">
                  <input className="field" type="number" step="0.001" value={model.cachedInputPerMillion} onChange={(event) => updateModel(index, "cachedInputPerMillion", event.target.value)} />
                </td>
                <td className="pr-3">
                  <input className="field" type="number" step="0.001" value={model.outputPerMillion} onChange={(event) => updateModel(index, "outputPerMillion", event.target.value)} />
                </td>
                <td>
                  <input className="field" type="number" step="0.001" value={model.reasoningOutputPerMillion} onChange={(event) => updateModel(index, "reasoningOutputPerMillion", event.target.value)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AboutPage() {
  return (
    <section className="card p-5">
      <p className="label">About calculations</p>
      <div className="prose mt-2 max-w-none text-slate-700">
        <p>The app uses local Codex JSONL session logs selected by the user. It does not require or create a backend.</p>
        <p>Costs are estimates unless compared with official billing data. Pricing is editable and must be updated manually.</p>
        <p>Context window size is displayed as metadata. It is not treated as billable cost.</p>
        <p>The final or largest cumulative `token_count` event is treated as the session usage total.</p>
        <p>Cached input tokens can be priced differently from non-cached input tokens. Reasoning tokens are shown separately and are not double-counted if included in output tokens.</p>
        <pre className="overflow-auto rounded-md bg-slate-950 p-4 text-xs text-slate-100">
{`non_cached_input_tokens = max(input_tokens - cached_input_tokens, 0)

estimated_cost =
  (non_cached_input_tokens / 1,000,000 * input_price_per_1m)
  + (cached_input_tokens / 1,000,000 * cached_input_price_per_1m)
  + (output_tokens / 1,000,000 * output_price_per_1m)

estimated_credits = estimated_cost * credit_conversion_rate`}
        </pre>
        <p>Displayed dates use the browser timezone reported by `Intl.DateTimeFormat().resolvedOptions().timeZone`.</p>
      </div>
    </section>
  );
}

function Kpi({ title, value }: { title: string; value: string }) {
  return (
    <div className="card p-4">
      <p className="label">{title}</p>
      <p className="mt-2 break-words text-2xl font-semibold">{value}</p>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <h3 className="mb-3 font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function PieBlock({ data }: { data: Array<{ name: string; value: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Tooltip formatter={(value) => formatCurrency(Number(value))} />
        <Legend />
        <Pie data={data} dataKey="value" nameKey="name" outerRadius={88} label>
          {data.map((_, index) => (
            <Cell key={index} fill={COLORS[index % COLORS.length]} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-1 last:border-b-0">
      <span className="text-slate-500">{label}</span>
      <span className="min-w-0 break-words text-left font-medium">{value || "Unknown"}</span>
    </div>
  );
}

function MiniSessionList({ title, sessions }: { title: string; sessions: ParsedSession[] }) {
  return (
    <section className="card p-4">
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-3 grid gap-2 text-sm">
        {sessions.map((session) => (
          <div key={session.id} className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2">
            <span className="min-w-0 truncate font-medium">{session.sessionName}</span>
            <span className="whitespace-nowrap text-slate-600">{formatCurrency(session.estimatedCost)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SortableHeader({
  label,
  sortKey,
  active,
  direction,
  align,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  direction: "asc" | "desc";
  align?: "right";
  onSort: (key: SortKey) => void;
}) {
  return (
    <th className={`px-3 py-2 ${align === "right" ? "text-right" : ""}`}>
      <button className="font-semibold uppercase" onClick={() => onSort(sortKey)}>
        {label} {active === sortKey ? (direction === "asc" ? "up" : "down") : ""}
      </button>
    </th>
  );
}

function readStoredSessions(): ParsedSession[] {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
  } catch {
    return [];
  }
}

function readStoredPricing(): PricingSettings {
  try {
    return { ...DEFAULT_PRICING, ...JSON.parse(localStorage.getItem(PRICING_KEY) || "{}") };
  } catch {
    return DEFAULT_PRICING;
  }
}

function readStoredStats(): ImportStats | null {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY) || "null");
  } catch {
    return null;
  }
}

function recalculateSessions(sessions: ParsedSession[], pricing: PricingSettings): ParsedSession[] {
  return sessions.map((session) => {
    const cost = estimateCost(session.usage, session.model, pricing);
    return {
      ...session,
      childSessions: undefined,
      estimatedCost: cost,
      estimatedCredits: estimateCredits(cost, pricing),
      tokenTimeline: session.tokenTimeline.map((point) => ({
        ...point,
        estimatedCost: estimateCost(point, session.model, pricing),
      })),
    };
  });
}

function rollupChildSessions(sessions: ParsedSession[]): ParsedSession[] {
  const byThreadId = new Map<string, ParsedSession>();
  const rolledUp = sessions.map((session) => ({ ...session, childSessions: [] as ParsedSession[] }));

  rolledUp.forEach((session) => {
    if (session.sessionId) {
      byThreadId.set(session.sessionId, session);
    }
  });

  rolledUp.forEach((session) => {
    if (!session.parentThreadId || session.parentThreadId === session.sessionId) {
      return;
    }
    const parent = byThreadId.get(session.parentThreadId);
    if (!parent) {
      return;
    }

    parent.childSessions = [...(parent.childSessions ?? []), session].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    parent.userMessages += session.userMessages;
    parent.assistantMessages += session.assistantMessages;
    parent.toolCalls += session.toolCalls;
    parent.usage = addUsage(parent.usage, session.usage);
    parent.nonCachedInputTokens = Math.max(parent.usage.inputTokens - parent.usage.cachedInputTokens, 0);
    parent.estimatedCost += session.estimatedCost;
    parent.estimatedCredits += session.estimatedCredits;
    parent.warnings = [...parent.warnings, ...session.warnings.map((warning) => `${session.fileName}: ${warning}`)];
  });

  return rolledUp.filter((session) => {
    if (!session.parentThreadId || session.parentThreadId === session.sessionId) {
      return true;
    }
    return !byThreadId.has(session.parentThreadId);
  });
}

function addUsage(a: ParsedSession["usage"], b: ParsedSession["usage"]): ParsedSession["usage"] {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function applyFilters(sessions: ParsedSession[], filters: Filters): ParsedSession[] {
  return sessions.filter((session) => {
    const date = new Date(session.date);
    if (filters.month && localMonthKey(session.date) !== filters.month) {
      return false;
    }
    if (filters.startDate && date.getTime() < new Date(`${filters.startDate}T00:00:00`).getTime()) {
      return false;
    }
    if (filters.endDate && date.getTime() > new Date(`${filters.endDate}T23:59:59.999`).getTime()) {
      return false;
    }
    if (filters.model && session.model !== filters.model) {
      return false;
    }
    if (filters.workspace && session.workspace !== filters.workspace) {
      return false;
    }
    const search = filters.search.trim().toLowerCase();
    if (
      search &&
      !`${session.sessionName} ${session.taskHeading} ${session.firstUserPrompt} ${session.fileName}`
        .toLowerCase()
        .includes(search)
    ) {
      return false;
    }
    if (filters.minCost && session.estimatedCost < Number(filters.minCost)) {
      return false;
    }
    if (filters.maxCost && session.estimatedCost > Number(filters.maxCost)) {
      return false;
    }
    if (filters.minTokens && session.usage.totalTokens < Number(filters.minTokens)) {
      return false;
    }
    if (filters.maxTokens && session.usage.totalTokens > Number(filters.maxTokens)) {
      return false;
    }
    return true;
  });
}

function buildSummary(sessions: ParsedSession[]) {
  const totalCost = sum(sessions, (session) => session.estimatedCost);
  const messages = sum(sessions, (session) => session.userMessages + session.assistantMessages);
  const inputTokens = sum(sessions, (session) => session.usage.inputTokens);
  const cachedTokens = sum(sessions, (session) => session.usage.cachedInputTokens);
  const outputTokens = sum(sessions, (session) => session.usage.outputTokens);
  const totalTokens = sum(sessions, (session) => session.usage.totalTokens);
  return {
    totalCost,
    totalCredits: sum(sessions, (session) => session.estimatedCredits),
    totalTokens,
    inputTokens,
    cachedTokens,
    outputTokens,
    reasoningTokens: sum(sessions, (session) => session.usage.reasoningOutputTokens),
    sessions: sessions.length,
    messages,
    avgCostPerSession: sessions.length ? totalCost / sessions.length : 0,
    avgCostPerMessage: messages ? totalCost / messages : 0,
    avgTokensPerSession: sessions.length ? totalTokens / sessions.length : 0,
    cacheHitRate: inputTokens ? (cachedTokens / inputTokens) * 100 : 0,
    messagesPerDollar: totalCost ? messages / totalCost : 0,
    tokensPerMessage: messages ? totalTokens / messages : 0,
    outputInputRatio: inputTokens ? outputTokens / inputTokens : 0,
  };
}

function buildDailyData(sessions: ParsedSession[]) {
  const grouped = new Map<string, ParsedSession[]>();
  sessions.forEach((session) => {
    const key = localDateKey(session.date);
    grouped.set(key, [...(grouped.get(key) ?? []), session]);
  });

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, daySessions]) => {
      const summary = buildSummary(daySessions);
      return {
        date,
        cost: Number(summary.totalCost.toFixed(6)),
        tokens: summary.totalTokens,
        nonCachedInput: summary.inputTokens - summary.cachedTokens,
        cached: summary.cachedTokens,
        output: summary.outputTokens,
        sessions: summary.sessions,
        messagesPerSession: summary.sessions ? summary.messages / summary.sessions : 0,
        cacheHitRate: summary.cacheHitRate,
        costPerMessage: summary.avgCostPerMessage,
      };
    });
}

function groupMoney(sessions: ParsedSession[], key: "workspace" | "model") {
  const grouped = new Map<string, number>();
  sessions.forEach((session) => {
    const label = key === "workspace" ? shortPath(session.workspace) : session.model;
    grouped.set(label, (grouped.get(label) ?? 0) + session.estimatedCost);
  });
  return [...grouped.entries()]
    .map(([name, value]) => ({ name, value: Number(value.toFixed(6)) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

function buildEfficiencyCards(sessions: ParsedSession[]) {
  const avgCost = sessions.length ? sum(sessions, (session) => session.estimatedCost) / sessions.length : 0;
  const highCostShort = sessions.filter(
    (session) => session.estimatedCost > avgCost * 1.5 && session.userMessages + session.assistantMessages <= 4,
  );
  const lowCache = sessions.filter((session) => session.usage.inputTokens > 20000 && session.usage.cachedInputTokens / session.usage.inputTokens < 0.25);
  const largeInputSmallOutput = sessions.filter((session) => session.usage.inputTokens > session.usage.outputTokens * 20 && session.usage.inputTokens > 10000);
  const byWorkspace = new Map<string, ParsedSession[]>();
  sessions.forEach((session) => byWorkspace.set(session.workspace, [...(byWorkspace.get(session.workspace) ?? []), session]));
  const manySameWorkspace = [...byWorkspace.values()].filter((group) => group.length >= 5).flat();
  const possibleDuplicate = findDuplicateSessions(sessions);
  const efficient = sessions
    .filter((session) => session.estimatedCost <= avgCost && session.userMessages + session.assistantMessages >= 6)
    .slice(0, 5);

  return [
    {
      title: "High-cost short session",
      reason: "A small number of messages consumed more than the average session spend.",
      sessions: highCostShort,
      wastedCost: sum(highCostShort, (session) => Math.max(session.estimatedCost - avgCost, 0)),
      action: "Batch context and continue the same thread when the task is still active.",
    },
    {
      title: "Low cache reuse",
      reason: "Large input payloads show a low cached-token share.",
      sessions: lowCache,
      wastedCost: sum(lowCache, (session) => session.estimatedCost * 0.15),
      action: "Keep stable instructions and files in the same session to improve reuse.",
    },
    {
      title: "Large input, small output",
      reason: "The session sent much more context than it received back.",
      sessions: largeInputSmallOutput,
      wastedCost: sum(largeInputSmallOutput, (session) => session.estimatedCost * 0.2),
      action: "Narrow file scope before asking for a targeted answer.",
    },
    {
      title: "Many sessions in same workspace",
      reason: "Several sessions were opened against the same project path.",
      sessions: manySameWorkspace,
      wastedCost: sum(manySameWorkspace, (session) => session.estimatedCost * 0.1),
      action: "Reuse a thread for related work until the task boundary changes.",
    },
    {
      title: "Possible duplicate task",
      reason: "Session headings look similar across different files.",
      sessions: possibleDuplicate,
      wastedCost: sum(possibleDuplicate, (session) => session.estimatedCost * 0.25),
      action: "Search existing sessions before restarting a similar request.",
    },
    {
      title: "Good efficient session",
      reason: "These sessions had useful interaction counts without above-average spend.",
      sessions: efficient,
      wastedCost: 0,
      action: "Use these as a reference for prompt size and session continuity.",
    },
  ];
}

function findDuplicateSessions(sessions: ParsedSession[]) {
  const seen = new Map<string, ParsedSession[]>();
  sessions.forEach((session) => {
    const key = session.sessionName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
    if (key.length >= 8) {
      seen.set(key, [...(seen.get(key) ?? []), session]);
    }
  });
  return [...seen.values()].filter((group) => group.length > 1).flat();
}

function sortSessions(sessions: ParsedSession[], key: SortKey, direction: "asc" | "desc") {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...sessions].sort((a, b) => {
    const valueA = sortValue(a, key);
    const valueB = sortValue(b, key);
    if (typeof valueA === "number" && typeof valueB === "number") {
      return (valueA - valueB) * multiplier;
    }
    return String(valueA).localeCompare(String(valueB)) * multiplier;
  });
}

function sortValue(session: ParsedSession, key: SortKey) {
  switch (key) {
    case "date":
      return new Date(session.date).getTime();
    case "sessionName":
      return session.sessionName;
    case "workspace":
      return session.workspace;
    case "model":
      return session.model;
    case "totalTokens":
      return session.usage.totalTokens;
    case "cost":
      return session.estimatedCost;
    case "messages":
      return session.userMessages + session.assistantMessages;
    case "toolCalls":
      return session.toolCalls;
  }
}

function sum<T>(items: T[], selector: (item: T) => number) {
  return items.reduce((total, item) => total + selector(item), 0);
}

function unique(items: string[]) {
  return [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function shortPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : path;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: value > 100 ? 0 : 2 }).format(value || 0);
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value || 0);
}

function formatDateTime(value: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: getBrowserTimeZone(),
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatLocalTime(value: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: getBrowserTimeZone(),
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function localDateKey(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: getBrowserTimeZone(),
  }).format(new Date(value));
}

function localMonthKey(value: string) {
  return localDateKey(value).slice(0, 7);
}

function getBrowserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local timezone";
}

async function readJsonlFilesWithProgress(
  files: FileList,
  setProgress: (progress: ImportProgress) => void,
): Promise<Array<{ name: string; path: string; text: string }>> {
  const fileList = Array.from(files).filter((file) => isSessionFile(file.webkitRelativePath || file.name));
  const result: Array<{ name: string; path: string; text: string }> = [];

  for (const [index, file] of fileList.entries()) {
    const path = file.webkitRelativePath || file.name;
    setProgress({ phase: "reading", total: fileList.length, processed: index, currentFile: path });
    await yieldToBrowser();
    result.push({ name: file.name, path, text: await file.text() });
  }

  return result;
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

export default App;
