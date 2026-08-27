import { lstatSync } from "node:fs";
import { join } from "node:path";

import type { ContextContentClassCounts, TreeValidationFinding, ValidationCode } from "../../schemas.js";
import { VALIDATION_CODES } from "../../schemas.js";
import { classifyContextContent, collectContextMarkdownContent, emptyContentClassCounts } from "./content-class.js";
import {
  type ContextDocument,
  readContextDocument,
  readNonEmptyStringArrayField,
  readNonEmptyStringField,
} from "./context-document.js";
import { readMarkdownLinkTargets, resolveLocalTreeTarget } from "./context-links.js";

type NodeValidationResult = {
  findings: TreeValidationFinding[];
  scannedByContentClass: ContextContentClassCounts;
};

function addFinding(
  findings: TreeValidationFinding[],
  code: ValidationCode,
  path: string,
  message: string,
  target?: string,
): void {
  findings.push({ code, message, path, ...(target === undefined ? {} : { target }) });
}

function validateRequiredNodeMetadata(
  document: ContextDocument,
  path: string,
  findings: TreeValidationFinding[],
): void {
  if (document.frontmatter === "missing") {
    addFinding(findings, VALIDATION_CODES.frontmatterMissing, path, "missing frontmatter");
    return;
  }

  if (document.frontmatter === "invalid") {
    addFinding(findings, VALIDATION_CODES.frontmatterParse, path, `frontmatter could not be parsed: ${document.error}`);
    return;
  }

  const title = readNonEmptyStringField(document.data, "title");
  if (!title.present) {
    addFinding(findings, VALIDATION_CODES.titleMissing, path, "missing 'title' field in frontmatter");
  } else if (!title.valid) {
    addFinding(findings, VALIDATION_CODES.titleInvalid, path, "'title' must be a non-empty string");
  }

  const description = readNonEmptyStringField(document.data, "description");
  if (description.present && !description.valid) {
    addFinding(
      findings,
      VALIDATION_CODES.descriptionInvalid,
      path,
      "'description' must be a non-empty string when present",
    );
  }
}

function validateRootOnlyFields(document: ContextDocument, path: string, findings: TreeValidationFinding[]): void {
  if (path === "NODE.md" || document.frontmatter !== "valid") return;
  const fields = ["schemaVersion"].filter((field) => field in document.data);
  if (fields.length > 0) {
    addFinding(
      findings,
      VALIDATION_CODES.rootOnlyFields,
      path,
      `root-only frontmatter field${fields.length === 1 ? "" : "s"} must appear only in root NODE.md: ${fields.join(", ")}`,
    );
  }
}

function readSoftLinks(document: ContextDocument, path: string, findings: TreeValidationFinding[]): string[] {
  if (document.frontmatter !== "valid") {
    return [];
  }

  const softLinks = readNonEmptyStringArrayField(document.data, "soft_links");
  if (!softLinks.present) {
    return [];
  }
  if (!softLinks.valid) {
    addFinding(
      findings,
      VALIDATION_CODES.softLinksInvalid,
      path,
      "'soft_links' must be a non-empty string array when present",
    );
    return [];
  }
  return softLinks.value;
}

function validateSoftLinks(options: {
  document: ContextDocument;
  findings: TreeValidationFinding[];
  path: string;
  treeRoot: string;
}): void {
  for (const target of readSoftLinks(options.document, options.path, options.findings)) {
    const resolved = resolveLocalTreeTarget({
      sourcePath: options.path,
      target,
      treeRoot: options.treeRoot,
      softLink: true,
    });

    if (resolved === null || resolved === "missing" || resolved === "escaped-missing") {
      addFinding(options.findings, VALIDATION_CODES.softLinkBroken, options.path, "broken soft_links target", target);
    }
    if (resolved === null) {
      continue;
    }
    if (resolved === "escaped-existing" || resolved === "escaped-missing") {
      addFinding(
        options.findings,
        VALIDATION_CODES.softLinkPathEscape,
        options.path,
        "soft_links target resolves outside the Context Tree root",
        target,
      );
    }
  }
}

function validateMarkdownLinks(
  document: ContextDocument,
  path: string,
  treeRoot: string,
  findings: TreeValidationFinding[],
): void {
  for (const target of readMarkdownLinkTargets(document.body)) {
    const resolved = resolveLocalTreeTarget({ sourcePath: path, target, treeRoot, softLink: false });
    if (resolved === null) {
      continue;
    }
    if (resolved === "escaped-existing" || resolved === "escaped-missing") {
      addFinding(
        findings,
        VALIDATION_CODES.markdownPathEscape,
        path,
        "Markdown link resolves outside the Context Tree root",
        target,
      );
    }
  }
}

export function collectNodeValidationFindings(treeRoot: string): NodeValidationResult {
  const findings: TreeValidationFinding[] = [];
  const scannedByContentClass = emptyContentClassCounts();
  const content = collectContextMarkdownContent(treeRoot);

  for (const directory of content.directories) {
    const nodePath = `${directory}/NODE.md`;
    let hasRegularNode = false;
    try {
      const entry = lstatSync(join(treeRoot, nodePath));
      hasRegularNode = entry.isFile() && !entry.isSymbolicLink();
    } catch {
      // Report the required index below.
    }
    if (!hasRegularNode) {
      addFinding(
        findings,
        VALIDATION_CODES.directoryNodeMissing,
        directory,
        "Context Tree directory is missing NODE.md",
      );
    }
  }

  for (const directory of content.directorySymlinks) {
    addFinding(
      findings,
      directory.escaped ? VALIDATION_CODES.directorySymlinkPathEscape : VALIDATION_CODES.directorySymlinkUnsupported,
      directory.relativePath,
      directory.escaped
        ? "directory symlink resolves outside the Context Tree root"
        : "Context Tree domain directories must not be symlinks",
    );
  }

  for (const file of content.files) {
    scannedByContentClass[file.contentClass] += 1;

    if (file.inspection.kind === "unresolved") {
      addFinding(
        findings,
        VALIDATION_CODES.markdownFileSymlinkBroken,
        file.relativePath,
        "Markdown file symlink target cannot be resolved",
      );
      continue;
    }

    if (file.inspection.kind === "escaped") {
      addFinding(
        findings,
        VALIDATION_CODES.markdownFilePathEscape,
        file.relativePath,
        "Markdown file resolves outside the Context Tree root",
      );
      continue;
    }

    if (file.inspection.kind === "unsupported") {
      addFinding(
        findings,
        VALIDATION_CODES.markdownFileSymlinkUnsupported,
        file.relativePath,
        "Markdown file symlink must resolve to a regular file",
      );
      continue;
    }

    if (file.inspection.kind === "content-class-mismatch") {
      const canonicalContentClass = classifyContextContent(file.inspection.canonicalRelativePath);
      addFinding(
        findings,
        VALIDATION_CODES.markdownFileContentClassMismatch,
        file.relativePath,
        `Markdown file symlink crosses content-class boundary from ${file.contentClass} to ${canonicalContentClass}`,
        file.inspection.canonicalRelativePath,
      );
      continue;
    }

    if (file.contentClass === "repo-infra") {
      continue;
    }

    const document = readContextDocument(file.absolutePath);
    validateRootOnlyFields(document, file.relativePath, findings);
    if (file.relativePath !== "NODE.md" || document.frontmatter === "valid") {
      validateRequiredNodeMetadata(document, file.relativePath, findings);
    }
    validateSoftLinks({
      document,
      findings,
      path: file.relativePath,
      treeRoot,
    });

    validateMarkdownLinks(document, file.relativePath, treeRoot, findings);
  }

  return { findings, scannedByContentClass };
}
