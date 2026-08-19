import { parse } from "yaml";
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;
export const CONTEXT_TREE_SCOPE_MAX_BYTES = 16 * 1024;

const SHA256_RE = /^[a-f\d]{64}$/u;

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
      (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
      !parsed.hostname ||
      parsed.pathname.split("/").every((part) => part.length === 0) ||
      parsed.password ||
      (parsed.protocol === "https:" && parsed.username)
    ) {
      throw new Error("invalid transport");
    }
  } catch {
    context.addIssue({
      code: "custom",
      message: "Repository URLs must use credential-free HTTPS, ssh://, or scp-like SSH syntax.",
    });
  }
});

export const contextTreeScopeFrontmatterSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    relatedRepositories: z.array(credentialFreeRepositoryUrlSchema).max(100).optional(),
  })
  .strict();

export const contextTreeScopeSchema = z.object({
  frontmatter: contextTreeScopeFrontmatterSchema,
  body: z.string().trim().min(1, "SCOPE.md must describe what the Context Tree covers."),
});

export type ContextTreeScope = z.infer<typeof contextTreeScopeSchema>;

export function parseContextTreeScope(markdown: string): ContextTreeScope {
  if (Buffer.byteLength(markdown, "utf8") > CONTEXT_TREE_SCOPE_MAX_BYTES) {
    throw new Error(`SCOPE.md exceeds the ${CONTEXT_TREE_SCOPE_MAX_BYTES}-byte limit.`);
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(markdown);
  if (!match?.[1]) throw new Error("SCOPE.md must contain YAML frontmatter.");
  let frontmatter: unknown;
  try {
    frontmatter = parse(match[1]);
  } catch (error) {
    throw new Error(`SCOPE.md frontmatter is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return contextTreeScopeSchema.parse({ frontmatter, body: match[2] ?? "" });
}

export const contextContentClassSchema = z.enum(["normal", "archive-supporting", "member", "repo-infra"]);
export type ContextContentClass = z.infer<typeof contextContentClassSchema>;

const writePathSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Paths must not have surrounding whitespace.")
  .refine((value) => !hasUnsafeCharacter(value), "Paths must not contain control characters.")
  .refine((value) => !value.includes("\\"), "Paths must use POSIX separators.")
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "Paths must remain inside the tree.")
  .refine((value) => value.endsWith(".md"), "Context Tree write operations may target only Markdown files.");

export const contextTreeWriteOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), path: writePathSchema, content: z.string() }).strict(),
  z
    .object({
      op: z.literal("replace"),
      path: writePathSchema,
      expectedSha256: z.string().regex(SHA256_RE),
      content: z.string(),
    })
    .strict(),
  z.object({ op: z.literal("delete"), path: writePathSchema, expectedSha256: z.string().regex(SHA256_RE) }).strict(),
]);

export const contextTreeWritePlanSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    expectedTreeDigest: z.string().regex(SHA256_RE),
    operations: z.array(contextTreeWriteOperationSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = new Set<string>();
    for (const operation of value.operations) {
      if (paths.has(operation.path)) {
        context.addIssue({ code: "custom", message: `Duplicate write target: ${operation.path}` });
      }
      paths.add(operation.path);
    }
  });

export type ContextTreeWriteOperation = z.infer<typeof contextTreeWriteOperationSchema>;
export type ContextTreeWritePlan = z.infer<typeof contextTreeWritePlanSchema>;
