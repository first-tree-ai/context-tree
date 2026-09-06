import { lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/** Best-effort convenience link; existing project instruction entries are never changed. */
export function linkProjectInstructions(projectPath: string): void {
  try {
    if (!lstatSync(join(projectPath, "AGENTS.md"), { throwIfNoEntry: false })?.isFile()) return;
    const claudePath = join(projectPath, "CLAUDE.md");
    if (lstatSync(claudePath, { throwIfNoEntry: false }) !== undefined) return;
    symlinkSync("AGENTS.md", claudePath, "file");
  } catch {
    // Instruction discovery is optional; filesystem failures must not fail the connection.
  }
}
