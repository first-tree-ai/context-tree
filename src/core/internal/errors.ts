import type { CLI_ERROR_CODES } from "../../schemas.js";

export type ContextTreeErrorCode = (typeof CLI_ERROR_CODES)[keyof typeof CLI_ERROR_CODES];

/**
 * A failure the CLI reports with a specific machine-readable code. Anything
 * thrown as a plain Error is reported as CONTEXT_TREE_FAILED instead.
 */
export class ContextTreeError extends Error {
  public readonly code: ContextTreeErrorCode;

  public constructor(code: ContextTreeErrorCode, message: string) {
    super(message);
    this.name = "ContextTreeError";
    this.code = code;
  }
}
