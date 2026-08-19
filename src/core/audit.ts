import type { ContextContentClass } from "../schemas.js";
import { type ContextTreeReadEntry, readTree } from "./read.js";
import { type VerifyTreeReport, verifyTree } from "./verify.js";

export type AuditTreeOptions = {
  classes?: ContextContentClass[] | "all";
  depth?: number;
  path?: string;
  pattern?: string;
};

export type AuditTreeReport = {
  entries: ContextTreeReadEntry[];
  root: string;
  schemaVersion: 1;
  scope: string;
  treeDigest: string;
  verification: VerifyTreeReport;
};

export function auditTree(treePath: string, options: AuditTreeOptions = {}): AuditTreeReport {
  const verification = verifyTree(treePath);
  const readOptions: Parameters<typeof readTree>[1] = { classes: options.classes ?? "all" };
  if (options.depth !== undefined) readOptions.depth = options.depth;
  if (options.path !== undefined) readOptions.path = options.path;
  if (options.pattern !== undefined) readOptions.pattern = options.pattern;
  const read = readTree(treePath, readOptions);
  return {
    entries: read.entries,
    root: read.root,
    schemaVersion: 1,
    scope: read.target,
    treeDigest: read.treeDigest,
    verification,
  };
}
