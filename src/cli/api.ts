import { resolve } from "node:path";

import { Command, CommanderError } from "commander";
import { readPackageVersion } from "../core/internal/packaged-resource.js";
import { identifyProject, LinkError, linkProject, resolveLink } from "../core/links.js";
import { inspectContextTreeDiff, refreshProject, stageContextWrite } from "../core/live.js";
import type { PushTreeOptions } from "../core/push.js";
import { pushTree } from "../core/push.js";
import { readContextTreePolicy, readTree, scaffoldTree, verifyTree } from "../index.js";
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
    .description("Portable tools for linking, resolving, scaffolding, reading, and validating Context Trees.")
    .addHelpCommand(false)
    .version(readPackageVersion())
    .exitOverride()
    .configureOutput({ writeErr: () => undefined, writeOut: io.stdout });

  program
    .command("link")
    .description("Link a project to a verified Context Tree checkout.")
    .requiredOption("--project-path <path>", "Git project or non-Git project directory")
    .requiredOption("--tree-path <path>", "Context Tree checkout")
    .action((options: { projectPath: string; treePath: string }) => {
      line(
        io,
        JSON.stringify(linkProject(resolve(io.cwd(), options.projectPath), resolve(io.cwd(), options.treePath))),
      );
    });

  program
    .command("policy")
    .description("Print the canonical packaged Context Tree policy.")
    .action(() => {
      line(io, JSON.stringify(readContextTreePolicy()));
    });

  program
    .command("resolve")
    .description("Resolve the linked Context Tree for a project.")
    .option("--project-path <path>", "Git project or non-Git project directory", ".")
    .action((options: { projectPath: string }) => {
      line(io, JSON.stringify(resolveLink(resolve(io.cwd(), options.projectPath))));
    });

  program
    .command("refresh")
    .description("Refresh a linked Context Tree to its live default branch.")
    .option("--project-path <path>", "Git Tree or non-Git project directory", ".")
    .action((options: { projectPath: string }) => {
      line(io, JSON.stringify(refreshProject(resolve(io.cwd(), options.projectPath))));
    });

  program
    .command("stage")
    .description("Prepare an isolated Context Tree worktree at the live default branch for a write.")
    .option("--project-path <path>", "Git Tree or non-Git project directory", ".")
    .action((options: { projectPath: string }) => {
      line(io, JSON.stringify(stageContextWrite(resolve(io.cwd(), options.projectPath))));
    });

  program
    .command("diff")
    .description("Inspect the pending changes of a prepared Context Tree worktree.")
    .argument("[tree-path]", "Context Tree root", ".")
    .option("--base <ref>", "Base ref or commit to diff against (default HEAD)")
    .action((treePath: string, options: { base?: string }) => {
      line(io, JSON.stringify(inspectContextTreeDiff(resolve(io.cwd(), treePath), options.base)));
    });

  program
    .command("init")
    .description("Scaffold a new local Context Tree with an initial commit.")
    .argument("<name>", "Local tree name")
    .option("--tree-path <path>", "destination directory (default ./<name>)")
    .action((name: string, options: { treePath?: string }) => {
      const projectPath = resolve(io.cwd());
      let project: ReturnType<typeof identifyProject> | undefined;
      try {
        project = identifyProject(projectPath);
      } catch {
        // A Git repository without an unambiguous safe origin is not automatically linked.
      }
      const result = scaffoldTree({ name, path: resolve(io.cwd(), options.treePath ?? name) });
      if (project !== undefined) linkProject(projectPath, result.root);
      line(io, JSON.stringify(result));
    });

  program
    .command("push")
    .description("Create a private GitHub repository when needed and push committed local state.")
    .argument("[repository]", "GitHub OWNER/REPO to create and push to")
    .option("--tree-path <path>", "Context Tree root", ".")
    .action((repository: string | undefined, options: { treePath: string }) => {
      const pushOptions: PushTreeOptions = { path: resolve(io.cwd(), options.treePath) };
      if (repository !== undefined) pushOptions.repository = repository;
      line(io, JSON.stringify(pushTree(pushOptions)));
    });

  program
    .command("read")
    .description("Read an indexed Context Tree directory or Markdown leaf.")
    .argument("[path]", "tree-relative path", ".")
    .option("--tree-path <path>", "Context Tree root", ".")
    .action((path: string, options: { treePath: string }) => {
      const verification = verifyTree(resolve(io.cwd(), options.treePath));
      if (!verification.ok) throw new Error("Refusing to read an invalid Context Tree; run context-tree verify.");
      const result = readTree(resolve(io.cwd(), options.treePath), path);
      line(io, JSON.stringify(result));
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
    const code = error instanceof LinkError ? error.code : CLI_ERROR_CODES.failed;
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
