import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { type ContextTreeWriteOperation, type ContextTreeWritePlan, contextTreeWritePlanSchema } from "../schemas.js";
import { classifyContextContent } from "./internal/content-class.js";
import { isPathInside, resolveTreeRoot } from "./path.js";
import { calculateTreeDigest, sha256 } from "./read.js";
import { type VerifyTreeReport, verifyTree } from "./verify.js";

export const WRITE_ERROR_CODES = {
  invalidPlan: "CONTEXT_TREE_WRITE_INVALID_PLAN",
  lockHeld: "CONTEXT_TREE_WRITE_LOCK_HELD",
  pathUnsafe: "CONTEXT_TREE_WRITE_PATH_UNSAFE",
  staleTree: "CONTEXT_TREE_WRITE_STALE_TREE",
  staleFile: "CONTEXT_TREE_WRITE_STALE_FILE",
  prospectiveInvalid: "CONTEXT_TREE_WRITE_PROSPECTIVE_INVALID",
  applyFailed: "CONTEXT_TREE_WRITE_APPLY_FAILED",
} as const;

export type WriteErrorCode = (typeof WRITE_ERROR_CODES)[keyof typeof WRITE_ERROR_CODES];

export class ContextTreeWriteError extends Error {
  constructor(
    public readonly code: WriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContextTreeWriteError";
  }
}

export type ApplyWritePlanOptions = {
  dryRun?: boolean;
};

export type ApplyWritePlanResult = {
  afterTreeDigest: string;
  beforeTreeDigest: string;
  dryRun: boolean;
  operations: Array<{ op: ContextTreeWriteOperation["op"]; path: string }>;
  root: string;
  schemaVersion: 1;
  verification: VerifyTreeReport;
};

type OriginalFile = {
  content: Buffer | null;
  mode: number | null;
  path: string;
};

function acquireLock(root: string): { close: () => void } {
  const path = join(root, ".context-tree-write.lock");
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch {
    throw new ContextTreeWriteError(
      WRITE_ERROR_CODES.lockHeld,
      "Another Context Tree write is active, or a stale .context-tree-write.lock must be inspected.",
    );
  }
  return {
    close: () => {
      closeSync(descriptor);
      rmSync(path, { force: true });
    },
  };
}

function assertSafeTarget(root: string, relativePath: string): string {
  if (classifyContextContent(relativePath) === "repo-infra") {
    throw new ContextTreeWriteError(
      WRITE_ERROR_CODES.pathUnsafe,
      `Write plans cannot modify repository infrastructure: ${relativePath}`,
    );
  }
  const target = resolve(root, relativePath);
  if (!isPathInside(root, target)) {
    throw new ContextTreeWriteError(WRITE_ERROR_CODES.pathUnsafe, `Write target escapes the tree: ${relativePath}`);
  }
  let current = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    const entry = lstatSync(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ContextTreeWriteError(
        WRITE_ERROR_CODES.pathUnsafe,
        `Write target has an unsafe parent: ${relativePath}`,
      );
    }
  }
  if (existsSync(target)) {
    const entry = lstatSync(target);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new ContextTreeWriteError(
        WRITE_ERROR_CODES.pathUnsafe,
        `Write target must be a regular file: ${relativePath}`,
      );
    }
  }
  return target;
}

function validateOperationState(root: string, operation: ContextTreeWriteOperation): void {
  const target = assertSafeTarget(root, operation.path);
  if (operation.op === "create") {
    if (existsSync(target)) {
      throw new ContextTreeWriteError(WRITE_ERROR_CODES.staleFile, `Create target already exists: ${operation.path}`);
    }
    return;
  }
  if (!existsSync(target)) {
    throw new ContextTreeWriteError(WRITE_ERROR_CODES.staleFile, `Write target is missing: ${operation.path}`);
  }
  const digest = sha256(readFileSync(target));
  if (digest !== operation.expectedSha256) {
    throw new ContextTreeWriteError(
      WRITE_ERROR_CODES.staleFile,
      `Write target changed since the plan was created: ${operation.path}`,
    );
  }
}

function applyOperation(root: string, operation: ContextTreeWriteOperation): void {
  const target = assertSafeTarget(root, operation.path);
  if (operation.op === "delete") {
    unlinkSync(target);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${operation.path.split("/").at(-1)}.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temporary, operation.content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function shadowTree(root: string): string {
  const parent = mkdtempSync(join(tmpdir(), "context-tree-write-"));
  const shadow = join(parent, "tree");
  cpSync(root, shadow, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const path = relative(root, source);
      if (path === "") return true;
      const first = path.split(/[\\/]/u)[0];
      return first !== ".git" && first !== "node_modules" && first !== ".context-tree-write.lock";
    },
  });
  return shadow;
}

function originalFiles(root: string, operations: ContextTreeWriteOperation[]): OriginalFile[] {
  return operations.map((operation) => {
    const path = assertSafeTarget(root, operation.path);
    if (!existsSync(path)) return { content: null, mode: null, path };
    const entry = lstatSync(path);
    return { content: readFileSync(path), mode: entry.mode, path };
  });
}

function rollback(files: OriginalFile[]): void {
  for (const file of [...files].reverse()) {
    if (file.content === null) {
      rmSync(file.path, { force: true });
      continue;
    }
    mkdirSync(dirname(file.path), { recursive: true });
    const temporary = `${file.path}.rollback-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, file.content, { flag: "wx", mode: file.mode ?? 0o644 });
    renameSync(temporary, file.path);
  }
}

export function applyWritePlan(
  treePath: string,
  input: ContextTreeWritePlan | unknown,
  options: ApplyWritePlanOptions = {},
): ApplyWritePlanResult {
  const parsed = contextTreeWritePlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new ContextTreeWriteError(WRITE_ERROR_CODES.invalidPlan, parsed.error.message);
  }
  const plan = parsed.data;
  const root = resolveTreeRoot(treePath);
  const lock = acquireLock(root);
  let shadow: string | null = null;

  try {
    const beforeTreeDigest = calculateTreeDigest(root);
    if (beforeTreeDigest !== plan.expectedTreeDigest) {
      throw new ContextTreeWriteError(
        WRITE_ERROR_CODES.staleTree,
        "The Context Tree changed since the write plan was created.",
      );
    }
    for (const operation of plan.operations) validateOperationState(root, operation);

    shadow = shadowTree(root);
    for (const operation of plan.operations) applyOperation(shadow, operation);
    const prospectiveVerification = verifyTree(shadow);
    if (!prospectiveVerification.ok) {
      throw new ContextTreeWriteError(
        WRITE_ERROR_CODES.prospectiveInvalid,
        `The proposed write would leave an invalid Context Tree: ${prospectiveVerification.findings
          .map((finding) => finding.code)
          .join(", ")}`,
      );
    }
    const afterTreeDigest = calculateTreeDigest(shadow);

    if (!options.dryRun) {
      const originals = originalFiles(root, plan.operations);
      try {
        for (const operation of plan.operations) applyOperation(root, operation);
      } catch (error) {
        try {
          rollback(originals);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Context Tree write and rollback both failed.");
        }
        throw error;
      }
      const liveVerification = verifyTree(root);
      if (!liveVerification.ok || calculateTreeDigest(root) !== afterTreeDigest) {
        rollback(originals);
        throw new ContextTreeWriteError(
          WRITE_ERROR_CODES.applyFailed,
          "The applied Context Tree did not match the verified prospective result; changes were rolled back.",
        );
      }
    }

    return {
      afterTreeDigest,
      beforeTreeDigest,
      dryRun: options.dryRun === true,
      operations: plan.operations.map(({ op, path }) => ({ op, path })),
      root,
      schemaVersion: 1,
      verification: prospectiveVerification,
    };
  } catch (error) {
    if (error instanceof ContextTreeWriteError) throw error;
    throw new ContextTreeWriteError(
      WRITE_ERROR_CODES.applyFailed,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (shadow) rmSync(dirname(shadow), { recursive: true, force: true });
    lock.close();
  }
}
