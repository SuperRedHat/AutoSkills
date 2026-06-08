// PM-004 (Phase 0.3): current_focus storage (focus.json) + get/set round-trip,
// staleness, structured fields, and surfacing through get_project_context.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-focus-"));
}

describe("current_focus", () => {
  it("get returns null when no focus.json exists", () => {
    expect(new StateManager(emptyProject()).getCurrentFocus()).toBeNull();
  });

  it("set then get round-trips with defaults + server-stamped updated_at", () => {
    const sm = new StateManager(emptyProject());
    const saved = sm.setCurrentFocus({ summary: "等 James 第三轮回传" });
    expect(saved.schema_version).toBe(1);
    expect(saved.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const got = sm.getCurrentFocus()!;
    expect(got.summary).toBe("等 James 第三轮回传");
    expect(got.waiting_on).toEqual([]);
    expect(got.related_entities).toEqual({});
    expect(got.last_event).toBeNull();
    expect(got.is_stale).toBe(false); // no stale_after => never stale
  });

  it("is_stale reflects stale_after vs now", () => {
    const sm = new StateManager(emptyProject());
    sm.setCurrentFocus({ summary: "x", stale_after: "2000-01-01T00:00:00.000Z" });
    expect(sm.getCurrentFocus()!.is_stale).toBe(true);
    sm.setCurrentFocus({ summary: "x", stale_after: "2999-01-01T00:00:00.000Z" });
    expect(sm.getCurrentFocus()!.is_stale).toBe(false);
  });

  it("structured fields persist (matches the proven james-monitor-state shape)", () => {
    const sm = new StateManager(emptyProject());
    sm.setCurrentFocus({
      summary: "monitor-and-pounce",
      waiting_on: ["client:James"],
      related_task_ids: ["OPS-1"],
      related_entities: { contract: "C-42", proposal: "P-7" },
      next_trigger: "他回传代码",
      last_event: "delta 已发 7:57",
      source: "manual",
    });
    const g = sm.getCurrentFocus()!;
    expect(g.related_entities).toEqual({ contract: "C-42", proposal: "P-7" });
    expect(g.waiting_on).toEqual(["client:James"]);
    expect(g.related_task_ids).toEqual(["OPS-1"]);
    expect(g.next_trigger).toBe("他回传代码");
    expect(g.last_event).toBe("delta 已发 7:57");
    expect(g.source).toBe("manual");
  });

  it("getProjectContext surfaces current_focus and records a focus_update log", () => {
    const sm = new StateManager(emptyProject());
    sm.setCurrentFocus({ summary: "盯客户消息" });
    const ctx = sm.getProjectContext();
    expect(ctx.current_focus?.summary).toBe("盯客户消息");
    expect(ctx.recent_logs.some((l) => l.type === "focus_update")).toBe(true);
  });
});
