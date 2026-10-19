import { isAbsolute } from "node:path";

import { z } from "zod";

export const SCHEMA_VERSION = 3 as const;
export const TREE_DOCUMENT_SCHEMA_VERSION = 1 as const;
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
  markdownPathEscape: "TREE_MARKDOWN_LINK_PATH_ESCAPE",
  symlinkUnsupported: "TREE_SYMLINK_UNSUPPORTED",
} as const;

export const CLI_ERROR_CODES = {
  ambiguousConnection: "AMBIGUOUS_CONNECTION",
  corruptConnection: "INVALID_CONFIG",
  dirtyTree: "DIRTY_TREE",
  failed: "CONTEXT_TREE_FAILED",
  invalidTree: "INVALID_TREE",
  noConnection: "NO_CONNECTION",
  writeOutdated: "WRITE_OUTDATED",
  scopeViolation: "OUTSIDE_TREE",
  busy: "BUSY",
} as const;

function hasUnsafeCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029);
  });
}

export const absoluteSingleLinePathSchema = z.string().superRefine((value, context) => {
  if (!isAbsolute(value) || value.trim() !== value || hasUnsafeCharacter(value)) {
    context.addIssue({ code: "custom", message: "Paths must be absolute single-line values." });
  }
});

export const repositoryNameSchema = z.string().superRefine((value, context) => {
  if (!/^[A-Za-z\d][A-Za-z\d._-]{0,99}$/u.test(value) || /\.git$/iu.test(value)) {
    context.addIssue({ code: "custom", message: "Repository name must be a safe single path segment." });
  }
});

export const githubRepositoryIdentitySchema = z.string().superRefine((value, context) => {
  const parts = value.split("/");
  const [owner, name] = parts;
  if (
    parts.length !== 2 ||
    owner === undefined ||
    name === undefined ||
    !/^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?$/u.test(owner) ||
    !repositoryNameSchema.safeParse(name).success
  ) {
    context.addIssue({ code: "custom", message: "Repository must be an explicit GitHub OWNER/REPO identity." });
  }
});

export const contextTreeRootNodeFrontmatterSchema = z
  .object({
    schemaVersion: z.literal(TREE_DOCUMENT_SCHEMA_VERSION),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    soft_links: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .loose();

export const contextTreeRootNodeSchema = z.object({
  frontmatter: contextTreeRootNodeFrontmatterSchema,
  body: z.string().trim().min(1, "Root NODE.md must contain tree-wide context."),
});

export type ContextTreeRootNode = z.infer<typeof contextTreeRootNodeSchema>;

export const contextContentClassSchema = z.enum(["normal", "member", "repo-infra"]);
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
    member: z.number().int().nonnegative(),
    "repo-infra": z.number().int().nonnegative(),
  })
  .strict();
export type ContextContentClassCounts = z.infer<typeof contextContentClassCountsSchema>;

export const SKILL_HOSTS = ["claude", "codex", "pi"] as const;
export const skillHostSchema = z.enum(SKILL_HOSTS);
export type SkillHost = z.infer<typeof skillHostSchema>;

export const skillInstallationSchema = z
  .object({
    host: skillHostSchema,
    path: absoluteSingleLinePathSchema,
    skills: z.array(z.string().trim().min(1)),
  })
  .strict();
export type SkillInstallation = z.infer<typeof skillInstallationSchema>;

export const skillInstallSkipSchema = z
  .object({
    host: skillHostSchema,
    reason: z.string().trim().min(1),
  })
  .strict();
export type SkillInstallSkip = z.infer<typeof skillInstallSkipSchema>;

export const installSkillsResultSchema = z
  .object({
    installed: z.array(skillInstallationSchema),
    schemaVersion: z.literal(SCHEMA_VERSION),
    skipped: z.array(skillInstallSkipSchema),
    version: z.string().trim().min(1),
  })
  .strict();
export type InstallSkillsResult = z.infer<typeof installSkillsResultSchema>;

export const uninstallSkillsResultSchema = z
  .object({
    removed: z.array(skillInstallationSchema),
    schemaVersion: z.literal(SCHEMA_VERSION),
    skipped: z.array(skillInstallSkipSchema),
    version: z.string().trim().min(1),
  })
  .strict();
export type UninstallSkillsResult = z.infer<typeof uninstallSkillsResultSchema>;

const contextTreeReadKindSchema = z.enum(["directory", "file"]);
const contextTreeReadCommonFields = {
  contentClass: contextContentClassSchema,
  kind: contextTreeReadKindSchema,
  path: z.string(),
};

export const contextTreeReadNodeSchema = z
  .object({
    body: z.string(),
    frontmatter: z.record(z.string(), z.unknown()),
    ...contextTreeReadCommonFields,
  })
  .strict();
export type ContextTreeReadNode = z.infer<typeof contextTreeReadNodeSchema>;

export const contextTreeReadChildSchema = z
  .object({
    description: z.string().optional(),
    title: z.string(),
    ...contextTreeReadCommonFields,
  })
  .strict();
export type ContextTreeReadChild = z.infer<typeof contextTreeReadChildSchema>;

export const contextTreeReadResultSchema = z
  .object({
    children: z.array(contextTreeReadChildSchema),
    node: contextTreeReadNodeSchema,
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

/** A subtree is canonical POSIX, never a pathspec or an escape from its root. */
export const subtreeSchema = z
  .string()
  .refine(
    (value) =>
      value === "." ||
      (value.length > 0 &&
        !value.includes("\\") &&
        !hasUnsafeCharacter(value) &&
        value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git")),
    "Use a relative subtree path without empty, dot, parent, or .git segments.",
  );
export const directoryPathSchema = z.union([absoluteSingleLinePathSchema, subtreeSchema]);
export const branchSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !hasUnsafeCharacter(value) &&
      !/[\s~^:?*[\\]/u.test(value) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith(".") &&
      value !== "@" &&
      value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")) &&
      !value.startsWith("-"),
    "Use a Git branch name, not a revision expression.",
  );
export const treeSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: directoryPathSchema }).strict(),
  z
    .object({
      kind: z.literal("git"),
      repository: githubRepositoryIdentitySchema.transform((value) => value.toLowerCase()),
      path: subtreeSchema,
      ref: branchSchema,
    })
    .strict(),
]);
export type TreeSource = z.infer<typeof treeSourceSchema>;
export const projectConfigSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    trees: z.array(treeSourceSchema),
  })
  .strict();
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export const connectionSchema = z
  .object({
    projectRoot: absoluteSingleLinePathSchema,
    source: treeSourceSchema,
  })
  .strict();
export type Connection = z.infer<typeof connectionSchema>;
export const repositoryLocationSchema = z
  .object({
    root: absoluteSingleLinePathSchema,
    directory: subtreeSchema,
    sha: z.string().min(1),
    branch: z.string().nullable(),
  })
  .strict();
export const resolvedTreeSchema = z
  .object({
    connection: connectionSchema,
    treeRoot: absoluteSingleLinePathSchema,
    repository: repositoryLocationSchema.nullable(),
    dirty: z.boolean(),
  })
  .strict();
export type ResolvedTree = z.infer<typeof resolvedTreeSchema>;
export const errorSchema = z.object({ code: z.enum(CLI_ERROR_CODES), message: z.string() }).strict();
export type ContextTreeCliErrorCode = z.infer<typeof errorSchema>["code"];
export const discoverySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), ...resolvedTreeSchema.shape }).strict(),
  z.object({ ok: z.literal(false), connection: connectionSchema, error: errorSchema }).strict(),
]);
export const resolveResultSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    connections: z.array(discoverySchema),
  })
  .strict();
export type ResolveResult = z.infer<typeof resolveResultSchema>;
export const writeSessionSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().uuid(),
    connection: connectionSchema,
    treeRoot: absoluteSingleLinePathSchema,
    mode: z.enum(["workspace", "isolated"]),
    repository: repositoryLocationSchema.nullable(),
    worktreeRoot: absoluteSingleLinePathSchema.nullable(),
    taskBranch: z.string().nullable(),
    commit: z.string().nullable(),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.mode === "isolated" && (!session.repository || !session.worktreeRoot || !session.taskBranch))
      context.addIssue({ code: "custom", message: "Isolated sessions require a repository, worktree, and branch." });
    if (session.mode === "workspace" && (session.worktreeRoot || session.taskBranch || session.commit))
      context.addIssue({ code: "custom", message: "Workspace sessions do not own Git state." });
  });
export type WriteSession = z.infer<typeof writeSessionSchema>;
export const finishWriteResultSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    outcome: z.enum(["validated", "unchanged", "committed", "published"]),
    treeRoot: absoluteSingleLinePathSchema,
    branch: z.string().nullable(),
    sha: z.string().nullable(),
    sessionId: z.string().uuid().nullable(),
  })
  .strict();
export type FinishWriteResult = z.infer<typeof finishWriteResultSchema>;
export const cleanupScheduleSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    projectPath: absoluteSingleLinePathSchema,
    source: treeSourceSchema,
    identity: z.string(),
    agent: skillHostSchema,
    model: z.string().min(1).optional(),
    everyMinutes: z.number().int().positive().max(525600),
    nodePath: absoluteSingleLinePathSchema,
    cliPath: absoluteSingleLinePathSchema,
    agentPath: absoluteSingleLinePathSchema,
    searchPath: z.string(),
    publish: z.boolean(),
    enabled: z.boolean(),
  })
  .strict();
export type CleanupSchedule = z.infer<typeof cleanupScheduleSchema>;
export const cleanupOutcomeSchema = z
  .object({
    at: z.number(),
    runId: z.string().uuid().optional(),
    outcome: z.enum([
      "inactive",
      "unchanged",
      "noop",
      "committed",
      "published",
      "running",
      "failed",
      "cancelled",
      "publication-uncertain",
    ]),
    worktreePath: z.string().optional(),
    sessionId: z.string().uuid().optional(),
    sha: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();
export type CleanupOutcome = z.infer<typeof cleanupOutcomeSchema>;
export const cleanupLogEventSchema = z
  .object({
    at: z.number().finite(),
    source: z.enum(["runner", "stdout", "stderr"]),
    text: z.string(),
  })
  .strict();
export type CleanupLogEvent = z.infer<typeof cleanupLogEventSchema>;
export const cleanupRunMetadataSchema = z
  .object({
    runId: z.string().uuid(),
    startedAt: z.number().finite(),
    agent: skillHostSchema,
    model: z.string().optional(),
    truncated: z.boolean(),
    terminal: cleanupOutcomeSchema.optional(),
  })
  .strict();
export type CleanupRunMetadata = z.infer<typeof cleanupRunMetadataSchema>;
export const cleanupLogsResultSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    runs: z.array(cleanupRunMetadataSchema),
    selectedRunId: z.string().uuid().nullable(),
    events: z.array(cleanupLogEventSchema),
  })
  .strict();
export type CleanupLogsResult = z.infer<typeof cleanupLogsResultSchema>;
export const cleanupResultSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    schedule: cleanupScheduleSchema.nullable(),
    registered: z.boolean(),
    running: z.boolean(),
    latest: cleanupOutcomeSchema.nullable(),
  })
  .strict();
export type CleanupResult = z.infer<typeof cleanupResultSchema>;
