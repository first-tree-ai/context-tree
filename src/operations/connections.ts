import { join } from "node:path";
import type { CommandRunner } from "../adapters/git.js";
import { atomicFile, readState, withLock } from "../adapters/state.js";
import {
  CLI_ERROR_CODES,
  type Connection,
  type ProjectConfig,
  projectConfigSchema,
  SCHEMA_VERSION,
  type TreeSource,
  treeSourceSchema,
} from "../contracts/index.js";
import { ContextTreeError } from "../errors.js";
import { selectSource, sourceIdentity } from "../sources/identity.js";
import { CONFIG_FILE, projectRoot } from "../sources/project.js";

function load(root: string): ProjectConfig {
  const raw = readState(join(root, CONFIG_FILE));
  const config = projectConfigSchema.safeParse(raw === undefined ? { schemaVersion: SCHEMA_VERSION, trees: [] } : raw);
  if (!config.success)
    throw new ContextTreeError(
      CLI_ERROR_CODES.corruptConnection,
      `Invalid ${CONFIG_FILE}; expected schemaVersion ${SCHEMA_VERSION} and a trees array of sources.`,
    );
  const identities = config.data.trees.map((source) => sourceIdentity(root, source));
  if (new Set(identities).size !== identities.length)
    throw new ContextTreeError(CLI_ERROR_CODES.corruptConnection, "Duplicate Context Tree source.");
  return config.data;
}
function save(root: string, config: ProjectConfig): void {
  atomicFile(join(root, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, 0o644);
}
export function connections(path: string, selector?: string, runner?: CommandRunner): Connection[] {
  const root = projectRoot(path, runner);
  const entries = load(root).trees.map((source) => ({ projectRoot: root, source }));
  const selected =
    selector === undefined ? entries : [selectSource(root, entries, selector)].filter((entry) => entry !== undefined);
  if (!selected.length)
    throw new ContextTreeError(CLI_ERROR_CODES.noConnection, "No matching Context Tree. Use init or connect.");
  return selected;
}
export function connection(path: string, selector?: string, runner?: CommandRunner): Connection {
  const entries = connections(path, selector, runner);
  const result = selectSource(projectRoot(path, runner), entries);
  if (!result) throw new ContextTreeError(CLI_ERROR_CODES.noConnection, "No Context Tree.");
  return result;
}
export function connect(path: string, source: TreeSource, runner?: CommandRunner): Connection {
  const root = projectRoot(path, runner);
  const parsed = treeSourceSchema.parse(source);
  return withLock(join(root, `${CONFIG_FILE}.lock`), () => {
    const config = load(root);
    if (!config.trees.some((entry) => sourceIdentity(root, entry) === sourceIdentity(root, parsed))) {
      config.trees.push(parsed);
      save(root, config);
    }
    return { projectRoot: root, source: parsed };
  });
}
export function disconnect(path: string, selector: string | undefined, runner?: CommandRunner): void {
  const root = projectRoot(path, runner);
  withLock(join(root, `${CONFIG_FILE}.lock`), () => {
    const selected = connection(root, selector, runner);
    const config = load(root);
    config.trees = config.trees.filter(
      (source) => sourceIdentity(root, source) !== sourceIdentity(root, selected.source),
    );
    save(root, config);
  });
}
