// PM-204 (Phase 2, B4 / L9): verification_profile names read from the external
// policy file, not a hardcoded enum.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadProfileNames, findUnknownProfiles } from "../src/profiles";

function writeProfiles(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-prof-"));
  const p = path.join(dir, "verification-profiles.json");
  fs.writeFileSync(
    p,
    JSON.stringify({ version: "t", profiles: Object.fromEntries(names.map((n) => [n, {}])) }),
    "utf-8",
  );
  return p;
}

describe("verification_profile externalization", () => {
  it("loadProfileNames reads keys from the external file", () => {
    const p = writeProfiles(["backend", "docs", "custom_x"]);
    expect(loadProfileNames(p).sort()).toEqual(["backend", "custom_x", "docs"]);
  });

  it("findUnknownProfiles flags names not in the file and lists the valid ones", () => {
    const p = writeProfiles(["backend", "docs"]);
    const r = findUnknownProfiles(["backend", "nope", "docs"], p);
    expect(r.unknown).toEqual(["nope"]);
    expect(r.valid.sort()).toEqual(["backend", "docs"]);
  });

  it("a newly-added profile in the file is accepted with no code change", () => {
    const p = writeProfiles(["backend", "brand_new_profile"]);
    expect(findUnknownProfiles(["brand_new_profile"], p).unknown).toEqual([]);
  });

  it("missing policy file => lenient (flags nothing)", () => {
    const missing = path.join(os.tmpdir(), "pm-prof-missing-dir", "nope.json");
    expect(findUnknownProfiles(["anything"], missing).unknown).toEqual([]);
  });

  it("ignores undefined/null/empty profiles", () => {
    const p = writeProfiles(["backend"]);
    expect(findUnknownProfiles([undefined, null, "", "backend"], p).unknown).toEqual([]);
  });
});
