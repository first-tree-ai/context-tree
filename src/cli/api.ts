import { resolve } from "node:path";

import { Command, CommanderError } from "commander";
import { connectProject, listManagedTrees, resolveConnection } from "../core/connections.js";
import { createProject } from "../core/create.js";
import {
  type InstallSkillsOptions,
  installSkills,
  type UninstallSkillsOptions,
  uninstallSkills,
} from "../core/install.js";
import { ContextTreeError } from "../core/internal/errors.js";
import { sanitizeCommandOutput } from "../core/internal/git.js";
import { readPackageVersion } from "../core/internal/packaged-resource.js";
import { publishProject } from "../core/publish.js";
import { readTree } from "../core/read.js";
import { syncProject } from "../core/sync.js";
import { verifyTree } from "../core/verify.js";
import { finishContextWrite, prepareContextWrite } from "../core/write.js";
import { CLI_ERROR_CODES, type ContextTreeCliErrorEnvelope, SCHEMA_VERSION, skillHostSchema } from "../schemas.js";
import {
  formatConnect,
  formatCreate,
  formatList,
  formatPublish,
  formatRead,
  formatResolve,
  formatVerify,
} from "./format.js";

type ContextTreeCliIo = {
  cwd: () => string;
  stdout: (value: string) => void;
  stderr?: (value: string) => void;
};

const defaultIo: ContextTreeCliIo = {
  cwd: () => process.cwd(),
  stderr: (value) => process.stderr.write(value),
  stdout: (value) => process.stdout.write(value),
};

/** Commands that default to human-readable text and accept --json to restore JSON. */
const TEXT_DEFAULT_COMMANDS = new Set(["create", "connect", "list", "resolve", "publish", "read", "verify"]);

function line(io: ContextTreeCliIo, value: string): void {
  io.stdout(`${value}\n`);
}

function errline(io: ContextTreeCliIo, value: string): void {
  (io.stderr ?? ((text) => process.stderr.write(text)))(`${value}\n`);
}

function emit<T>(io: ContextTreeCliIo, json: boolean, result: T, format: (value: T) => string): void {
  line(io, json ? JSON.stringify(result) : format(result));
}

const jsonOption = ["--json", "print machine-readable JSON (schema version 1) instead of text"] as const;

function createContextTreeCli(io: ContextTreeCliIo = defaultIo): Command {
  const program = new Command()
    .name("context-tree")
    .description("Create, connect, list, read, write, and publish Context Trees.")
    .addHelpCommand(false)
    .version(readPackageVersion())
    .exitOverride()
    .configureOutput({ writeErr: () => undefined, writeOut: io.stdout });

  program
    .command("create")
    .description("Create and connect one uniquely named managed Context Tree for the current project.")
    .option("--project-path <path>", "project directory", ".")
    .option(...jsonOption)
    .action((options: { json: boolean; projectPath: string }) => {
      emit(io, options.json, createProject(resolve(io.cwd(), options.projectPath)), formatCreate);
    });

  program
    .command("connect")
    .description("Connect the project by managed tree name, GitHub OWNER/REPO, or exact disk path.")
    .argument("[name-or-repository]", "managed tree name or GitHub OWNER/REPO")
    .option("--project-path <path>", "project directory", ".")
    .option("--tree-path <path>", "exact Context Tree Git root to connect in place")
    .option(...jsonOption)
    .action((target: string | undefined, options: { json: boolean; projectPath: string; treePath?: string }) => {
      const projectPath = resolve(io.cwd(), options.projectPath);
      if (target !== undefined && options.treePath !== undefined) {
        throw new Error("Connect requires exactly one of a name/repository or --tree-path.");
      }
      if (target !== undefined) {
        emit(io, options.json, connectProject({ projectPath, target }), formatConnect);
        return;
      }
      if (options.treePath !== undefined) {
        emit(
          io,
          options.json,
          connectProject({ projectPath, treePath: resolve(io.cwd(), options.treePath) }),
          formatConnect,
        );
        return;
      }
      throw new Error("Connect requires a managed tree name, GitHub OWNER/REPO, or --tree-path.");
    });

  program
    .command("list")
    .description("List valid clean managed Context Trees.")
    .option(...jsonOption)
    .action((options: { json: boolean }) => {
      emit(io, options.json, listManagedTrees(), formatList);
    });

  program
    .command("resolve")
    .description("Resolve the connected Context Tree for a project.")
    .option("--project-path <path>", "project directory", ".")
    .option(...jsonOption)
    .action((options: { json: boolean; projectPath: string }) => {
      emit(io, options.json, resolveConnection(resolve(io.cwd(), options.projectPath)), formatResolve);
    });

  program
    .command("sync")
    .description("Synchronize the connected Context Tree for a project.")
    .option("--project-path <path>", "project directory", ".")
    .action((options: { projectPath: string }) => {
      line(io, JSON.stringify(syncProject(resolve(io.cwd(), options.projectPath))));
    });

  program
    .command("prepare-write")
    .description("Prepare an isolated Context Tree worktree for a write.")
    .option("--project-path <path>", "project directory", ".")
    .action((options: { projectPath: string }) => {
      line(io, JSON.stringify(prepareContextWrite(resolve(io.cwd(), options.projectPath))));
    });

  program
    .command("finish-write")
    .description("Commit all pending changes in a prepared worktree and publish them.")
    .requiredOption("--worktree-path <path>", "prepared worktree path")
    .requiredOption("--message <message>", "commit message for the pending changes")
    .option("--project-path <path>", "project directory", ".")
    .action((options: { message: string; projectPath: string; worktreePath: string }) => {
      line(
        io,
        JSON.stringify(
          finishContextWrite({
            message: options.message,
            projectPath: resolve(io.cwd(), options.projectPath),
            worktreePath: resolve(io.cwd(), options.worktreePath),
          }),
        ),
      );
    });

  program
    .command("publish")
    .description("Publish the local tree as a new private GitHub repository.")
    .argument("[repository]", "GitHub OWNER/REPO override; defaults to the authenticated account and tree name")
    .option("--project-path <path>", "project directory", ".")
    .option(...jsonOption)
    .action((repository: string | undefined, options: { json: boolean; projectPath: string }) => {
      emit(io, options.json, publishProject(resolve(io.cwd(), options.projectPath), { repository }), formatPublish);
    });

  program
    .command("read")
    .description("Read an indexed Context Tree directory or Markdown leaf.")
    .argument("[path]", "tree-relative path", ".")
    .option("--tree-path <path>", "Context Tree root", ".")
    .option(...jsonOption)
    .action((path: string, options: { json: boolean; treePath: string }) => {
      const treePath = resolve(io.cwd(), options.treePath);
      if (!verifyTree(treePath).ok) {
        throw new ContextTreeError(
          CLI_ERROR_CODES.invalidTree,
          `Refusing to read an invalid Context Tree; run context-tree verify --tree-path ${treePath}.`,
        );
      }
      emit(io, options.json, readTree(treePath, path), formatRead);
    });

  program
    .command("verify")
    .description("Validate Context Tree structure and safety.")
    .option("--tree-path <path>", "Context Tree root", ".")
    .option(...jsonOption)
    .action((options: { json: boolean; treePath: string }) => {
      const result = verifyTree(resolve(io.cwd(), options.treePath));
      emit(io, options.json, result, formatVerify);
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command("install")
    .description("Install the packaged Context Tree skills into each agent's skill directory.")
    .option("--host <host>", "restrict to one host: claude, codex, or all", "all")
    .option("--project <path>", "install below this project root instead of the home directory")
    .action((options: { host: string; project?: string }) => {
      const request: InstallSkillsOptions = {};
      if (options.host !== "all") request.hosts = [skillHostSchema.parse(options.host)];
      if (options.project !== undefined) request.projectPath = resolve(io.cwd(), options.project);
      line(io, JSON.stringify(installSkills(request)));
    });

  program
    .command("uninstall")
    .description("Remove packaged Context Tree skills from each agent's skill directory.")
    .option("--host <host>", "restrict to one host: claude, codex, or all", "all")
    .option("--project <path>", "remove below this project root instead of the home directory")
    .action((options: { host: string; project?: string }) => {
      const request: UninstallSkillsOptions = {};
      if (options.host !== "all") request.hosts = [skillHostSchema.parse(options.host)];
      if (options.project !== undefined) request.projectPath = resolve(io.cwd(), options.project);
      line(io, JSON.stringify(uninstallSkills(request)));
    });

  return program;
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
    const code = error instanceof ContextTreeError ? error.code : CLI_ERROR_CODES.failed;
    const message = sanitizeCommandOutput(error instanceof Error ? error.message : String(error));
    if (usesTextErrors(argv)) {
      errline(io, `context-tree: ${message}`);
    } else {
      const envelope: ContextTreeCliErrorEnvelope = {
        error: { code, message },
        ok: false,
        schemaVersion: SCHEMA_VERSION,
      };
      line(io, JSON.stringify(envelope));
    }
    process.exitCode = 1;
    return 1;
  }
}

/** A text-default command failing without --json reports a human-readable line on stderr. */
function usesTextErrors(argv: string[]): boolean {
  if (argv.includes("--json")) return false;
  const subcommand = argv.slice(2).find((token) => !token.startsWith("-"));
  return subcommand !== undefined && TEXT_DEFAULT_COMMANDS.has(subcommand);
}
