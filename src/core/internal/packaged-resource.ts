import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "../../internal/value.js";

const PACKAGE_NAME = "@first-tree-ai/context-tree";

function isPackageRoot(path: string): boolean {
  const manifestPath = join(path, "package.json");
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    return typeof manifest === "object" && manifest !== null && "name" in manifest && manifest.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

export function resolvePackagedResource(...segments: string[]): string {
  let candidate = dirname(fileURLToPath(import.meta.url));
  const filesystemRoot = parse(candidate).root;

  while (true) {
    if (isPackageRoot(candidate)) {
      const resource = resolve(candidate, ...segments);
      if (existsSync(resource)) return resource;
      throw new Error(`Packaged resource is missing: ${segments.join("/")}`);
    }
    if (candidate === filesystemRoot) break;
    candidate = dirname(candidate);
  }

  throw new Error(`Package root is missing while resolving: ${segments.join("/")}`);
}

export function readPackageManifest(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(resolvePackagedResource("package.json"), "utf8"));
  if (!isRecord(parsed)) {
    throw new Error("Package metadata is invalid.");
  }
  return parsed;
}
