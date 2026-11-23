import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";
import { collectContextMarkdownContent } from "../tree/content-class.js";
import { parseMarkdownFrontmatter, readNonEmptyStringArrayField } from "../tree/document.js";
import { readMarkdownLinkTargets } from "../tree/links.js";

const MAX_INPUT_BYTES = 60_000;
const MAX_PART_BYTES = 4_000;
const MAX_PARTS = 24;
export const REVIEW_RECEIPT_BYTES = 16_384;
export const REVIEW_BATCH_TIMEOUT_MS = 3 * 60 * 1000;

const batchId = z.string().regex(/^[a-f0-9]{64}$/u);
const topic = z.object({ part: z.number().int().positive(), key: z.string().trim().min(2).max(120) }).strict();
const reviewResult = z
  .object({
    id: batchId,
    notes: z.string().trim().max(8_000),
    topics: z.array(topic).max(48),
  })
  .strict();
const receipt = reviewResult.extend({ reviewed: z.array(z.number().int().positive()).max(MAX_PARTS) }).strict();
export const reviewProgressSchema = z
  .object({
    snapshot: batchId,
    reading: z.array(reviewResult),
    relations: z.array(reviewResult),
  })
  .strict();

export type ReviewResult = z.infer<typeof reviewResult>;
export type ReviewFragment = { path: string; start: number; end: number; text: string };
export type ReviewBatch = { id: string; payload: string; parts: number; kind: "reading" | "relations" };

export function reviewHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function* reviewFragments(root: string): Generator<ReviewFragment> {
  const content = collectContextMarkdownContent(root);
  if (content.symlinks.length) throw new Error("Cleanup review cannot traverse symlinks.");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const file of content.files) {
    if (file.contentClass === "repo-infra") continue;
    const fd = openSync(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Cleanup review requires regular Markdown files.");
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    let start = 0;
    do {
      let end = Math.min(start + MAX_PART_BYTES, bytes.length);
      if (end < bytes.length) {
        while (((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
        const newline = bytes.lastIndexOf(0x0a, end - 1) + 1;
        if (newline > start + MAX_PART_BYTES / 2) end = newline;
      }
      yield { path: file.relativePath, start, end, text: decoder.decode(bytes.subarray(start, end)) };
      start = end;
    } while (start < bytes.length);
  }
}

/** Bound the serialized prompt payload, including escaping and paths. */
export function* reviewBatches<T extends object>(
  input: Iterable<T>,
  kind: ReviewBatch["kind"],
): Generator<ReviewBatch & { items: T[] }> {
  let items: T[] = [];
  let entries: string[] = [];
  let size = 2;
  const flush = (): ReviewBatch & { items: T[] } => {
    const payload = `[${entries.join(",")}]`;
    const batch = { id: reviewHash(`${kind}:${payload}`), payload, parts: items.length, kind, items };
    items = [];
    entries = [];
    size = 2;
    return batch;
  };
  for (const item of input) {
    let entry = JSON.stringify({ id: items.length + 1, ...item });
    if (items.length && (items.length === MAX_PARTS || size + 1 + Buffer.byteLength(entry) > MAX_INPUT_BYTES)) {
      yield flush();
      entry = JSON.stringify({ id: 1, ...item });
    }
    size += Number(items.length > 0) + Buffer.byteLength(entry);
    if (size > MAX_INPUT_BYTES) throw new Error("Structural review item exceeds the input limit.");
    items.push(item);
    entries.push(entry);
  }
  if (items.length) yield flush();
}

export function parseReviewReceipt(batch: ReviewBatch, output: string): ReviewResult {
  try {
    const { reviewed, ...result } = receipt.parse(JSON.parse(output));
    if (
      result.id === batch.id &&
      reviewed.length === batch.parts &&
      reviewed.every((id, i) => id === i + 1) &&
      result.topics.every(({ part }) => batch.kind === "reading" && part <= batch.parts)
    )
      return result;
  } catch {
    // Model output may contain private source content.
  }
  throw new Error("Structural review is incomplete: expected a receipt for every supplied item.");
}

function topicKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function linkedPath(source: string, target: string, soft: boolean): { path: string; anchor: string } | undefined {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\\)/iu.test(target)) return undefined;
  try {
    const [raw = "", rawAnchor = ""] = target.split("#", 2);
    const clean = decodeURIComponent(raw.split("?", 1)[0] ?? "");
    const path = clean
      ? posix.normalize(
          soft || clean.startsWith("/") ? clean.replace(/^\/+/, "") : posix.join(posix.dirname(source), clean),
        )
      : source;
    return { path, anchor: topicKey(decodeURIComponent(rawAnchor)) };
  } catch {
    return undefined;
  }
}

type Relation = { left: ReviewFragment; right: ReviewFragment; reason: string };

/** Yield only cross-batch candidates. Supply both original fragments for each comparison. */
export function* reviewRelations(
  batches: { items: ReviewFragment[]; topics: ReviewResult["topics"] }[],
): Generator<Relation> {
  type Part = { fragment: ReviewFragment; batch: number; ordinal: number };
  const byPath = new Map<string, Part[]>();
  const byTopic = new Map<string, Part[]>();
  let ordinal = 0;
  const add = (index: Map<string, Part[]>, key: string, part: Part): void => {
    const entries = index.get(key) ?? [];
    if (!entries.includes(part)) entries.push(part);
    index.set(key, entries);
  };
  for (const [batch, { items, topics }] of batches.entries()) {
    const parts = items.map((fragment) => ({ fragment, batch, ordinal: ++ordinal }));
    for (const part of parts) {
      add(byPath, part.fragment.path, part);
      for (const line of part.fragment.text.split("\n")) {
        if (!/^#{1,6}\s/u.test(line)) continue;
        const key = topicKey(line);
        if (key.includes(" ")) add(byTopic, key, part);
      }
    }
    for (const { part, key } of topics) {
      const entry = parts[part - 1];
      const normalized = topicKey(key);
      if (entry && normalized.length >= 2) add(byTopic, normalized, entry);
    }
  }

  const seen = new Set<string>();
  function* pair(left: Part | undefined, right: Part | undefined, reason: string): Generator<Relation> {
    if (!left || !right || left.batch === right.batch) return;
    const key = [left.ordinal, right.ordinal].sort((a, b) => a - b).join(":");
    if (seen.has(key)) return;
    seen.add(key);
    yield { left: left.fragment, right: right.fragment, reason };
  }

  for (const [path, parts] of byPath) {
    for (const [index, part] of parts.entries()) yield* pair(parts[index - 1], part, "adjacent parts of the same file");
    const { data, body } = parseMarkdownFrontmatter(parts.map(({ fragment }) => fragment.text).join(""));
    const related = readNonEmptyStringArrayField(data ?? {}, "soft_links");
    for (const [links, soft] of [
      [readMarkdownLinkTargets(body), false],
      [related.valid ? related.value : [], true],
    ] as const) {
      for (const link of links) {
        const target = linkedPath(path, link, soft);
        if (!target) continue;
        const targetParts = byPath.get(target.path) ?? byPath.get(posix.join(target.path, "NODE.md"));
        const destination = target.anchor
          ? targetParts?.find(({ fragment }) =>
              fragment.text.split("\n").some((line) => /^#{1,6}\s/u.test(line) && topicKey(line) === target.anchor),
            )
          : undefined;
        const source = parts.find(({ fragment }) => fragment.text.includes(link)) ?? parts[0];
        yield* pair(source, destination ?? targetParts?.[0], "explicit tree link");
      }
    }
  }
  for (const parts of byTopic.values()) {
    for (const [index, left] of parts.entries()) {
      for (let next = index + 1; next < parts.length; next++) yield* pair(left, parts[next], "shared topic");
    }
  }
}
