# Agent-side configuration

Everything the Base44 agent runs outside the deployed Worker.

## workflows/
Server-side workflow definitions (CNCF SWF v1.0 jsonc), currently **inactive**:
- `MSE Daily ETL` — weekday 09:00/13:00/15:30 CAT scrape + dual-write (Base44 + Neon)
- `MSE Announcement Sweep` — Mondays 08:00, company announcements into MseAnnouncement
- `MSE Model Report` — Saturdays 09:00, model run + AI sentiment + Telegram report
  (contains the agent prompt for the report step — `invoke_superagent_step`)
- `MSE Final Scrape` — end-of-day catch-up sweep

Agent prompts live inline inside these definitions (there are no separate skill files);
the Model Report definition is the one carrying a full agent prompt.

## scripts/
Archival one-off scripts used during data ops (kept for reference, not part of CI):
- `runMseEtl`-adjacent shell drivers: `run_import.sh`, `run_jf.sh`, `run_sep.sh`,
  `supervisor.sh`, `supervisor2.sh` — backfill driver loops (note: in-sandbox nohup
  loops don't survive sandbox suspension; the durable replacement is the
  chunk-queue + workflow pattern documented in docs/PROJECT.md)
- `verify.mjs`, `check_neon.mjs`, `debug_index*.mjs` — Neon verification/debugging
- `mk_signals_table.mjs`, `neon_pbv.mjs`, `raw_close_neon.mjs` — Neon DDL / column backfills
- `grant_read.mjs` — grants read-only access on the Neon DB

All credentials come from platform env vars (DATABASE_URL etc.) — nothing hardcoded.

See `docs/PROJECT.md` for the overall data flow and `backend-functions/` for the
functions these workflows invoke.
