import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type runAgent, runReviewBatch } from "../adapters/agent.js";
import { statePath } from "../adapters/cleanup-state.js";
import type { CleanupHistory } from "../adapters/history.js";
import {
  parseReviewReceipt,
  REVIEW_BATCH_TIMEOUT_MS,
  type ReviewBatch,
  type ReviewFragment,
  type ReviewResult,
  reviewBatches,
  reviewFragments,
  reviewHash,
  reviewProgressSchema,
  reviewRelations,
} from "../adapters/review-batches.js";
import { atomicFile, atomicState, readState } from "../adapters/state.js";
import type { CleanupSchedule } from "../contracts/index.js";

const completionSchema = z
  .object({ status: z.enum(["incomplete", "complete", "structural"]), summary: z.string().trim().min(1).max(8_000) })
  .strict();

// Allow time for the final editor before the native scheduler's 30-minute limit.
const READING_WINDOW_MS = 12 * 60 * 1000;

export type EditorialPhase = "routine" | "structural";

export async function runEditorialReview(options: {
  run: typeof runAgent;
  config: CleanupSchedule;
  root: string;
  prompt: string;
  phase: EditorialPhase;
  signal: AbortSignal;
  history: CleanupHistory;
}): Promise<"complete" | "structural"> {
  const { run, config, root, prompt, phase, signal, history } = options;
  const path = join(root, `.context-tree-review-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ status: "incomplete", summary: "Review has not completed." }), {
    mode: 0o600,
    flag: "wx",
  });
  const signalForStructural =
    phase === "routine"
      ? "If this tidy identifies a structural review trigger, leave the tree untouched and set status to structural with the concrete signal in summary."
      : "The host has accepted all reading and relation checkpoints. Leave unresolved choices unchanged and report them in summary.";
  await run(
    config,
    root,
    [
      prompt,
      `This is the ${phase} editing phase.`,
      signalForStructural,
      "Host completion record: " +
        JSON.stringify(path) +
        ". Update only status and summary. Set status to complete only after reviewing the requested scope, checking the diff and references, and stating the changes or no-op. Preserve this record for host verification.",
    ].join("\n\n"),
    signal,
    undefined,
    (source, message) => history.event(source, message),
  );

  let completion: z.infer<typeof completionSchema>;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 65_536) throw new Error("Invalid completion record.");
      completion = completionSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error("Cleanup review is incomplete: missing or invalid completion record; worktree preserved.");
  }
  if (completion.status === "incomplete" || (phase === "structural" && completion.status === "structural"))
    throw new Error("Cleanup review is incomplete: editing and validation were not acknowledged; worktree preserved.");
  history.event("runner", `${phase} review ${completion.status}: ${completion.summary}`);
  unlinkSync(path);
  return completion.status;
}

export async function reviewStructure(options: {
  config: CleanupSchedule;
  root: string;
  digest: string;
  editorial: string;
  signal: AbortSignal;
  checkPristine: () => void;
  history: CleanupHistory;
  runBatch?: typeof runReviewBatch | undefined;
}): Promise<{ findings: string } | undefined> {
  const { config, root, digest, editorial, signal, checkPristine, history } = options;
  const deadline = Date.now() + READING_WINDOW_MS;
  const path = statePath(config.id, "structural-progress");
  const snapshot = reviewHash(JSON.stringify([1, digest, editorial, config.agent, config.agentPath, config.model]));
  const stored = readState(path);
  const parsed = stored === undefined ? undefined : reviewProgressSchema.parse(stored);
  const progress = parsed?.snapshot === snapshot ? parsed : { snapshot, reading: [], relations: [] };
  atomicState(path, progress);
  const accept = async (batch: ReviewBatch, index: number): Promise<ReviewResult | undefined> => {
    const previous = progress[batch.kind][index];
    if (previous) {
      if (previous.id !== batch.id) throw new Error("Structural review checkpoint does not match the input.");
      return previous;
    }
    if (Date.now() + REVIEW_BATCH_TIMEOUT_MS > deadline) return undefined;
    checkPristine();
    const response = await (options.runBatch ?? runReviewBatch)(config, root, editorial, batch, signal);
    const result = parseReviewReceipt(batch, response);
    checkPristine();
    progress[batch.kind].push(result);
    atomicState(path, progress);
    history.event("runner", `Structural review ${batch.kind} batch ${index + 1} checkpointed.`);
    return result;
  };
  const fragments: { items: ReviewFragment[]; topics: ReviewResult["topics"] }[] = [];
  for (const batch of reviewBatches(reviewFragments(root), "reading")) {
    const result = await accept(batch, fragments.length);
    if (!result) return undefined;
    fragments.push({ items: batch.items, topics: result.topics });
  }
  let relations = 0;
  for (const batch of reviewBatches(reviewRelations(fragments), "relations")) {
    if (!(await accept(batch, relations))) return undefined;
    relations++;
  }
  if (fragments.length !== progress.reading.length || relations !== progress.relations.length)
    throw new Error("Structural review checkpoint contains items outside the current input.");
  checkPristine();
  const findings = statePath(config.id, "structural-findings");
  const notes = (phase: ReviewBatch["kind"]): string[] =>
    progress[phase].flatMap(({ notes }, index) => (notes ? [JSON.stringify({ phase, batch: index + 1, notes })] : []));
  atomicFile(findings, `${[...notes("reading"), ...notes("relations")].join("\n")}\n`);
  history.event(
    "runner",
    `Structural coverage complete: ${fragments.length} reading and ${relations} relation batches.`,
  );
  return { findings };
}
