// PM-005 (Phase 0.4): add_log enrichment (kind/event_type/tags/entities/source),
// G4 type->kind inference, and the filter-before-slice journal fix.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type LogEntry } from "../src/state";
import { fixtureProject } from "./helpers";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-logs-"));
}
function log(over: Partial<LogEntry> & { timestamp: string; type: string; message: string }): LogEntry {
  return { task_id: null, from_status: null, to_status: null, ...over } as LogEntry;
}

describe("getLogs filter-before-slice (journal correctness)", () => {
  it("kind+limit returns the most-recent matches even when newer unrelated entries exist", () => {
    const sm = new StateManager(emptyProject());
    // 3 ops_events (older) ...
    for (let i = 0; i < 3; i++) {
      sm.addLog(log({ timestamp: `2026-01-0${i + 1}T00:00:00.000Z`, type: "milestone_gate", message: `gate ${i}` }));
    }
    // ... then 10 notes (newer) that would fill a naive top-10 window
    for (let i = 0; i < 10; i++) {
      sm.addLog(log({ timestamp: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, type: "note", message: `note ${i}` }));
    }
    // Old slice-then-filter would take 10 newest (all notes) then filter -> 0.
    const ops = sm.getLogs({ kind: "ops_event", limit: 2 });
    expect(ops.length).toBe(2);
    expect(ops.map((l) => l.message)).toEqual(["gate 2", "gate 1"]); // 2 most-recent ops, desc
  });
});

describe("kind inference (G4) for entries without an explicit kind", () => {
  it("infers ops_event from milestone_gate and task_transition from task_status_change", () => {
    const sm = new StateManager(emptyProject());
    sm.addLog(log({ timestamp: "2026-01-01T00:00:00.000Z", type: "milestone_gate", message: "g" }));
    sm.addLog(log({ timestamp: "2026-01-02T00:00:00.000Z", type: "task_status_change", message: "t" }));
    sm.addLog(log({ timestamp: "2026-01-03T00:00:00.000Z", type: "weird_unknown_type", message: "n" }));
    expect(sm.getLogs({ kind: "ops_event" }).map((l) => l.message)).toEqual(["g"]);
    expect(sm.getLogs({ kind: "task_transition" }).map((l) => l.message)).toEqual(["t"]);
    expect(sm.getLogs({ kind: "note" }).map((l) => l.message)).toEqual(["n"]); // unknown -> note
  });

  it("real councilflow fixture logs infer task_transition (legacy task_status_change)", () => {
    const sm = new StateManager(fixtureProject("councilflow"));
    const tt = sm.getLogs({ kind: "task_transition", limit: 5 });
    expect(tt.length).toBeGreaterThan(0);
  });
});

describe("add_log enrichment round-trips", () => {
  it("persists kind/event_type/tags/entities/source and filters by event_type", () => {
    const sm = new StateManager(emptyProject());
    sm.addLog(
      log({
        timestamp: "2026-03-01T00:00:00.000Z",
        type: "ops_event",
        kind: "ops_event",
        event_type: "job_posted",
        tags: ["upwork", "python"],
        entities: { proposal: "P-9", client: "Acme" },
        source: "monitor",
        message: "new job posted",
      }),
    );
    const got = sm.getLogs({ event_type: "job_posted" });
    expect(got.length).toBe(1);
    expect(got[0].entities).toEqual({ proposal: "P-9", client: "Acme" });
    expect(got[0].tags).toEqual(["upwork", "python"]);
    expect(got[0].source).toBe("monitor");
  });
});

describe("since filter + backward compatibility", () => {
  it("since returns only entries at/after the cutoff", () => {
    const sm = new StateManager(emptyProject());
    for (let i = 1; i <= 10; i++) {
      sm.addLog(log({ timestamp: `2026-02-${String(i).padStart(2, "0")}T00:00:00.000Z`, type: "note", message: `n${i}` }));
    }
    const cutoff = "2026-02-05T00:00:00.000Z";
    const recent = sm.getLogs({ since: cutoff });
    expect(recent.length).toBe(6); // days 5..10 inclusive
    expect(recent.every((l) => new Date(l.timestamp).getTime() >= new Date(cutoff).getTime())).toBe(true);
  });

  it("numeric form still works (getLogs(n) returns n most-recent, all kinds)", () => {
    const sm = new StateManager(fixtureProject("councilflow"));
    expect(sm.getLogs(5).length).toBe(5);
  });
});
