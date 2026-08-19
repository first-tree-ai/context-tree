import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type VerifyTreeReport, verifyTree } from "./verify.js";

const TEMPLATE_CANDIDATES = [
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates"),
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates"),
];

function template(name: string, values: Record<string, string>): string {
  const root = TEMPLATE_CANDIDATES.find((candidate) => existsSync(join(candidate, name)));
  if (!root) throw new Error(`Packaged Context Tree template is missing: ${name}`);
  let result = readFileSync(join(root, name), "utf8");
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

export type ScaffoldTreeOptions = {
  owner: string;
  path: string;
  title: string;
};

export type ScaffoldTreeResult = {
  files: string[];
  root: string;
  schemaVersion: 1;
  verification: VerifyTreeReport;
};

export function scaffoldTree(options: ScaffoldTreeOptions): ScaffoldTreeResult {
  const root = resolve(options.path);
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`Refusing to scaffold into a non-empty directory: ${root}`);
  }
  mkdirSync(root, { recursive: true });
  const owner = options.owner.trim();
  const title = options.title.trim();
  if (!/^[a-z\d][a-z\d._-]{0,127}$/iu.test(owner)) {
    throw new Error("Owner must be a portable identifier containing only letters, digits, dot, underscore, or hyphen.");
  }
  const unsafeTitle = [...title].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
  if (!title || title.length > 200 || unsafeTitle) {
    throw new Error("Tree title must be a non-empty single line of at most 200 characters.");
  }
  const values = { owner, ownerJson: JSON.stringify(owner), title, titleJson: JSON.stringify(title) };

  const files = [
    ["NODE.md", "root-node.md"],
    ["SCOPE.md", "scope.md"],
    ["members/NODE.md", "members-index.md"],
    [`members/${values.owner}/NODE.md`, "member-node.md"],
    [".github/workflows/validate-context-tree.yml", "validate-context-tree.yml"],
  ] as const;

  for (const [relativePath, source] of files) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, template(source, values), { encoding: "utf8", flag: "wx", mode: 0o644 });
  }

  return {
    files: files.map(([path]) => path),
    root,
    schemaVersion: 1,
    verification: verifyTree(root),
  };
}
