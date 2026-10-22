import type { ContextTreeCliErrorCode } from "./contracts/index.js";

/**
 * A failure the CLI reports with a specific machine-readable code. Anything
 * thrown as a plain Error is reported as CONTEXT_TREE_FAILED instead.
 */
export class ContextTreeError extends Error {
  public readonly code: ContextTreeCliErrorCode;

  public constructor(code: ContextTreeCliErrorCode, message: string) {
    super(message);
    this.name = "ContextTreeError";
    this.code = code;
  }
}
