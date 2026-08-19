import { readFileSync } from "node:fs";

export function readUtf8File(path: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
}
