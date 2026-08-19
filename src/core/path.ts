import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function isPathInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function resolveTreeRoot(path: string): string {
  const absolute = resolve(path);
  const entry = lstatSync(absolute);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Context Tree root must be a real directory: ${path}`);
  }
  return realpathSync(absolute);
}

export function toPosixPath(path: string): string {
  return path.replace(/\\/gu, "/");
}
