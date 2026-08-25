import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

import {
  parseContextTreeScope,
  SCHEMA_VERSION,
  type TreeValidationFinding,
  VALIDATION_CODES,
  type VerifyTreeReport,
} from "../schemas.js";
import { readUtf8File } from "./internal/filesystem.js";
import { collectNodeValidationFindings } from "./internal/validate-nodes.js";
import { resolveTreeRoot } from "./path.js";

function scopeFindings(root: string): TreeValidationFinding[] {
  const path = join(root, "SCOPE.md");
  if (!existsSync(path)) return [];
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error("SCOPE.md must be a regular root file and must not be a symlink.");
    }
    parseContextTreeScope(readUtf8File(path));
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

export function verifyTree(treePath: string): VerifyTreeReport {
  const root = resolveTreeRoot(treePath);
  const nodeResult = collectNodeValidationFindings(root);
  const rootNode = join(root, "NODE.md");
  const rootFinding: TreeValidationFinding[] = existsSync(rootNode)
    ? []
    : [{ code: VALIDATION_CODES.rootMissing, message: "root NODE.md is missing", path: "NODE.md" }];
  const findings = deduplicate([...rootFinding, ...scopeFindings(root), ...nodeResult.findings]);

  return {
    findings,
    ok: findings.length === 0,
    root,
    scannedByContentClass: nodeResult.scannedByContentClass,
    schemaVersion: SCHEMA_VERSION,
  };
}
