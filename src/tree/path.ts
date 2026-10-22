import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

export function isPathInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function resolveTreeRoot(path: string): string {
  return realDirectoryWithoutSymlinks(path, "Context Tree root");
}

/** Resolve a directory while rejecting symlinks in user-controlled path components. */
export function realDirectoryWithoutSymlinks(path: string, label: string): string {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const entry = lstatSync(current);
    // macOS exposes stable top-level aliases such as /var -> /private/var.
    // Canonicalize that platform boundary, but fail closed below it.
    if (entry.isSymbolicLink()) {
      if (index === 0) current = realpathSync(current);
      else throw new Error(`${label} must contain no symlink component.`);
    }
  }
  const entry = lstatSync(current);
  if (!entry.isDirectory()) throw new Error(`${label} must be a directory.`);
  return realpathSync(current);
}

export function toPosixPath(path: string): string {
  return path.replace(/\\/gu, "/");
}
