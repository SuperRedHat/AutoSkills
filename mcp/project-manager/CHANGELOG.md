# Changelog — project-manager MCP

All notable changes to the project-manager MCP server.

## [1.3.0] — 2026-06-08 — cross-project / portfolio (read-only)

Additive, backward-compatible. Addresses feedback L6 (module-global active project;
no cross-project reference). Design: `AutoSkills/docs/adr-003-cross-project-portfolio.md`.

### Added
- **Per-call `project_dir` on all 10 read tools** (`get_project_info` / `get_prd` /
  `get_architecture` / `get_all_tasks` / `get_task_by_id` / `get_next_task` / `get_logs` /
  `get_project_context` / `get_current_focus` / `get_server_info`): read another project's state
  **without switching the active project**. Never reassigns the module-global; paths are
  canonicalized (symlink / Windows case / UNC); a non-project dir returns a classified error
  (`not_a_project` / `state_unreadable`). `get_server_info` echoes `resolved` / `active_project`.
- **`get_portfolio(project_dirs[])`** — read-only cross-project aggregator (per project:
  name, status, dual-rate metrics, current_focus, next_task, next_task_blocked_reason). Per-call
  list **only**; never reads a registry. A bad dir yields a per-entry error without sinking others.
- New module `src/project_dir.ts` (`resolveProjectDir` safety contract) + `StateManager.getPortfolioSummary`.

### Compatibility
- Fully backward compatible: `project_dir` is optional everywhere (omitted = active project,
  unchanged output); `set_project_dir` and the single-active-project default are untouched; no new
  schema_version.

### Deferred
- Cross-project **writes** (write tools do not accept `project_dir`), portfolio **registry file**,
  cross-project **pointer task type**.

## [1.2.0] — 2026-06-08 — backlog completion (priority / batch / reopen / external profiles)

Additive, backward-compatible. Completes the original feedback backlog (L4 / L5 / L9)
plus reopen. Design: `AutoSkills/docs/adr-002-project-manager-backlog-completion.md`.

### Added
- **Task priority** (`priority?: number`, default 0, higher = more urgent). `get_next_task` now
  returns the highest-priority **runnable** todo, ties broken by creation order; priority **never**
  overrides dependency gating. New `set_task_priority` tool. (L5)
- **Batch operations** (L4): `update_tasks` (batch forward transitions, per-item partial success,
  each still validated), `close_tasks` (batch close), `archive_module(module, reason)` (cancel all
  non-terminal tasks in a module).
- **`reopen_task(id, reason, to_status?)`** — audited reverse of `close_task`: brings a terminal
  task (`done` / `cancelled` / `superseded`) back to `todo` (default) or `in_progress`. Reopening a
  superseded task clears `replacement_task_id` (dependents rewired at supersede time are NOT
  auto-restored; the audit log flags it). The single audited reverse edge out of a terminal state —
  supersedes the 1.1.0 "no reopen in v1" non-goal.

### Changed
- **`verification_profile`** names are validated at runtime against the external
  `~/.workflow-core/policies/verification-profiles.json` (no longer a hardcoded enum). Adding a
  profile is a JSON-only edit; unknown names are rejected (lenient only if the file is missing). (L9)

### Compatibility
- Fully backward compatible: `priority` defaults to 0 (= legacy creation-order scheduling); all new
  tools are additive; **no new schema_version** (normalizeTask defaults `priority` on read). Deploys
  together with 1.1.0.

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
