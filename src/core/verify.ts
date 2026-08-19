import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseContextTreeScope } from "../schemas.js";
import type { ContextContentClassCounts } from "./internal/content-class.js";
import { classifyContextContent } from "./internal/content-class.js";
import { collectMemberValidationFindings } from "./internal/validate-members.js";
import { collectNodeValidationFindings } from "./internal/validate-nodes.js";
import { type TreeValidationFinding, VALIDATION_CODES } from "./internal/validation-finding.js";
import { resolveTreeRoot } from "./path.js";

export type VerifyTreeReport = {
  findings: TreeValidationFinding[];
  ok: boolean;
  root: string;
  scannedByContentClass: ContextContentClassCounts;
  schemaVersion: 1;
};

function scopeFindings(root: string): TreeValidationFinding[] {
  const path = join(root, "SCOPE.md");
  if (!existsSync(path)) return [];
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error("SCOPE.md must be a regular root file and must not be a symlink.");
    }
    parseContextTreeScope(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));
    return [];
  } catch (error) {
    return [
      {
        code: VALIDATION_CODES.scopeInvalid,
        message: error instanceof Error ? error.message : String(error),
        path: "SCOPE.md",
      },
    ];
  }
}

function deduplicate(findings: TreeValidationFinding[]): TreeValidationFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}\0${finding.path}\0${finding.target ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function directoryNodeFindings(root: string): TreeValidationFinding[] {
  const findings: TreeValidationFinding[] = [];

  function walk(directory: string, relativeDirectory: string): void {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const contentClass = classifyContextContent(relativePath);
      if (contentClass === "repo-infra") continue;

      const absolutePath = join(directory, entry.name);
      if (
        (contentClass === "normal" || contentClass === "archive-supporting") &&
        !existsSync(join(absolutePath, "NODE.md"))
      ) {
        findings.push({
          code: VALIDATION_CODES.directoryNodeMissing,
          message: "directory exists but is missing NODE.md",
          path: `${relativePath}/NODE.md`,
        });
      }
      walk(absolutePath, relativePath);
    }
  }

  walk(root, "");
  return findings;
}

export function verifyTree(treePath: string): VerifyTreeReport {
  const root = resolveTreeRoot(treePath);
  const nodeResult = collectNodeValidationFindings(root);
  const memberResult = collectMemberValidationFindings(root);
  const rootNode = join(root, "NODE.md");
  const rootFinding: TreeValidationFinding[] = existsSync(rootNode)
    ? []
    : [{ code: VALIDATION_CODES.rootMissing, message: "root NODE.md is missing", path: "NODE.md" }];
  const findings = deduplicate([
    ...rootFinding,
    ...scopeFindings(root),
    ...directoryNodeFindings(root),
    ...nodeResult.findings,
    ...memberResult.findings,
  ]);

  return {
    findings,
    ok: findings.length === 0,
    root,
    scannedByContentClass: nodeResult.scannedByContentClass,
    schemaVersion: 1,
  };
}
