# Repo Flow Guide

This file explains the current structure and execution flow of the repo.

## Top-level files

| Path | Purpose |
|---|---|
| `package.json` | Vite app scripts and dependencies |
| `index.html` | App mount point |
| `tailwind.config.ts` | Tailwind theme tokens |
| `postcss.config.js` | PostCSS config |
| `codex-metrics.jsonl` | Sample session log file for local testing/import |

## Source files

| Path | Purpose |
|---|---|
| `src/main.tsx` | React entry point |
| `src/App.tsx` | Main app, page switching, filtering, charts, session detail, heuristics |
| `src/types.ts` | Shared TypeScript types for sessions, pricing, and filters |
| `src/lib/parser.ts` | Reads JSONL events and builds `ParsedSession` objects |
| `src/lib/pricing.ts` | Cost and credit estimation helpers |
| `src/lib/export.ts` | CSV/JSON/session report export helpers |
| `src/index.css` | Shared Tailwind component classes and global styling |

## Runtime flow

1. The user opens the app and imports a folder, zip, or one or more `.jsonl` files.
2. `readFilesFromDirectory` or the upload handlers collect raw text files.
3. `parseSessionFile` reads each JSONL line and extracts:
   - session metadata
   - timestamps and duration
   - workspace path
   - model name
   - reasoning effort
   - user/assistant message counts
   - tool call count
   - cumulative token usage
   - token timeline points
4. `recalculateSessions` re-applies current pricing to all parsed sessions.
5. `rollupChildSessions` merges child/subagent sessions into the parent thread totals.
6. The UI builds summaries, charts, efficiency cards, and sortable session tables from the parsed data.
7. The selected session page shows:
   - session metadata
   - cost breakdown
   - child sessions
   - token and cost charts
   - parsed JSON preview
   - high-cost diagnosis
   - cost-saving suggestions

## Session-cost analysis flow

The session detail page now computes a local diagnosis from imported session data. The logic checks for patterns that usually drive Codex cost:

- too much non-cached input relative to output
- low cache-hit rate on large inputs
- high-cost sessions with very few messages
- very large output payloads
- heavy tool-call or child-session activity
- high reasoning effort on small sessions
- repeated sessions in the same workspace
- similar task headings that imply duplicated work

These heuristics are intentionally explanatory, not billing-accurate. They help a user understand likely causes of spend in the source Codex session file.

## Important assumptions

- The app is frontend-only. There is no backend or database.
- Local browser storage holds imported sessions, pricing, and import stats.
- The parser trusts the latest/largest cumulative `token_count` event more than intermediate events.
- Child sessions are rolled into the parent so parent totals can exceed any single raw JSONL file's top-level event totals.
- `rawPreview` is only a preview slice of the imported JSONL source, not the full file body.

## Current UI pages

| Page | Purpose |
|---|---|
| `Import` | Load local session files and review import warnings |
| `Dashboard` | Global KPIs and charts |
| `Efficiency` | Heuristic cards for waste patterns and efficient sessions |
| `Sessions` | Sortable session list with deep detail for one selected session |
| `Reports` | Download exported data |
| `Pricing` | Adjust model prices and cost assumptions |
| `About` | Explain formulas and calculation assumptions |

## How to extend the repo safely

- Add new parsed fields in `src/types.ts` first.
- Extract them from JSONL in `src/lib/parser.ts`.
- Keep pricing logic in `src/lib/pricing.ts` so UI pages stay presentation-focused.
- Reuse `buildSummary`, `buildDailyData`, and similar helpers before adding new duplicated calculations.
- When adding new session heuristics, keep them explainable from parsed source data and label them as estimates rather than exact billing facts.
