import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const packageRoot = resolve(import.meta.dirname, "../..");
export function resolvePackagedResource(...segments: string[]): string {
  const resource = resolve(packageRoot, ...segments);
  if (!existsSync(resource)) throw new Error(`Packaged resource is missing: ${segments.join("/")}`);
  return resource;
}
export function readPackageVersion(): string {
  return z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(resolvePackagedResource("package.json"), "utf8"))).version;
}
