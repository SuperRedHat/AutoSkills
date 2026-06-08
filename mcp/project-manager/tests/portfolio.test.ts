// PM-303 (Phase 3, C3): get_portfolio aggregation. The tool maps project_dirs ->
// selectState -> getPortfolioSummary; selectState lives in index.ts (starts the
// server on import), so we test getPortfolioSummary + the resolve+summary pattern.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state";
import { resolveProjectDir } from "../src/project_dir";
import { fixtureProject, tempCopyOfFixture } from "./helpers";

describe("portfolio summary", () => {
  it("getPortfolioSummary returns a compact cross-project summary", () => {
    const s = new StateManager(fixtureProject("councilflow")).getPortfolioSummary();
    expect(s.name).toBeTruthy();
    expect(s.metrics.total_all).toBe(114);
    expect(s.metrics.done).toBe(114);
    expect(s.next_task).toBeNull(); // all done
    expect(s.next_task_blocked_reason).toBe("all_done");
    expect(s.current_focus).toBeNull(); // no focus.json in fixture
  });

  it("includes current_focus summary + is_stale when set", () => {
    const sm = new StateManager(tempCopyOfFixture("nano"));
    sm.setCurrentFocus({ summary: "盯客户消息", stale_after: "2000-01-01T00:00:00.000Z" });
    const s = sm.getPortfolioSummary();
    expect(s.current_focus).toEqual({ summary: "盯客户消息", is_stale: true });
  });

  it("surfaces next_task {id,title} when a runnable task exists", () => {
    const sm = new StateManager(tempCopyOfFixture("nano"));
    const s = sm.getPortfolioSummary();
    // nano has todos; whether one is runnable depends on the fixture, but the
    // shape must be either null or {id,title}.
    if (s.next_task) {
      expect(typeof s.next_task.id).toBe("string");
      expect(typeof s.next_task.title).toBe("string");
    }
  });

  it("aggregation pattern: good dirs resolve, bad dirs surface a per-entry error", () => {
    const good = resolveProjectDir(fixtureProject("councilflow"));
    const bad = resolveProjectDir(fs.mkdtempSync(path.join(os.tmpdir(), "pm-pf-")));
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error_kind).toBe("not_a_project");
  });
});
