---
name: project-demo
description: Synthetic skill with unregistered tools and bad enum values.
---

# Demo

1. Call `get_task_graph` before planning.
2. Remove a task with mcp__project-manager__delete_task.
3. Finish with `update_task_status(id, "finished")`.
4. List work with `get_all_tasks(status="blocked")`.
5. Use `acceptance_mode=strict` for risky work.
6. Flow: todo -> doing -> done

```json
{ "id": "T-2", "acceptance_mode": "auto|review", "status": "open" }
```
7. Then `list_tasks`, `complete_task(id)` and `start_task`.
