import { lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CleanupSchedule } from "../../schemas.js";
import { type CommandRunner, defaultRunner } from "../internal/git.js";
import { atomicFile, privateDirectory } from "./store.js";

export type NativeStatus = { registered: boolean; running: boolean };
export interface CleanupScheduler {
  status(config: CleanupSchedule): NativeStatus;
  install(config: CleanupSchedule): void;
  remove(config: CleanupSchedule): void;
}
function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("Unsupported control character in scheduler argument.");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function unitQuote(value: string): string {
  if (/[\n\r\0]/u.test(value)) throw new Error("Unsupported control character in scheduler argument.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;
}
export function nativeScheduler(
  platform: string = process.platform,
  home: string = homedir(),
  runner: CommandRunner = defaultRunner,
): CleanupScheduler {
  if (platform !== "darwin" && platform !== "linux")
    throw new Error("Cleanup schedules require macOS LaunchAgents or Linux systemd user services.");
  const label = (config: CleanupSchedule): string => `ai.context-tree.cleanup.${config.id}`;
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const command = (args: string[], allowMissing = false): string => {
    const result = runner(
      platform === "darwin" ? "launchctl" : "systemctl",
      platform === "darwin" ? args : ["--user", ...args],
    );
    if (
      result.status !== 0 &&
      !(
        allowMissing &&
        /could not find service|not loaded|not found|does not exist/i.test(result.stderr + result.stdout)
      )
    ) {
      throw new Error("Native cleanup scheduler operation failed; inspect your user scheduler.");
    }
    return result.status === 0 ? result.stdout : "";
  };
  const directory = (): string =>
    privateDirectory(
      platform === "darwin" ? join(home, "Library", "LaunchAgents") : join(home, ".config", "systemd", "user"),
    );
  const launcherDirectory = (config: CleanupSchedule): string => {
    if (!/^[a-f0-9]{64}$/u.test(config.id)) throw new Error("Invalid cleanup state key.");
    return privateDirectory(join(home, ".context-tree", "cleanup", "launchers", config.id));
  };
  const status = (config: CleanupSchedule): NativeStatus => {
    if (platform === "darwin") {
      const output = command(["print", `${domain}/${label(config)}`], true);
      return { registered: output.length > 0, running: /state = running|pid = \d+/u.test(output) };
    }
    const timer = command(["show", `${label(config)}.timer`, "--property=LoadState,ActiveState"], true);
    const service = command(["show", `${label(config)}.service`, "--property=ActiveState"], true);
    return {
      registered: /ActiveState=active/u.test(timer),
      running: /ActiveState=(active|activating|deactivating)/u.test(service),
    };
  };
  return {
    status,
    install(config): void {
      const args = [
        config.nodePath,
        config.cliPath,
        "cleanup",
        "run",
        "--schedule-id",
        config.id,
        "--project-path",
        config.projectPath,
        "--json",
      ];
      const name = label(config);
      if (platform === "darwin") {
        const file = join(directory(), `${name}.plist`);
        const launcher = join(launcherDirectory(config), "context-tree-cleanup");
        atomicFile(launcher, `#!/bin/sh\nexec ${args.map(shellQuote).join(" ")}\n`, 0o700);
        if (status(config).registered) command(["bootout", `${domain}/${name}`]);
        atomicFile(
          file,
          `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array><string>${xml(launcher)}</string></array><key>StartInterval</key><integer>${config.everyMinutes * 60}</integer><key>RunAtLoad</key><false/><key>AbandonProcessGroup</key><false/><key>WorkingDirectory</key><string>${xml(config.projectPath)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(config.searchPath)}</string></dict></dict></plist>`,
        );
        command(["bootstrap", domain, file]);
      } else {
        atomicFile(
          join(directory(), `${name}.service`),
          `[Unit]\nDescription=Context Tree cleanup\n[Service]\nType=oneshot\nExecStart=${args.map(unitQuote).join(" ")}\nEnvironment=${unitQuote(`PATH=${config.searchPath}`)}\nKillMode=control-group\nTimeoutStopSec=10\nTimeoutStartSec=30min\n`,
        );
        atomicFile(
          join(directory(), `${name}.timer`),
          `[Unit]\nDescription=Context Tree cleanup timer\n[Timer]\nOnActiveSec=${config.everyMinutes}min\nOnUnitInactiveSec=${config.everyMinutes}min\nUnit=${name}.service\n[Install]\nWantedBy=timers.target\n`,
        );
        command(["daemon-reload"]);
        command(["enable", `${name}.timer`]);
        command(["restart", `${name}.timer`]);
      }
    },
    remove(config): void {
      const name = label(config);
      if (platform === "darwin") {
        command(["bootout", `${domain}/${name}`], true);
        const launcherDir = launcherDirectory(config);
        const launcher = join(launcherDir, "context-tree-cleanup");
        const entry = lstatSync(launcher, { throwIfNoEntry: false });
        if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error("Unsafe cleanup file.");
        rmSync(join(directory(), `${name}.plist`), { force: true });
        rmSync(launcher, { force: true });
        if (readdirSync(launcherDir).length === 0) rmdirSync(launcherDir);
      } else {
        command(["disable", "--now", `${name}.timer`], true);
        command(["stop", `${name}.service`], true);
        for (const suffix of ["timer", "service"]) rmSync(join(directory(), `${name}.${suffix}`), { force: true });
        command(["daemon-reload"]);
      }
    },
  };
}
