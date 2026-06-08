import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// verification_profile NAMES live in the shared external policy file, not in
// hardcoded enums — adding a profile means editing that file only, no code change.
export function profilesFilePath(home: string = os.homedir()): string {
  return path.join(home, ".workflow-core", "policies", "verification-profiles.json");
}

/** Valid profile names = keys of `profiles` in the external file. [] if missing/unreadable. */
export function loadProfileNames(filePath: string = profilesFilePath()): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && parsed.profiles ? Object.keys(parsed.profiles) : [];
  } catch {
    return [];
  }
}

/**
 * Return the profile names that are NOT defined in the external file.
 * If the file is missing/unreadable (valid = []), we stay lenient and flag
 * nothing — never block task creation on a missing policy file.
 */
export function findUnknownProfiles(
  profiles: (string | undefined | null)[],
  filePath?: string
): { unknown: string[]; valid: string[] } {
  const valid = loadProfileNames(filePath);
  if (valid.length === 0) return { unknown: [], valid };
  const unknown = [
    ...new Set(
      profiles.filter((p): p is string => !!p).filter((p) => !valid.includes(p))
    ),
  ];
  return { unknown, valid };
}
