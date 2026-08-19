import { resolve } from "node:path";

import { Command, CommanderError } from "commander";
import { readPackageManifest } from "../core/internal/packaged-resource.js";
import type { ReadTreeOptions } from "../core/read.js";
import { readContextTreePolicy, readTree, scaffoldTree, verifyTree } from "../index.js";
import {
  CLI_ERROR_CODES,
  type ContextContentClass,
  type ContextTreeCliErrorEnvelope,
  contextContentClassSchema,
  SCHEMA_VERSION,
} from "../schemas.js";

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
  const manifest = readPackageManifest();
  if (!("version" in manifest) || typeof manifest.version !== "string") {
    throw new Error("Package version is missing or invalid.");
  }
  return manifest.version;
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

export function createContextTreeCli(io: ContextTreeCliIo = defaultIo): Command {
  const program = new Command()
    .name("context-tree")
    .description("Portable tools for scaffolding, reading, and validating Context Trees.")
    .addHelpCommand(false)
    .version(packageVersion())
    .exitOverride()
    .configureOutput({ writeErr: () => undefined, writeOut: io.stdout });

  program
    .command("policy")
    .description("Print the canonical packaged Context Tree policy.")
    .action(() => {
      line(io, JSON.stringify(readContextTreePolicy()));
    });

  program
    .command("init")
    .description("Scaffold a new GitHub-backed Context Tree.")
    .requiredOption("--tree-path <path>", "destination directory")
    .requiredOption("--repository <owner/repo>", "GitHub repository identity")
    .requiredOption("--title <title>", "tree title")
    .requiredOption("--owner <owner>", "initial owner identifier")
    .action((options: { owner: string; repository: string; title: string; treePath: string }) => {
      const result = scaffoldTree({
        owner: options.owner,
        path: resolve(io.cwd(), options.treePath),
        repository: options.repository,
        title: options.title,
      });
      line(io, JSON.stringify(result));
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
        line(io, JSON.stringify(result));
      },
    );

  program
    .command("verify")
    .description("Validate Context Tree structure and safety.")
    .option("--tree-path <path>", "Context Tree root", ".")
    .action((options: { treePath: string }) => {
      const result = verifyTree(resolve(io.cwd(), options.treePath));
      line(io, JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
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
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const code = CLI_ERROR_CODES.failed;
    const message = sanitizeError(error instanceof Error ? error.message : String(error));
    const envelope: ContextTreeCliErrorEnvelope = {
      error: { code, message },
      ok: false,
      schemaVersion: SCHEMA_VERSION,
    };
    line(io, JSON.stringify(envelope));
    process.exitCode = 1;
    return 1;
  }
}
