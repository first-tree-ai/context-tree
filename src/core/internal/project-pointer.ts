import { lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BEGIN = "<!-- context-tree:begin -->";
const END = "<!-- context-tree:end -->";

/** Whether the pointer block was created, rewritten, or deliberately left alone. */
export type ProjectPointerOutcome = "written" | "updated" | "skipped";

function pointerBlock(treePath: string): string {
  return [
    BEGIN,
    "## Context Tree",
    "",
    `This project is connected to a Context Tree at \`${treePath}\`.`,
    "",
    "Read the decisions and constraints that bear on a task before planning or",
    "changing code, and record durable decisions there. Use the `context-tree-read`",
    "and `context-tree-write` skills rather than editing the tree by hand.",
    END,
  ].join("\n");
}

/** A real regular file, a real absent path, or a refusal. */
function regularFileContent(path: string): string | undefined {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined) return undefined;
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`Refusing to write the Context Tree pointer through a symlink or non-file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

/**
 * Record the connected tree in the project's own `AGENTS.md`, so any agent that reads
 * instruction files knows the tree exists without a host-specific session hook.
 *
 * Idempotent: a delimited block is rewritten in place, never appended twice, so
 * switching the connected tree updates the existing pointer. All other content is
 * preserved, and an existing regular `CLAUDE.md` is left alone.
 */
export function writeProjectPointer(projectPath: string, treePath: string): ProjectPointerOutcome {
  const agentsPath = join(projectPath, "AGENTS.md");
  const block = pointerBlock(treePath);
  const existing = regularFileContent(agentsPath);

  if (existing === undefined) {
    writeFileSync(agentsPath, `# AGENTS.md\n\n${block}\n`, { encoding: "utf8", mode: 0o644 });
    linkClaudeMarkdown(projectPath);
    return "written";
  }

  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end > start) {
    const replaced = `${existing.slice(0, start)}${block}${existing.slice(end + END.length)}`;
    if (replaced === existing) return "skipped";
    writeFileSync(agentsPath, replaced, { encoding: "utf8" });
    return "updated";
  }

  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(agentsPath, `${existing}${separator}${block}\n`, { encoding: "utf8" });
  linkClaudeMarkdown(projectPath);
  return "written";
}

/** Point CLAUDE.md at AGENTS.md only when the project has no CLAUDE.md of its own. */
function linkClaudeMarkdown(projectPath: string): void {
  const claudePath = join(projectPath, "CLAUDE.md");
  if (lstatSync(claudePath, { throwIfNoEntry: false }) !== undefined) return;
  try {
    symlinkSync("AGENTS.md", claudePath, "file");
  } catch {
    // A pointer in AGENTS.md is sufficient; a failed convenience symlink must not fail a connect.
  }
}
