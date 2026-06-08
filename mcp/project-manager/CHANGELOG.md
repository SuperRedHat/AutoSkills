# Changelog — project-manager MCP

All notable changes to the project-manager MCP server.

## [1.1.0] — 2026-06-08 — ops / management capabilities (schema v1)

Additive, backward-compatible release adding operational / management / rich-recovery
capabilities **without weakening** the auditable forward state machine. Design:
`AutoSkills/docs/adr-001-project-manager-ops-capabilities.md`.

### Added
- **`close_task(id, status, reason, replacement_task_id?)`** — audited management bypass that
  retires a task to the new terminal states `cancelled` / `superseded` (never `done`, only from a
  non-terminal source; no reopen in v1). `superseded` rewrites every dependent edge to the
  replacement (DAG stays runnable); `cancelled` with live dependents emits a
  `dependents_blocked_by_cancel` ops_event. Validates the replacement (exists / not self / not
  closed / no replacement-chain cycle). Writes a `task_closed` audit log.
- **Terminal states `cancelled` / `superseded`** on `Task.status` (now a 7-value enum). Reachable
  only via `close_task`; `update_task_status` rejects them with a "use close_task" error.
- **`get_current_focus` / `set_current_focus`** — single-slot ops focus snapshot in
  `.claude/state/focus.json` (server-computed `is_stale`).
- **`get_project_context`** additively returns `in_progress_tasks`, `tasks_summary.metrics`
  (dual `raw_completion_rate` / `active_completion_rate` + cancelled/superseded counts),
  `tasks_summary.next_task_blocked_reason`, `current_focus`, `schema_version`; new optional params
  `context_mode` (presentation hint only — never a filter), `max_recent_events`,
  `include_full_in_progress`.
- **`add_log`** accepts `kind` / `event_type` / `tags` / `entities` / `source`; `task_id` may be
  `null` for a project-level ops event.
- **`get_logs`** accepts `{ kind, event_type, since, limit }` and **filters before slicing**
  (journal view).
- **`migrate_tasks_schema`** v0→v1: idempotent, **never** changes task status, backfills log
  `kind` / `event_type`, stamps `schema_version = 1`.
- **Test harness**: vitest + 50 tests, fixtures copied from real project state.

### Changed
- `getNextTask` treats cancelled/superseded as closed-but-not-done: superseded deps resolve via the
  replacement chain; a cancelled dep blocks its dependents (surfaced via `next_task_blocked_reason`
  + ops_event, never a silent deadlock).
- `updateProjectProgress` progress object is now **additive**: legacy
  `{ total, done, in_progress, awaiting_acceptance, todo }` preserved (unchanged meaning) plus the
  new dual-rate fields.

### Compatibility
- Fully backward compatible: legacy fields and the forward state machine are unchanged; all new
  fields are additive/optional. Old readers / old dist keep working. Migration is lazy (first-touch,
  read paths compute new fields on the fly) or opt-in batch via `bootstrap --migrate-state=<dirs>`.

## [1.0.0] — initial
- PRD / architecture / tasks / logs persistence + cross-session context recovery; strict forward
  state machine with acceptance modes.
