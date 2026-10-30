---
name: project-demo
description: Synthetic skill for the lint-kit tools group.
---

# Demo

1. Call `set_project_dir` first, then `get_all_tasks(status="awaiting_manual_acceptance")`.
2. Mark the task: `update_task_status(id, "in_progress")`, or via mcp__project-manager__update_task_status.
3. Close stale work with `close_task(old_id, "superseded", reason="<why>", replacement_task_id="<new_id>")`.
4. Revive with `reopen_task(id, reason, to_status="todo")` and record it with add_log(kind="decision").
5. Fields are not tools: `acceptance_mode`, `stage_gate`, `needs_manual_review`, `verification_profile`,
   `verification_commands`, `review_checklist`, `commit_hash`, `last_discussion_id`, `close_reason`, `closed_at`,
   `from_status`; a verb without a ledger noun is not a tool either: `start_time`, `read_db`.
6. Plain status words outside task calls are not checked: `status = local_execution`.
7. Codex's own plan tool `update_plan` is not a project-manager tool.
8. File names and paths are not tools: `scripts/set_env.sh`, `get_info.py`, `.\tools\add_user.ps1`, `docs/create_notes`.

```json
{
  "id": "T-1",
  "acceptance_mode": "milestone_manual",
  "stage_gate": true,
  "status": "todo"
}
```
