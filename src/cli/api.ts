import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import type { AuditTreeOptions } from "../core/audit.js";
import { formatValidationFinding } from "../core/internal/validation-finding.js";
import type { ReadTreeOptions } from "../core/read.js";
import {
  applyWritePlan,
  auditTree,
  ContextTreeWriteError,
  readContextTreePolicy,
  readTree,
  scaffoldTree,
  verifyTree,
} from "../index.js";
import { type ContextContentClass, contextContentClassSchema } from "../schemas.js";

export type ContextTreeCliIo = {
  cwd: () => string;
  stderr: (value: string) => void;
  stdout: (value: string) => void;
};

const defaultIo: ContextTreeCliIo = {
  cwd: () => process.cwd(),
  stderr: (value) => process.stderr.write(value),
  stdout: (value) => process.stdout.write(value),
};

function line(io: ContextTreeCliIo, value: string): void {
  io.stdout(`${value}\n`);
}

function packageVersion(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packagePath = [
    resolve(moduleDirectory, "..", "package.json"),
    resolve(moduleDirectory, "..", "..", "package.json"),
  ].find(existsSync);
  if (!packagePath) throw new Error("Package metadata is missing.");
  const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") {
    throw new Error("Package version is missing or invalid.");
  }
  return parsed.version;
}

function jsonMode(command: Command): boolean {
  return command.optsWithGlobals<{ json?: boolean }>().json === true;
}

function parseDepth(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("--depth must be a non-negative integer.");
  return parsed;
}

function parseClass(value: string | undefined): ContextContentClass[] | "all" | undefined {
  if (value === undefined) return undefined;
  if (value === "all") return "all";
  return [contextContentClassSchema.parse(value)];
}

function renderRead(io: ContextTreeCliIo, result: ReturnType<typeof readTree>): void {
  line(io, `Tree: ${result.root}`);
  line(io, `Digest: ${result.treeDigest}`);
  for (const entry of result.entries) {
    const indent = "  ".repeat(entry.depth);
    const suffix = entry.kind === "directory" ? "/" : "";
    line(io, `${indent}${entry.path}${suffix} [${entry.title}] (${entry.contentClass})`);
    if (entry.content !== undefined) {
      line(io, "");
      line(io, entry.content.replace(/\n$/u, ""));
    }
  }
}

function renderVerify(io: ContextTreeCliIo, result: ReturnType<typeof verifyTree>): void {
  if (result.ok) {
    line(io, `Context Tree is valid: ${result.root}`);
    return;
  }
  line(io, `Context Tree is invalid: ${result.root}`);
  for (const finding of result.findings) line(io, formatValidationFinding(finding));
}

function renderAudit(io: ContextTreeCliIo, result: ReturnType<typeof auditTree>): void {
  line(io, `Tree: ${result.root}`);
  line(io, `Scope: ${result.scope}`);
  line(io, `Digest: ${result.treeDigest}`);
  line(io, `Verification: ${result.verification.ok ? "valid" : "invalid"}`);
  line(io, `Entries: ${result.entries.length}`);
  for (const finding of result.verification.findings) line(io, formatValidationFinding(finding));
}

export function createContextTreeCli(io: ContextTreeCliIo = defaultIo): Command {
  const program = new Command()
    .name("context-tree")
    .description("Portable tools for reading, writing, and auditing Context Trees.")
    .version(packageVersion())
    .option("--json", "emit versioned JSON");

  program
    .command("policy")
    .description("Print the canonical packaged Context Tree policy.")
    .action((_options: Record<string, never>, command: Command) => {
      const policy = readContextTreePolicy();
      if (jsonMode(command)) line(io, JSON.stringify(policy));
      else io.stdout(policy.content);
    });

  program
    .command("init")
    .description("Scaffold a new local Context Tree.")
    .requiredOption("--tree-path <path>", "destination directory")
    .requiredOption("--title <title>", "tree title")
    .requiredOption("--owner <owner>", "initial owner identifier")
    .action((options: { owner: string; title: string; treePath: string }, command: Command) => {
      const result = scaffoldTree({
        owner: options.owner,
        path: resolve(io.cwd(), options.treePath),
        title: options.title,
      });
      if (jsonMode(command)) line(io, JSON.stringify(result));
      else {
        line(io, `Created Context Tree at ${result.root}`);
        for (const file of result.files) line(io, `  ${file}`);
      }
    });

  program
    .command("read")
    .description("Read a Context Tree hierarchy and optional file content.")
    .argument("[path]", "tree-relative path", ".")
    .option("--tree-path <path>", "Context Tree root", ".")
    .option("--pattern <glob>", "glob matched against paths and metadata")
    .option("--depth <number>", "maximum depth below the selected path")
    .option("--class <class>", "normal, archive-supporting, member, or all")
    .option("--content", "include Markdown bodies")
    .action(
      (
        path: string,
        options: { class?: string; content?: boolean; depth?: string; pattern?: string; treePath: string },
        command: Command,
      ) => {
        const verification = verifyTree(resolve(io.cwd(), options.treePath));
        if (!verification.ok) throw new Error("Refusing to read an invalid Context Tree; run context-tree verify.");
        const readOptions: ReadTreeOptions = {
          content: options.content === true,
          path,
        };
        const classes = parseClass(options.class);
        const depth = parseDepth(options.depth);
        if (classes !== undefined) readOptions.classes = classes;
        if (depth !== undefined) readOptions.depth = depth;
        if (options.pattern !== undefined) readOptions.pattern = options.pattern;
        const result = readTree(resolve(io.cwd(), options.treePath), readOptions);
        if (jsonMode(command)) line(io, JSON.stringify(result));
        else renderRead(io, result);
      },
    );

  program
    .command("verify")
    .description("Validate Context Tree structure and safety.")
    .option("--tree-path <path>", "Context Tree root", ".")
    .action((options: { treePath: string }, command: Command) => {
      const result = verifyTree(resolve(io.cwd(), options.treePath));
      if (jsonMode(command)) line(io, JSON.stringify(result));
      else renderVerify(io, result);
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command("audit")
    .description("Create a deterministic mechanical audit evidence bundle.")
    .argument("[path]", "tree-relative scope", ".")
    .option("--tree-path <path>", "Context Tree root", ".")
    .option("--pattern <glob>", "glob matched against paths and metadata")
    .option("--depth <number>", "maximum depth below the selected path")
    .option("--class <class>", "normal, archive-supporting, member, or all", "all")
    .action(
      (
        path: string,
        options: { class?: string; depth?: string; pattern?: string; treePath: string },
        command: Command,
      ) => {
        const auditOptions: AuditTreeOptions = { path };
        const classes = parseClass(options.class);
        const depth = parseDepth(options.depth);
        if (classes !== undefined) auditOptions.classes = classes;
        if (depth !== undefined) auditOptions.depth = depth;
        if (options.pattern !== undefined) auditOptions.pattern = options.pattern;
        const result = auditTree(resolve(io.cwd(), options.treePath), auditOptions);
        if (jsonMode(command)) line(io, JSON.stringify(result));
        else renderAudit(io, result);
        if (!result.verification.ok) process.exitCode = 1;
      },
    );

  program
    .command("write")
    .description("Apply a guarded, explicit local write plan.")
    .option("--tree-path <path>", "Context Tree root", ".")
    .option("--plan <file>", "JSON write plan file")
    .option("--stdin", "read the JSON write plan from stdin")
    .option("--dry-run", "validate without changing files")
    .action((options: { dryRun?: boolean; plan?: string; stdin?: boolean; treePath: string }, command: Command) => {
      if ((options.plan ? 1 : 0) + (options.stdin ? 1 : 0) !== 1) {
        throw new Error("Choose exactly one of --plan or --stdin.");
      }
      const source = options.stdin
        ? readFileSync(0, "utf8")
        : readFileSync(resolve(io.cwd(), options.plan ?? ""), "utf8");
      const result = applyWritePlan(resolve(io.cwd(), options.treePath), JSON.parse(source) as unknown, {
        dryRun: options.dryRun === true,
      });
      if (jsonMode(command)) line(io, JSON.stringify(result));
      else {
        line(io, `${result.dryRun ? "Validated" : "Applied"} ${result.operations.length} operation(s).`);
        line(io, `Before: ${result.beforeTreeDigest}`);
        line(io, `After:  ${result.afterTreeDigest}`);
      }
    });

  return program;
}

function sanitizeError(message: string): string {
  return message.replace(/(?:https?|ssh):\/\/[^\s/@]+@/giu, "<redacted>@");
}

export async function runContextTreeCli(
  argv: string[] = process.argv,
  io: ContextTreeCliIo = defaultIo,
): Promise<number> {
  const program = createContextTreeCli(io);
  try {
    await program.parseAsync(argv);
    return typeof process.exitCode === "number" && process.exitCode !== 0 ? process.exitCode : 0;
  } catch (error) {
    const code = error instanceof ContextTreeWriteError ? error.code : "CONTEXT_TREE_FAILED";
    const message = sanitizeError(error instanceof Error ? error.message : String(error));
    if (program.opts<{ json?: boolean }>().json === true) {
      line(io, JSON.stringify({ error: { code, message }, ok: false, schemaVersion: 1 }));
    } else {
      io.stderr(`[${code}] ${message}\n`);
    }
    process.exitCode = 1;
    return 1;
  }
}
