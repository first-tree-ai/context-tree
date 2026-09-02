import type {
  ConnectProjectResult,
  ContextTreeConnectionResult,
  ContextTreePublishResult,
  ContextTreeReadResult,
  ContextTreeState,
  CreateProjectResult,
  ManagedTreeListingResult,
  VerifyTreeReport,
} from "../schemas.js";

const POINTER_NOTE: Record<CreateProjectResult["pointer"], string> = {
  skipped: "left unchanged",
  updated: "updated",
  written: "written",
};

function treeLines(tree: ContextTreeState, indent = "  "): string[] {
  const lines = [`${indent}Path:       ${tree.path}`];
  if (tree.kind === "github") lines.push(`${indent}Repository: ${tree.repository}`);
  return lines;
}

export function formatCreate(result: CreateProjectResult): string {
  const verb = result.created ? "Created" : "Reused";
  return [
    `${verb} managed Context Tree "${result.title}".`,
    `  Path:     ${result.treePath}`,
    `  Branch:   ${result.branch}`,
    `  Commit:   ${result.commitSha}`,
    `  AGENTS.md: ${POINTER_NOTE[result.pointer]}`,
  ].join("\n");
}

export function formatConnect(result: ConnectProjectResult): string {
  return [
    `Connected ${result.tree.kind} Context Tree.`,
    ...treeLines(result.tree),
    `  AGENTS.md:  ${POINTER_NOTE[result.pointer]}`,
  ].join("\n");
}

export function formatResolve(result: ContextTreeConnectionResult): string {
  return [`Connected ${result.tree.kind} Context Tree.`, ...treeLines(result.tree)].join("\n");
}

export function formatList(result: ManagedTreeListingResult): string {
  if (result.trees.length === 0) return "No managed Context Trees.";
  const count = result.trees.length;
  const lines = [`${count} managed Context Tree${count === 1 ? "" : "s"}:`];
  for (const entry of result.trees) lines.push(`  ${entry.name}  ${entry.tree.kind}  ${entry.tree.path}`);
  return lines.join("\n");
}

export function formatPublish(result: ContextTreePublishResult): string {
  return [
    `Published Context Tree to ${result.repository}.`,
    `  URL:    ${result.url}`,
    `  Branch: ${result.branch}`,
    `  Commit: ${result.sha}`,
  ].join("\n");
}

export function formatRead(result: ContextTreeReadResult): string {
  const title = result.node.frontmatter.title;
  const lines: string[] = [];
  if (typeof title === "string" && title.trim().length > 0) lines.push(title.trim());
  lines.push(`Path: ${result.node.path} (${result.node.kind}, ${result.node.contentClass})`);
  lines.push(`Root: ${result.root}`);
  if (result.node.body.trim().length > 0) {
    lines.push("", result.node.body.trimEnd());
  }
  if (result.children.length > 0) {
    lines.push("", "Children:");
    for (const child of result.children) {
      const description = child.description ? ` — ${child.description}` : "";
      lines.push(`  ${child.title}${description}  [${child.path}]`);
    }
  }
  return lines.join("\n");
}

export function formatVerify(report: VerifyTreeReport): string {
  const counts = report.scannedByContentClass;
  const lines = [
    report.ok ? "Context Tree OK." : "Context Tree INVALID.",
    `  Root:    ${report.root}`,
    `  Scanned: normal=${counts.normal} member=${counts.member} repo-infra=${counts["repo-infra"]}`,
  ];
  if (report.findings.length > 0) {
    lines.push("  Findings:");
    for (const finding of report.findings) lines.push(`    ${finding.code} ${finding.path}: ${finding.message}`);
  }
  return lines.join("\n");
}
