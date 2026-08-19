import { readFileSync } from "node:fs";

import { type ContextTreePolicy, SCHEMA_VERSION } from "../schemas.js";
import { resolvePackagedResource } from "./internal/packaged-resource.js";

export type { ContextTreePolicy } from "../schemas.js";

export function readContextTreePolicy(): ContextTreePolicy {
  const content = readFileSync(resolvePackagedResource("policy", "context-tree-policy.md"), "utf8");
  return { content, schemaVersion: SCHEMA_VERSION };
}
