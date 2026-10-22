import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type CleanupSchedule, cleanupScheduleSchema } from "../contracts/index.js";
import { readState, stateDirectory } from "./state.js";

export function cleanupRoot(): string {
  return stateDirectory("cleanup");
}
export function statePath(id: string, name: string): string {
  if (!/^[a-f0-9]{64}$/u.test(id) || !/^[a-z-]+$/u.test(name)) throw new Error("Invalid cleanup state key.");
  return join(cleanupRoot(), `${id}.${name}`);
}
export function loadSchedule(id: string): CleanupSchedule {
  const config = cleanupScheduleSchema.parse(readState(statePath(id, "config")));
  if (config.id !== id) throw new Error("Cleanup identity is corrupt.");
  return config;
}
export function schedules(): CleanupSchedule[] {
  return readdirSync(cleanupRoot())
    .filter((name) => name.endsWith(".config"))
    .map((name) => loadSchedule(name.slice(0, -7)));
}
