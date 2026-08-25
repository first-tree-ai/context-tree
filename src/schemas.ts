import { z } from "zod";

import { parseMarkdownFrontmatter } from "./internal/frontmatter.js";

export const SCHEMA_VERSION = 1 as const;
export const CONTEXT_TREE_ROOT_NODE_MAX_BYTES = 16 * 1024;

export const VALIDATION_CODES = {
  rootMissing: "TREE_ROOT_MISSING",
  rootNodeInvalid: "TREE_ROOT_NODE_INVALID",
  rootOnlyFields: "TREE_ROOT_ONLY_FIELDS",
  directoryNodeMissing: "TREE_DIRECTORY_NODE_MISSING",
  frontmatterMissing: "TREE_FRONTMATTER_MISSING",
  frontmatterParse: "TREE_FRONTMATTER_PARSE",
  titleMissing: "TREE_TITLE_MISSING",
  titleInvalid: "TREE_TITLE_INVALID",
  descriptionInvalid: "TREE_DESCRIPTION_INVALID",
  softLinksInvalid: "TREE_SOFT_LINKS_INVALID",
  softLinkBroken: "TREE_SOFT_LINK_BROKEN",
  softLinkPathEscape: "TREE_SOFT_LINK_PATH_ESCAPE",
  softLinkArchiveDependency: "TREE_SOFT_LINK_ARCHIVE_DEPENDENCY",
  markdownPathEscape: "TREE_MARKDOWN_LINK_PATH_ESCAPE",
  markdownArchiveDependency: "TREE_MARKDOWN_LINK_ARCHIVE_DEPENDENCY",
  markdownFileSymlinkBroken: "TREE_MARKDOWN_FILE_SYMLINK_BROKEN",
  markdownFileSymlinkUnsupported: "TREE_MARKDOWN_FILE_SYMLINK_UNSUPPORTED",
  markdownFilePathEscape: "TREE_MARKDOWN_FILE_PATH_ESCAPE",
  markdownFileContentClassMismatch: "TREE_MARKDOWN_FILE_CONTENT_CLASS_MISMATCH",
  directorySymlinkUnsupported: "TREE_DIRECTORY_SYMLINK_UNSUPPORTED",
  directorySymlinkPathEscape: "TREE_DIRECTORY_SYMLINK_PATH_ESCAPE",
} as const;

export const CLI_ERROR_CODES = {
  failed: "CONTEXT_TREE_FAILED",
} as const;

function hasUnsafeCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029);
  });
}

export const credentialFreeRepositoryUrlSchema = z.string().superRefine((value, context) => {
  if (value.trim() !== value || hasUnsafeCharacter(value) || value.includes("\\")) {
    context.addIssue({ code: "custom", message: "Repository URLs must be canonical single-line values." });
    return;
  }
  if (value.includes("?") || value.includes("#")) {
    context.addIssue({ code: "custom", message: "Repository URLs must not contain a query or fragment." });
    return;
  }
  const scp = /^(?:[a-z\d._-]+@)?[a-z\d.-]+:[^\s/][^\s]*$/iu;
  if (scp.test(value)) return;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
      !parsed.hostname ||
      parsed.pathname.split("/").every((part) => part.length === 0) ||
      parsed.password ||
      ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.username)
    ) {
      throw new Error("invalid transport");
    }
  } catch {
    context.addIssue({
      code: "custom",
      message: "Repository URLs must use credential-free HTTP(S), ssh://, or scp-like SSH syntax.",
    });
  }
});

export const contextTreeRootNodeFrontmatterSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    soft_links: z.array(z.string().trim().min(1)).min(1).optional(),
    relatedRepositories: z.array(credentialFreeRepositoryUrlSchema).max(64).optional(),
  })
  .loose();

export const contextTreeRootNodeSchema = z.object({
  frontmatter: contextTreeRootNodeFrontmatterSchema,
  body: z.string().trim().min(1, "Root NODE.md must contain repository-wide context."),
});

export type ContextTreeRootNode = z.infer<typeof contextTreeRootNodeSchema>;

export function parseContextTreeRootNode(markdown: string): ContextTreeRootNode {
  if (Buffer.byteLength(markdown, "utf8") > CONTEXT_TREE_ROOT_NODE_MAX_BYTES) {
    throw new Error(`Root NODE.md exceeds the ${CONTEXT_TREE_ROOT_NODE_MAX_BYTES}-byte limit.`);
  }
  const document = parseMarkdownFrontmatter(markdown, { strictDelimiters: true });
  if (document.frontmatter === "missing") {
    throw new Error("Root NODE.md must contain YAML frontmatter.");
  }
  if (document.frontmatter === "invalid" || document.data === null) {
    throw new Error(`Root NODE.md frontmatter is invalid${document.error === undefined ? "." : `: ${document.error}`}`);
  }
  return contextTreeRootNodeSchema.parse({ frontmatter: document.data, body: document.body });
}

export const contextContentClassSchema = z.enum(["normal", "archive-supporting", "member", "repo-infra"]);
export type ContextContentClass = z.infer<typeof contextContentClassSchema>;

export const validationCodeSchema = z.enum(VALIDATION_CODES);
export type ValidationCode = z.infer<typeof validationCodeSchema>;

export const treeValidationFindingSchema = z
  .object({
    code: validationCodeSchema,
    message: z.string(),
    path: z.string(),
    target: z.string().optional(),
  })
  .strict();
export type TreeValidationFinding = z.infer<typeof treeValidationFindingSchema>;

export const contextContentClassCountsSchema = z
  .object({
    normal: z.number().int().nonnegative(),
    "archive-supporting": z.number().int().nonnegative(),
    member: z.number().int().nonnegative(),
    "repo-infra": z.number().int().nonnegative(),
  })
  .strict();
export type ContextContentClassCounts = z.infer<typeof contextContentClassCountsSchema>;

export const contextTreePolicySchema = z
  .object({
    content: z.string(),
    schemaVersion: z.literal(SCHEMA_VERSION),
  })
  .strict();
export type ContextTreePolicy = z.infer<typeof contextTreePolicySchema>;

export const contextTreeReadEntrySchema = z
  .object({
    content: z.string().optional(),
    contentClass: contextContentClassSchema,
    depth: z.number().int().nonnegative(),
    description: z.string().optional(),
    kind: z.enum(["directory", "file"]),
    path: z.string(),
    title: z.string(),
  })
  .strict();
export type ContextTreeReadEntry = z.infer<typeof contextTreeReadEntrySchema>;

export const contextTreeReadResultSchema = z
  .object({
    entries: z.array(contextTreeReadEntrySchema),
    root: z.string(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    target: z.string(),
  })
  .strict();
export type ContextTreeReadResult = z.infer<typeof contextTreeReadResultSchema>;

export const verifyTreeReportSchema = z
  .object({
    findings: z.array(treeValidationFindingSchema),
    ok: z.boolean(),
    root: z.string(),
    scannedByContentClass: contextContentClassCountsSchema,
    schemaVersion: z.literal(SCHEMA_VERSION),
  })
  .strict();
export type VerifyTreeReport = z.infer<typeof verifyTreeReportSchema>;

export const scaffoldTreeResultSchema = z
  .object({
    files: z.array(z.string()),
    root: z.string(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    verification: verifyTreeReportSchema,
  })
  .strict();
export type ScaffoldTreeResult = z.infer<typeof scaffoldTreeResultSchema>;

export const contextTreeCliErrorCodeSchema = z.enum(CLI_ERROR_CODES);
export type ContextTreeCliErrorCode = z.infer<typeof contextTreeCliErrorCodeSchema>;

export const contextTreeCliErrorSchema = z
  .object({
    code: contextTreeCliErrorCodeSchema,
    message: z.string(),
  })
  .strict();
export type ContextTreeCliError = z.infer<typeof contextTreeCliErrorSchema>;

export const contextTreeCliErrorEnvelopeSchema = z
  .object({
    error: contextTreeCliErrorSchema,
    ok: z.literal(false),
    schemaVersion: z.literal(SCHEMA_VERSION),
  })
  .strict();
export type ContextTreeCliErrorEnvelope = z.infer<typeof contextTreeCliErrorEnvelopeSchema>;
