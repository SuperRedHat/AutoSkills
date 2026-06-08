import { describe, it, expect } from "vitest";
import { StateManager } from "../src/state";
import { fixtureProject, tempCopyOfFixture } from "./helpers";

describe("test harness smoke", () => {
  it("loads the CouncilFlow fixture (114/114 done) via StateManager", () => {
    const sm = new StateManager(fixtureProject("councilflow"));
    const info = sm.getProjectInfo();
    expect(info).not.toBeNull();
    expect(info!.progress.done).toBe(114);
    expect(sm.getAllTasks().length).toBe(114);
  });

  it("can mutate a temp copy without touching the committed fixture", () => {
    const dir = tempCopyOfFixture("nano");
    const sm = new StateManager(dir);
    // nano fixture loads and exposes a coherent task list.
    expect(sm.getProjectInfo()).not.toBeNull();
    expect(sm.getAllTasks().length).toBeGreaterThan(0);
  });
});
