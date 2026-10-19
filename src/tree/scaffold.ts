import { lstatSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { realDirectoryWithoutSymlinks } from "./path.js";
import { verifyTree } from "./verify.js";

/** Add content only. Existing files, Git state, instructions, and CI belong to the host. */
export function scaffoldTree(path: string, title: string): string {
  const root = resolve(path);
  const made: string[] = [];
  const ensure = (directory: string): void => {
    if (!lstatSync(directory, { throwIfNoEntry: false })) {
      ensure(dirname(directory));
      mkdirSync(directory);
      made.push(directory);
    }
    realDirectoryWithoutSymlinks(directory, "Tree directory");
  };
  let wrote = false;
  try {
    ensure(root);
    const template = `---\nschemaVersion: 1\ntitle: ${JSON.stringify(title)}\n---\n\n# ${title}\n\nDurable context for this project.\n`;
    writeFileSync(join(root, "NODE.md"), template, { flag: "wx", mode: 0o644 });
    wrote = true;
    const report = verifyTree(root);
    if (!report.ok)
      throw new Error(
        `Existing content does not satisfy the tree format: ${report.findings.map((finding) => `${finding.path}: ${finding.message}`).join("; ")}`,
      );
    return realDirectoryWithoutSymlinks(root, "Tree root");
  } catch (error) {
    if (wrote) unlinkSync(join(root, "NODE.md"));
    for (const directory of made.reverse()) rmdirSync(directory);
    throw error;
  }
}
