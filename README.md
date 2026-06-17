# Codex Usage Tracker

This repo is a local Vite + React dashboard for inspecting Codex session logs from `~/.codex/sessions` or exported `.jsonl`/`.zip` files. It parses Codex JSONL events in the browser, estimates token usage and spend, rolls child sessions into parent sessions, and shows dashboards for cost, tokens, efficiency, and per-session diagnostics.

## What it does

- Imports local Codex session logs from a folder, zip, or individual `.jsonl` files
- Parses session metadata, message counts, tool calls, token totals, reasoning effort, and child-session relationships
- Estimates cost from editable pricing rules in the browser
- Shows dashboards for spend, token trends, cache reuse, workspace/model breakdowns, and efficiency heuristics
- Exports CSV, JSON, monthly summaries, and session-level reports
- Explains why a selected session was expensive and suggests ways to reduce future Codex cost

## How to run

Requirements:

- Node.js 18+ is the safe baseline
- `npm`

Install and start:

```bash
npm install
npm run dev
```

Open the local Vite URL shown in the terminal, then import Codex session files from the UI.

Other commands:

```bash
npm run build
npm run preview
```

## How the app works

1. `src/App.tsx` handles navigation, import actions, filtering, dashboard pages, and session detail rendering.
2. `src/lib/parser.ts` reads JSONL session events and extracts the fields the UI needs.
3. `src/lib/pricing.ts` applies the cost formula using per-model prices.
4. `src/lib/export.ts` downloads session data and summaries.
5. Imported sessions and pricing are cached in `localStorage`, so the app is fully local and does not require a backend.

## Pricing assumptions

Estimated cost is calculated as:

```text
non_cached_input_tokens = max(input_tokens - cached_input_tokens, 0)

estimated_cost =
  (non_cached_input_tokens / 1,000,000 * input_price_per_1m)
  + (cached_input_tokens / 1,000,000 * cached_input_price_per_1m)
  + (output_tokens / 1,000,000 * output_price_per_1m)
```

Notes:

- The app uses the latest or largest cumulative `token_count` event as the final session usage.
- Reasoning tokens are shown as diagnostics and are not double-counted when they are already included in output tokens.
- Pricing is user-maintained and should be treated as an estimate unless matched to real billing.

## Cost-optimization basis

The session analysis and savings guidance in this repo are based on `AI_Usage_Optimization_Complete_Guide_v3_1.md` dated `2026-06-15`. The guidance mainly targets:

- large non-cached context
- low cache reuse
- broad repo scans
- verbose output
- excessive tool loops or child sessions
- using high reasoning effort for small tasks
- restarting similar work without a compact handoff

## Repo guide

See [REPO_FLOW.md](/home/msi/Documents/codex-usage-ui/REPO_FLOW.md) for the current file map, data flow, and implementation notes.
