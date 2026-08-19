import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "./read.js";

const POLICY_CANDIDATES = [
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "policy"),
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "policy"),
];

export type ContextTreePolicy = {
  content: string;
  digest: string;
  schemaVersion: 1;
};

export function readContextTreePolicy(): ContextTreePolicy {
  const name = "context-tree-policy.md";
  const root = POLICY_CANDIDATES.find((candidate) => existsSync(join(candidate, name)));
  if (!root) throw new Error(`Packaged Context Tree policy is missing: ${name}`);
  const content = readFileSync(join(root, name), "utf8");
  return { content, digest: sha256(content), schemaVersion: 1 };
}
