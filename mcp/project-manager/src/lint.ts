// lint_state (ADR-004 §3): read-only consistency checks across the four on-disk
// truths (tasks.json / project.json / logs.json / focus.json). PURE: runLint takes a
// data bundle and returns findings — no fs, no Date.now (now is injected) — so it is
// fully unit-testable and cross-project-safe. Detection mirrors the engine's own walks
// (depSatisfied / endsCancelled / validateReplacement) rather than reimplementing them,
// and downgrades/suppresses on pre-migration & cross-project data per the red-team.
import type { Task, ProjectInfo, LogEntry, CurrentFocus } from "./state.js";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  task_id?: string | null;
  entities?: Record<string, unknown>;
  /** True only for findings reconcile may auto-fix deterministically (ADR-004 §3.4). */
  autofixable?: boolean;
}

export interface LintResult {
  findings: Finding[];
  summary: { error: number; warning: number; info: number; total: number };
}

export interface LintBundle {
  tasksRaw: Task[]; // un-normalized (duplicate-id / unknown-status see disk truth)
  tasks: Task[]; // normalized (replacement_task_id ?? null, defaults filled)
  actualProgress: ProjectInfo["progress"] | null;
  expectedProgress: ProjectInfo["progress"] | null;
  projectStatus: string | null;
  schemaVersion: number;
  currentSchemaVersion: number;
  logs: LogEntry[];
  focus: CurrentFocus | null;
  validProfiles: string[]; // [] when the policy file is missing -> flag no profiles
  crossProject: boolean; // suppress machine-local checks (profiles / schema / focus)
}

const TERMINAL = ["done", "cancelled", "superseded"];
const ACTIVE = ["todo", "in_progress", "auto_verified", "awaiting_manual_acceptance"];
const STATUS_SET = new Set([...ACTIVE, ...TERMINAL]);
const COUNT_KEYS = [
  "total",
  "done",
  "in_progress",
  "awaiting_acceptance",
  "todo",
  "total_all",
  "active_total",
  "cancelled",
  "superseded",
  "closed_total",
] as const;
const RATE_KEYS = ["raw_completion_rate", "active_completion_rate"] as const;
const ADDITIVE_KEYS = new Set([
  "total_all",
  "active_total",
  "cancelled",
  "superseded",
  "closed_total",
  "raw_completion_rate",
  "active_completion_rate",
]);

function parseTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Resolve a dependency the way getNextTask.depSatisfied does (state.ts), but capture
 * WHY it failed so each bad edge yields exactly one classification.
 *  ok            -> resolves to a done task (incl. healthy superseded->done chain)
 *  pending       -> waits on a not-yet-done active task (NORMAL, not a finding)
 *  dangling      -> first hop missing (no superseded traversed)
 *  cancelled     -> chain bottoms out in a cancelled dead-end
 *  superseded    -> traversed a superseded node but chain is broken (missing/no-repl/non-done)
 *  cycle         -> replacement chain loops (owned by replacement_chain_cycle)
 */
function classifyDep(
  byId: Map<string, Task>,
  depId: string
): { kind: "ok" | "pending" | "dangling" | "cancelled" | "superseded" | "cycle"; at?: string; reason?: string } {
  const seen = new Set<string>();
  let cur: string | null | undefined = depId;
  let traversedSuperseded = false;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const dt = byId.get(cur);
    if (!dt) return { kind: traversedSuperseded ? "superseded" : "dangling", at: cur, reason: "missing_id" };
    if (dt.status === "done") return { kind: "ok" };
    if (dt.status === "cancelled") return { kind: "cancelled", at: cur };
    if (dt.status === "superseded") {
      if (dt.replacement_task_id) {
        traversedSuperseded = true;
        cur = dt.replacement_task_id;
        continue;
      }
      return { kind: "superseded", at: cur, reason: "no_replacement" };
    }
    // An active, not-yet-done end node means the chain is INTACT — just unfinished —
    // whether or not we traversed a superseded husk to get here. getNextTask.depSatisfied
    // returns false for this too (the dep is held back, NOT broken). Only a missing id /
    // no-replacement / cancelled terminus is a genuinely broken superseded chain.
    return { kind: "pending", at: cur };
  }
  return { kind: "cycle", at: cur ?? undefined };
}

export function runLint(b: LintBundle): LintResult {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  const byId = new Map(b.tasks.map((t) => [t.id, t]));
  const idSet = new Set(b.tasks.map((t) => t.id));

  // ===== structural: duplicate / unknown ids & statuses (over RAW disk data) =====
  const idCounts = new Map<string, number>();
  for (const t of b.tasksRaw) {
    const key = String(t.id);
    idCounts.set(key, (idCounts.get(key) ?? 0) + 1);
  }
  for (const [id, n] of idCounts) {
    // A blank id is a distinct defect class from a real duplicate — give it its own
    // code and make the two branches mutually exclusive (no double-fire on a blank id
    // that also happens to repeat).
    if (!id.trim()) {
      add({
        code: "blank_task_id",
        severity: "error",
        task_id: id,
        message: `Empty/whitespace task id — ids must be non-empty.`,
        entities: { count: n },
      });
      continue;
    }
    if (n > 1) {
      add({
        code: "duplicate_task_id",
        severity: "error",
        task_id: id,
        message: `Task id "${id}" appears ${n} times — id must be unique (keyed lookups are last-write-wins).`,
        entities: { id, count: n },
      });
    }
  }
  for (const t of b.tasksRaw) {
    if (!STATUS_SET.has(t.status)) {
      add({
        code: "unknown_status_value",
        severity: "error",
        task_id: t.id,
        message: `Task ${t.id} has unknown status "${t.status}" (outside the 7-value set) — frozen by the state machine and miscounted in progress.`,
        entities: { status: t.status },
      });
    }
  }

  // ===== dependency DAG (over normalized tasks) =====
  for (const t of b.tasks) {
    // duplicate dep ids within one task (warning) — over the raw array
    const depCounts = new Map<string, number>();
    for (const d of t.dependencies) depCounts.set(d, (depCounts.get(d) ?? 0) + 1);
    for (const [d, n] of depCounts) {
      if (n > 1) {
        add({
          code: "duplicate_dependency_id",
          severity: "warning",
          task_id: t.id,
          message: `Task ${t.id} lists dependency "${d}" ${n} times — duplicate edge inflates apparent fan-in.`,
          entities: { dependency_id: d, count: n },
        });
      }
    }
    // self-dependency (error) — over all tasks. Auto-fixable ONLY on active tasks:
    // reconcile refuses to rewrite a terminal task's frozen dependency history, so a
    // terminal self-dep is reported but not auto-fixable (the flag must say so).
    if (t.dependencies.includes(t.id)) {
      add({
        code: "self_dependency",
        severity: "error",
        task_id: t.id,
        message: `Task ${t.id} depends on itself — permanently unrunnable.`,
        entities: { task_id: t.id },
        autofixable: !TERMINAL.includes(t.status),
      });
    }
  }

  // dependency cycles (>=2 nodes) over dependency edges only (skip dangling/self)
  {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const reported = new Set<string>();
    const stackPath: string[] = [];
    const dfs = (id: string) => {
      color.set(id, GRAY);
      stackPath.push(id);
      const t = byId.get(id);
      if (t) {
        for (const d of t.dependencies) {
          if (d === id) continue; // self-loop owned by self_dependency
          const dt = byId.get(d);
          // Only ACTIVE nodes/edges form a scheduling deadlock: a dep on a `done` task
          // is satisfied (breaks the cycle), and dangling targets are owned by
          // dangling_dependency. So a cycle among already-terminal tasks is NOT flagged.
          if (!dt || !ACTIVE.includes(dt.status)) continue;
          const c = color.get(d) ?? WHITE;
          if (c === WHITE) dfs(d);
          else if (c === GRAY) {
            // back-edge -> cycle from d .. current
            const idx = stackPath.indexOf(d);
            const cycle = stackPath.slice(idx);
            const key = [...cycle].sort().join("|");
            if (!reported.has(key)) {
              reported.add(key);
              add({
                code: "dependency_cycle",
                severity: "error",
                task_id: cycle[0],
                message: `Dependency cycle: ${cycle.join(" -> ")} -> ${d}. Every task in it is permanently unrunnable.`,
                entities: { cycle },
              });
            }
          }
        }
      }
      stackPath.pop();
      color.set(id, BLACK);
    };
    for (const t of b.tasks) {
      if (ACTIVE.includes(t.status) && (color.get(t.id) ?? WHITE) === WHITE) dfs(t.id);
    }
  }

  // per-dependent resolution failures (only for ACTIVE dependents — the scheduler cohort)
  for (const t of b.tasks) {
    if (!ACTIVE.includes(t.status)) continue;
    for (const d of t.dependencies) {
      if (d === t.id) continue; // self owned above
      const cls = classifyDep(byId, d);
      const direct = byId.get(d);
      if (cls.kind === "dangling") {
        add({
          code: "dangling_dependency",
          severity: "error",
          task_id: t.id,
          message: `Task ${t.id} depends on "${d}" which does not exist.`,
          entities: { task_id: t.id, missing_dependency_id: d },
        });
      } else if (cls.kind === "cancelled") {
        add({
          code: "runnable_dep_on_cancelled_deadend",
          severity: "warning",
          task_id: t.id,
          message: `Task ${t.id} depends on cancelled task "${cls.at}" (dead-end) — can never run. Re-point or close it.`,
          entities: { task_id: t.id, dependency_id: d, cancelled_dead_end_id: cls.at },
        });
      } else if (cls.kind === "superseded") {
        const isMissing = cls.reason === "missing_id";
        add({
          code: "superseded_replacement_chain_broken",
          severity: isMissing ? "error" : "warning",
          task_id: t.id,
          message: `Task ${t.id} depends on superseded "${d}" whose replacement chain is broken (${cls.reason} at ${cls.at}).`,
          entities: { task_id: t.id, dependency_id: d, broken_at_id: cls.at, reason: cls.reason },
        });
      } else if (cls.kind === "ok" && direct && direct.status === "superseded") {
        add({
          code: "dep_on_superseded_husk_not_rewired",
          severity: "info",
          task_id: t.id,
          message: `Task ${t.id} still depends on superseded husk "${d}" (chain resolves to done). Consider re-pointing to ${direct.replacement_task_id}.`,
          entities: { task_id: t.id, superseded_dependency_id: d, replacement_task_id: direct.replacement_task_id },
        });
      }
    }
  }

  // ===== close / supersede / terminal field integrity =====
  for (const t of b.tasks) {
    if (t.status === "superseded" && t.replacement_task_id == null) {
      add({
        code: "superseded_missing_replacement",
        // pre-migration data predates the replacement-required invariant -> warning
        severity: b.schemaVersion < b.currentSchemaVersion ? "warning" : "error",
        task_id: t.id,
        message: `Superseded task ${t.id} has no replacement_task_id — dependents stall with no surfaced reason.`,
        entities: { status: t.status },
      });
    }
    if (t.replacement_task_id != null && !idSet.has(t.replacement_task_id)) {
      add({
        code: "replacement_target_missing",
        severity: "error",
        task_id: t.id,
        message: `Task ${t.id}.replacement_task_id "${t.replacement_task_id}" points at a non-existent task.`,
        entities: { replacement_task_id: t.replacement_task_id, status: t.status },
      });
    }
    if (t.replacement_task_id != null && t.status !== "superseded") {
      add({
        code: "stale_replacement_on_nonsuperseded",
        severity: "warning",
        task_id: t.id,
        message: `Task ${t.id} (status ${t.status}) carries a stale replacement_task_id "${t.replacement_task_id}" — only superseded tasks should.`,
        entities: { stale_replacement_task_id: t.replacement_task_id, status: t.status },
      });
    }
    const hasCloseFields = t.closed_at != null || (t.close_reason != null && String(t.close_reason).trim() !== "");
    if (ACTIVE.includes(t.status) && hasCloseFields) {
      add({
        code: "stale_close_fields_on_nonterminal",
        severity: "warning",
        task_id: t.id,
        message: `Active task ${t.id} (status ${t.status}) still has close fields (closed_at/close_reason) — leftover from an un-audited reactivation.`,
        entities: { stale_closed_at: t.closed_at ?? null, stale_close_reason: t.close_reason ?? null },
      });
    }
    if (
      (t.status === "cancelled" || t.status === "superseded") &&
      (t.closed_at == null || !(t.close_reason && String(t.close_reason).trim()))
    ) {
      // legacy/pre-migration cancelled imports legitimately lack audit fields
      if (b.schemaVersion >= b.currentSchemaVersion) {
        add({
          code: "terminal_missing_close_audit",
          severity: "warning",
          task_id: t.id,
          message: `Closed task ${t.id} (${t.status}) is missing closed_at/close_reason — reached terminal state outside the audited close_task path.`,
          entities: {
            has_closed_at: t.closed_at != null,
            has_close_reason: !!(t.close_reason && String(t.close_reason).trim()),
          },
        });
      }
    }
  }

  // replacement-chain cycles (follow replacement_task_id edges only)
  {
    const reported = new Set<string>();
    for (const start of b.tasks) {
      if (start.replacement_task_id == null) continue;
      const seen = new Set<string>([start.id]);
      let cur: string | null | undefined = start.replacement_task_id;
      const path = [start.id];
      while (cur) {
        path.push(cur);
        if (seen.has(cur)) {
          const idx = path.indexOf(cur);
          const cycle = path.slice(idx, -1);
          const key = [...cycle].sort().join("|");
          if (!reported.has(key)) {
            reported.add(key);
            add({
              code: "replacement_chain_cycle",
              severity: "error",
              task_id: [...cycle].sort()[0],
              message: `replacement_task_id chain forms a cycle: ${cycle.join(" -> ")}.`,
              entities: { cycle },
            });
          }
          break;
        }
        seen.add(cur);
        cur = byId.get(cur)?.replacement_task_id ?? null;
      }
    }
  }

  // ===== progress / project-meta drift =====
  if (b.actualProgress && b.expectedProgress) {
    const a = b.actualProgress as Record<string, number | undefined>;
    const e = b.expectedProgress as Record<string, number | undefined>;
    const drifted: { field: string; actual: number | null; expected: number | null }[] = [];
    const consider = (key: string, isRate: boolean) => {
      const av = a[key];
      const ev = e[key];
      if (av === undefined) {
        // a missing additive field on a pre-migration project.json is NOT drift
        if (ADDITIVE_KEYS.has(key) && b.schemaVersion < b.currentSchemaVersion) return;
        drifted.push({ field: key, actual: null, expected: ev ?? null });
        return;
      }
      if (ev === undefined) return;
      const diff = isRate ? Math.abs(av - ev) > 1e-9 : av !== ev;
      if (diff) drifted.push({ field: key, actual: av, expected: ev });
    };
    for (const k of COUNT_KEYS) consider(k, false);
    for (const k of RATE_KEYS) consider(k, true);
    if (drifted.length) {
      add({
        code: "progress_drift",
        severity: "error",
        task_id: null,
        message: `project.json.progress drifts from a fresh recompute over tasks.json (${drifted.map((d) => d.field).join(", ")}). Run reconcile.`,
        entities: { drifted_fields: drifted },
        autofixable: true,
      });
    }
  }

  // project.status contradicts the task population
  if (b.projectStatus === "completed" && b.expectedProgress) {
    const ep = b.expectedProgress;
    if ((ep.active_total ?? 0) > (ep.done ?? 0)) {
      add({
        code: "project_status_vs_tasks_inconsistent",
        severity: "warning",
        task_id: null,
        message: `Project status is "completed" but ${(ep.active_total ?? 0) - (ep.done ?? 0)} active task(s) are not done.`,
        entities: { status: b.projectStatus, active_total: ep.active_total, done: ep.done },
      });
    }
  }

  // acceptance-field internal contradiction
  for (const t of b.tasks) {
    const mode = t.acceptance_mode ?? (t.needs_manual_review ? "manual" : "auto");
    if (t.needs_manual_review !== (mode !== "auto")) {
      add({
        code: "acceptance_fields_internal_contradiction",
        severity: "warning",
        task_id: t.id,
        message: `Task ${t.id}: needs_manual_review=${t.needs_manual_review} contradicts acceptance_mode="${mode}" (gate keys off the mode, readers off the boolean).`,
        entities: { needs_manual_review: t.needs_manual_review, acceptance_mode: mode },
      });
    }
    if (t.stage_gate && mode !== "milestone_manual") {
      add({
        code: "acceptance_fields_internal_contradiction",
        severity: "warning",
        task_id: t.id,
        message: `Task ${t.id}: stage_gate=true is inert under acceptance_mode="${mode}" (only meaningful for milestone_manual).`,
        entities: { stage_gate: true, acceptance_mode: mode },
      });
    }
  }

  // schema behind (suppress in cross-project read-only lint)
  if (!b.crossProject && b.tasks.length > 0 && b.schemaVersion < b.currentSchemaVersion) {
    add({
      code: "schema_version_behind",
      severity: "warning",
      task_id: null,
      message: `schema_version is ${b.schemaVersion} < ${b.currentSchemaVersion}; run migrate_tasks_schema (idempotent).`,
      entities: { schema_version: b.schemaVersion, target: b.currentSchemaVersion, tasks: b.tasks.length },
    });
  }

  // unknown verification_profile (skip in cross-project; lenient when no policy file)
  if (!b.crossProject && b.validProfiles.length > 0) {
    const valid = new Set(b.validProfiles);
    for (const t of b.tasks) {
      if (t.verification_profile && !valid.has(t.verification_profile)) {
        add({
          code: "unknown_verification_profile",
          severity: "warning",
          task_id: t.id,
          message: `Task ${t.id} uses verification_profile "${t.verification_profile}" not in the policy file. Valid: ${b.validProfiles.join(", ")}.`,
          entities: { verification_profile: t.verification_profile, valid: b.validProfiles },
        });
      }
    }
  }

  // ===== logs / focus drift (info) =====
  // latest transition log (with a to_status) per task should agree with current status
  {
    const latestTo = new Map<string, string>();
    // logs arrive newest-first; first seen per task is the latest
    for (const l of b.logs) {
      if (l.task_id && l.to_status && !latestTo.has(l.task_id)) latestTo.set(l.task_id, l.to_status);
    }
    for (const t of b.tasks) {
      const to = latestTo.get(t.id);
      if (to && to !== t.status) {
        add({
          code: "terminal_status_vs_last_log_drift",
          severity: "info",
          task_id: t.id,
          message: `Task ${t.id} status "${t.status}" disagrees with its latest transition log to_status "${to}" (tasks.json and logs.json written non-atomically).`,
          entities: { status: t.status, last_log_to_status: to },
        });
      }
    }
    // terminal cancelled/superseded task with no task_closed log — only when the project
    // uses close logging at all (else logs predate the feature / were trimmed)
    const closeLogged = new Set<string>();
    let anyCloseLog = false;
    for (const l of b.logs) {
      if ((l.event_type ?? l.type) === "task_closed") {
        anyCloseLog = true;
        if (l.task_id) closeLogged.add(l.task_id);
      }
    }
    if (anyCloseLog) {
      for (const t of b.tasks) {
        if ((t.status === "cancelled" || t.status === "superseded") && !closeLogged.has(t.id)) {
          add({
            code: "terminal_task_missing_close_log",
            severity: "info",
            task_id: t.id,
            message: `Closed task ${t.id} (${t.status}) has no task_closed audit log — possibly hand-edited.`,
            entities: { status: t.status },
          });
        }
      }
    }
  }

  // timestamp monotonicity (skip unparseable/empty — fixtures use "")
  for (const t of b.tasks) {
    const c = parseTime(t.created_at);
    const u = parseTime(t.updated_at);
    if (c != null && u != null && u < c) {
      add({
        code: "timestamp_monotonicity_violation",
        severity: "info",
        task_id: t.id,
        message: `Task ${t.id}: updated_at < created_at.`,
        entities: { created_at: t.created_at, updated_at: t.updated_at },
      });
    }
    const cl = parseTime(t.closed_at);
    if (cl != null && ((c != null && cl < c) || (u != null && cl > u))) {
      add({
        code: "timestamp_monotonicity_violation",
        severity: "info",
        task_id: t.id,
        message: `Task ${t.id}: closed_at is outside [created_at, updated_at].`,
        entities: { created_at: t.created_at, updated_at: t.updated_at, closed_at: t.closed_at },
      });
    }
  }

  // focus.json related_task_ids referencing missing tasks
  if (b.focus && Array.isArray(b.focus.related_task_ids)) {
    for (const rid of b.focus.related_task_ids) {
      if (!idSet.has(rid)) {
        add({
          code: "focus_related_task_missing",
          severity: "warning",
          task_id: null,
          message: `current_focus.related_task_ids references "${rid}" which no longer exists.`,
          entities: { dangling_related_task_id: rid },
        });
      }
    }
  }

  const summary = {
    error: findings.filter((f) => f.severity === "error").length,
    warning: findings.filter((f) => f.severity === "warning").length,
    info: findings.filter((f) => f.severity === "info").length,
    total: findings.length,
  };
  return { findings, summary };
}
