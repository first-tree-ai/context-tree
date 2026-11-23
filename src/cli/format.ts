import type { ContextTreeReadResult, VerifyTreeReport } from "../contracts/index.js";

export function formatRead(result: ContextTreeReadResult): string {
  const title = result.node.frontmatter.title;
  const lines: string[] = [];
  if (typeof title === "string" && title.trim().length > 0) lines.push(title.trim());
  lines.push(`Path: ${result.node.path} (${result.node.kind}, ${result.node.lineCount} lines)`);
  lines.push(`Root: ${result.root}`);
  const description = result.node.frontmatter.description;
  if (typeof description === "string" && description.trim().length > 0) lines.push(description.trim());
  const softLinks = result.node.frontmatter.soft_links;
  if (Array.isArray(softLinks) && softLinks.length > 0) {
    lines.push(`Soft links: ${softLinks.filter((link) => typeof link === "string").join(", ")}`);
  }
  if (result.node.body !== undefined) {
    if (result.node.body.trim().length > 0) lines.push("", result.node.body.trimEnd());
  } else if (result.node.outline.length > 0) {
    lines.push("", "Outline (line, heading):");
    for (const heading of result.node.outline) {
      lines.push(`  ${String(heading.line).padStart(5)}  ${"#".repeat(heading.level)} ${heading.title}`);
    }
    lines.push("", "Add --full for the whole document or --section <heading> for one section.");
  } else {
    lines.push("", "Add --full for the whole document.");
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
    `  Scanned: normal=${counts.normal} repo-infra=${counts["repo-infra"]}`,
  ];
  if (report.findings.length > 0) {
    lines.push("  Findings:");
    for (const finding of report.findings) lines.push(`    ${finding.code} ${finding.path}: ${finding.message}`);
  }
  return lines.join("\n");
}
