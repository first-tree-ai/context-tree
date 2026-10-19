import type { ContextTreeReadResult, VerifyTreeReport } from "../contracts/index.js";

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
