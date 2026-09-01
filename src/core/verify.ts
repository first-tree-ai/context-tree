import { existsSync } from "node:fs";
import { join } from "node:path";

import { SCHEMA_VERSION, type TreeValidationFinding, VALIDATION_CODES, type VerifyTreeReport } from "../schemas.js";
import { readRootNode } from "./internal/root-node.js";
import { collectNodeValidationFindings } from "./internal/validate-nodes.js";
import { resolveTreeRoot } from "./path.js";

function rootNodeFindings(root: string): TreeValidationFinding[] {
  const path = join(root, "NODE.md");
  if (!existsSync(path)) {
    return [{ code: VALIDATION_CODES.rootMissing, message: "root NODE.md is missing", path: "NODE.md" }];
  }
  try {
    readRootNode(root);
    return [];
  } catch (error) {
    return [
      {
        code: VALIDATION_CODES.rootNodeInvalid,
        message: error instanceof Error ? error.message : String(error),
        path: "NODE.md",
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
  const findings = deduplicate([...rootNodeFindings(root), ...nodeResult.findings]);

  return {
    findings,
    ok: findings.length === 0,
    root,
    scannedByContentClass: nodeResult.scannedByContentClass,
    schemaVersion: SCHEMA_VERSION,
  };
}
