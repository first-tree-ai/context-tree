import { resolve } from "node:path";
import { Command, CommanderError, Option } from "commander";
import { sanitizeCommandOutput } from "../adapters/git.js";
import { installSkills, uninstallSkills } from "../adapters/install.js";
import { readPackageVersion } from "../adapters/package.js";
import { CLI_ERROR_CODES, SCHEMA_VERSION, skillHostSchema, treeSourceSchema } from "../contracts/index.js";
import { ContextTreeError } from "../errors.js";
import { cleanupLogs, cleanupStatus, removeCleanup, runCleanup, scheduleCleanup } from "../operations/cleanup.js";
import { connection, disconnect } from "../operations/connections.js";
import { connectTree, directorySource, initTree, resolveTrees } from "../operations/trees.js";
import { abortWrite, finishWrite, prepareWrite } from "../operations/write.js";
import { sourceSelector } from "../sources/identity.js";
import { projectRoot } from "../sources/project.js";
import { resolveSource } from "../sources/resolve.js";
import { readTree } from "../tree/read.js";
import { verifyTree } from "../tree/verify.js";
import { formatRead, formatVerify } from "./format.js";

type CliIo = { cwd: () => string; stdout: (text: string) => void; stderr?: (text: string) => void };
type Selection = { projectPath: string; tree?: string; json?: boolean };
const defaultIo: CliIo = {
  cwd: () => process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};
const MACHINE_COMMANDS = new Set(["sync", "prepare-write", "finish-write", "abort-write", "install", "uninstall"]);

export async function runContextTreeCli(argv: string[] = process.argv, io: CliIo = defaultIo): Promise<number> {
  let exitCode = 0;
  const emit = (value: unknown, json: boolean | undefined, text: string): void =>
    io.stdout(`${json ? JSON.stringify(value) : text}\n`);
  const project = (options: Selection): string => resolve(io.cwd(), options.projectPath);
  const select = (command: Command): Command =>
    command
      .option("--project-path <path>", "project directory", ".")
      .option("--tree <name-or-source>", "directory or repository name, or exact source selector");
  const json = (command: Command): Command => command.option("--json", "print the versioned JSON result");
  const program = new Command()
    .name("context-tree")
    .description("Structured context in directories and Git repositories.")
    .version(readPackageVersion())
    .exitOverride()
    .configureOutput({ writeErr: () => undefined, writeOut: io.stdout });

  json(
    program
      .command("init")
      .argument("[path]", "tree directory", "context")
      .option("--project-path <path>", "project directory", "."),
  )
    .description("Initialize tree content and a project connection; leave Git to the host.")
    .action((path: string, options: Selection) => {
      const result = initTree(project(options), resolve(io.cwd(), path));
      emit(
        { schemaVersion: SCHEMA_VERSION, ...result },
        options.json,
        `Initialized ${sourceSelector(result.connection.projectRoot, result.connection.source)}: ${result.treeRoot}\nCommit the files through your project's normal workflow.`,
      );
    });
  json(
    program
      .command("connect")
      .argument("[repository]", "GitHub OWNER/REPO; omit for a directory")
      .option("--project-path <path>", "project directory", ".")
      .option("--path <path>", "directory, or repository-relative subtree", ".")
      .option("--ref <branch>", "required target branch for a Git source"),
  )
    .description("Declare an existing directory or a managed Git source.")
    .action((repository: string | undefined, options: Selection & { path: string; ref?: string }) => {
      if (!repository && options.ref) throw new Error("--ref applies only to Git sources.");
      const root = projectRoot(project(options));
      const source = treeSourceSchema.parse(
        repository
          ? { kind: "git", repository, path: options.path, ref: options.ref }
          : directorySource(root, resolve(io.cwd(), options.path)),
      );
      const result = connectTree(root, source);
      emit(
        { schemaVersion: SCHEMA_VERSION, ...result },
        options.json,
        `Connected ${sourceSelector(result.connection.projectRoot, result.connection.source)}: ${result.treeRoot}`,
      );
    });
  json(select(program.command("disconnect")))
    .description("Remove one declaration; retain content and write sessions.")
    .action((options: Selection) => {
      disconnect(project(options), options.tree);
      emit({ schemaVersion: SCHEMA_VERSION, disconnected: true }, options.json, "Disconnected.");
    });
  for (const name of ["resolve", "sync"]) {
    const command = select(program.command(name));
    if (name === "resolve") json(command);
    command
      .description(
        name === "sync"
          ? "Fetch Git sources and open verified snapshots; directory sources stay in place."
          : "Resolve declared trees without network access.",
      )
      .action((options: Selection) => {
        const result = resolveTrees(project(options), options.tree, name === "sync");
        if (result.connections.some((entry) => !entry.ok)) exitCode = 1;
        emit(
          result,
          name === "sync" || options.json,
          result.connections
            .map(
              (entry) =>
                `${sourceSelector(entry.connection.projectRoot, entry.connection.source)}: ${entry.ok ? `${entry.treeRoot}${entry.dirty ? " (working changes)" : ""}` : entry.error.message}`,
            )
            .join("\n"),
        );
      });
  }
  for (const name of ["read", "verify"]) {
    const command = json(select(program.command(name))).option(
      "--tree-path <path>",
      "explicit content root instead of a connection",
    );
    if (name === "read") command.argument("[path]", "tree-relative node", ".");
    const action = (path: string, options: Selection & { treePath?: string }): void => {
      if (options.treePath && options.tree) throw new Error("Choose --tree or --tree-path.");
      const root = options.treePath
        ? resolve(io.cwd(), options.treePath)
        : resolveSource(connection(project(options), options.tree)).treeRoot;
      if (name === "read") {
        const result = readTree(root, path);
        emit(result, options.json, formatRead(result));
      } else {
        const result = verifyTree(root);
        if (!result.ok) exitCode = 1;
        emit(result, options.json, formatVerify(result));
      }
    };
    if (name === "read") command.action(action);
    else command.action((options: Selection & { treePath?: string }) => action(".", options));
  }
  select(program.command("prepare-write"))
    .option("--isolated", "prepare a review branch for a directory source")
    .description("Return an edit session and its exact tree root.")
    .action((options: Selection & { isolated?: boolean }) => {
      const result = prepareWrite(project(options), options.tree, options.isolated);
      emit(result, true, "");
    });
  program
    .command("finish-write")
    .argument("<session-id>")
    .option("--message <message>", "managed commit message", "Update Context Tree")
    .option("--publish", "push a managed Git session to its prepared target branch")
    .description("Validate workspace edits, or commit an isolated session; publishing is explicit.")
    .action((id: string, options: { message: string; publish?: boolean }) =>
      emit(finishWrite(id, options.message, options.publish), true, ""),
    );
  program
    .command("abort-write")
    .argument("<session-id>")
    .description("Release a session without discarding any edits.")
    .action((id: string) => {
      abortWrite(id);
      emit({ schemaVersion: SCHEMA_VERSION, released: true }, true, "");
    });
  for (const name of ["install", "uninstall"]) {
    program
      .command(name)
      .option("--host <host>", "claude, codex, pi, or all", "all")
      .option("--project <path>", "project skill destination")
      .action((options: { host: string; project?: string }) => {
        const request = {
          ...(options.host === "all" ? {} : { hosts: [skillHostSchema.parse(options.host)] }),
          ...(options.project ? { projectPath: resolve(io.cwd(), options.project) } : {}),
        };
        emit(name === "install" ? installSkills(request) : uninstallSkills(request), true, "");
      });
  }
  const cleanup = program.command("cleanup").description("Schedule editorial work through isolated write sessions.");
  for (const name of ["schedule", "status", "remove", "run", "logs"]) {
    const command = json(select(cleanup.command(name)));
    if (name === "schedule")
      command
        .requiredOption("--agent <agent>", "codex, claude, or pi")
        .option("--model <model>", "host model override")
        .option("--every <interval>", "e.g. 30m, 2h, 1d", "2h")
        .option("--publish", "authorize publication to the managed Git target on each run");
    if (name === "run") command.addOption(new Option("--schedule-id <id>").hideHelp());
    if (name === "logs") command.option("--list", "list runs").option("--run <id>", "run ID");
    command.action(
      async (
        options: Selection & {
          agent?: string;
          model?: string;
          every?: string;
          publish?: boolean;
          scheduleId?: string;
          list?: boolean;
          run?: string;
        },
      ) => {
        if (name === "run") {
          const result = await runCleanup(project(options), options.tree, options.scheduleId);
          if (["failed", "cancelled", "publication-uncertain"].includes(result.outcome)) exitCode = 1;
          emit(
            { schemaVersion: SCHEMA_VERSION, ...result },
            options.json,
            `Cleanup: ${result.outcome}${result.message ? ` — ${result.message}` : ""}${result.worktreePath ? `\nReview: ${result.worktreePath}` : ""}`,
          );
        } else if (name === "logs") {
          const result = cleanupLogs(project(options), options);
          emit(
            result,
            options.json,
            options.list
              ? result.runs.map((run) => `${run.runId}: ${run.terminal?.outcome ?? "running"}`).join("\n")
              : result.events.map((event) => `[${event.source}] ${event.text}`).join("\n"),
          );
        } else {
          const result =
            name === "schedule"
              ? scheduleCleanup({
                  projectPath: project(options),
                  agent: options.agent ?? "",
                  every: options.every ?? "2h",
                  publish: options.publish ?? false,
                  ...(options.tree ? { tree: options.tree } : {}),
                  ...(options.model ? { model: options.model } : {}),
                })
              : name === "remove"
                ? removeCleanup(project(options), options.tree)
                : cleanupStatus(project(options), options.tree);
          emit(
            result,
            options.json,
            result.schedule
              ? `${sourceSelector(result.schedule.projectPath, result.schedule.source)}: ${result.schedule.enabled ? "scheduled" : "disabled"}, every ${result.schedule.everyMinutes}m, ${result.schedule.publish ? "publish" : "review branch"}\nLatest: ${result.latest?.outcome ?? "none"}`
              : "No cleanup schedule.",
          );
        }
      },
    );
  }
  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const detail = {
      code: error instanceof ContextTreeError ? error.code : CLI_ERROR_CODES.failed,
      message: sanitizeCommandOutput(error instanceof Error ? error.message : "Operation failed."),
    };
    if (argv.includes("--json") || MACHINE_COMMANDS.has(argv[2] ?? ""))
      emit({ schemaVersion: SCHEMA_VERSION, ok: false, error: detail }, true, "");
    else (io.stderr ?? io.stdout)(`context-tree: ${detail.message}\n`);
    return 1;
  }
}
