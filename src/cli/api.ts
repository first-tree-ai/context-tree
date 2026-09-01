import { resolve } from "node:path";

import { Command, CommanderError } from "commander";
import { connectProject, listManagedTrees, resolveConnection } from "../core/connections.js";
import { createProject } from "../core/create.js";
import { ContextTreeError } from "../core/internal/errors.js";
import { sanitizeCommandOutput } from "../core/internal/git.js";
import { readPackageVersion } from "../core/internal/packaged-resource.js";
import { publishProject } from "../core/publish.js";
import { syncProject } from "../core/sync.js";
import { finishContextWrite, prepareContextWrite } from "../core/write.js";
import { readContextTreePolicy, readTree, verifyTree } from "../index.js";
import { CLI_ERROR_CODES, type ContextTreeCliErrorEnvelope, SCHEMA_VERSION } from "../schemas.js";

type ContextTreeCliIo = {
  cwd: () => string;
  stdout: (value: string) => void;
};

const defaultIo: ContextTreeCliIo = {
  cwd: () => process.cwd(),
  stdout: (value) => process.stdout.write(value),
};

function line(io: ContextTreeCliIo, value: string): void {
  io.stdout(`${value}\n`);
}

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
    .action((options: { projectPath: string }) => {
      line(io, JSON.stringify(createProject(resolve(io.cwd(), options.projectPath))));
    });

  program
    .command("connect")
    .description("Connect the project by managed tree name, GitHub OWNER/REPO, or exact disk path.")
    .argument("[name-or-repository]", "managed tree name or GitHub OWNER/REPO")
    .option("--project-path <path>", "project directory", ".")
    .option("--tree-path <path>", "exact Context Tree Git root to connect in place")
    .action((target: string | undefined, options: { projectPath: string; treePath?: string }) => {
      const projectPath = resolve(io.cwd(), options.projectPath);
      if (target !== undefined && options.treePath !== undefined) {
        throw new Error("Connect requires exactly one of a name/repository or --tree-path.");
      }
      if (target !== undefined) {
        line(io, JSON.stringify(connectProject({ projectPath, target })));
        return;
      }
      if (options.treePath !== undefined) {
        line(io, JSON.stringify(connectProject({ projectPath, treePath: resolve(io.cwd(), options.treePath) })));
        return;
      }
      throw new Error("Connect requires a managed tree name, GitHub OWNER/REPO, or --tree-path.");
    });

  program
    .command("list")
    .description("List valid clean managed Context Trees.")
    .action(() => {
      line(io, JSON.stringify(listManagedTrees()));
    });

  program
    .command("resolve")
    .description("Resolve the connected Context Tree for a project.")
    .option("--project-path <path>", "project directory", ".")
    .action((options: { projectPath: string }) => {
      line(io, JSON.stringify(resolveConnection(resolve(io.cwd(), options.projectPath))));
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
    .action((repository: string | undefined, options: { projectPath: string }) => {
      line(io, JSON.stringify(publishProject(resolve(io.cwd(), options.projectPath), { repository })));
    });

  program
    .command("read")
    .description("Read an indexed Context Tree directory or Markdown leaf.")
    .argument("[path]", "tree-relative path", ".")
    .option("--tree-path <path>", "Context Tree root", ".")
    .action((path: string, options: { treePath: string }) => {
      const treePath = resolve(io.cwd(), options.treePath);
      if (!verifyTree(treePath).ok) {
        throw new ContextTreeError(
          CLI_ERROR_CODES.invalidTree,
          `Refusing to read an invalid Context Tree; run context-tree verify --tree-path ${treePath}.`,
        );
      }
      line(io, JSON.stringify(readTree(treePath, path)));
    });

  program
    .command("verify")
    .description("Validate Context Tree structure and safety.")
    .option("--tree-path <path>", "Context Tree root", ".")
    .action((options: { treePath: string }) => {
      const result = verifyTree(resolve(io.cwd(), options.treePath));
      line(io, JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command("policy")
    .description("Print the canonical packaged Context Tree policy.")
    .action(() => {
      line(io, JSON.stringify(readContextTreePolicy()));
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
