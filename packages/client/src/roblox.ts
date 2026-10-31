import { spawn } from "node:child_process";
import path from "node:path";
import { listProcesses, type RunningProcess } from "./launcher.js";

/**
 * The Roblox player's process: RobloxPlayerBeta.exe on Windows (and the Microsoft Store's
 * Windows10Universal.exe from a Roblox package), Sober on Linux.
 */
export function isRobloxPlayer(p: RunningProcess): boolean {
  return p.path.split("\0").some((x) => {
    const name = path.basename(x.replace(/\\/g, "/")).toLowerCase();
    return name === "robloxplayerbeta.exe" || name === "robloxplayerbeta" || name === "sober" || (name === "windows10universal.exe" && /roblox/i.test(x));
  });
}

export interface RobloxTrackOptions {
  /** How long to wait for the player to appear after the link opens, in ms (it may update itself first). */
  startTimeoutMs?: number;
  pollMs?: number;
  /** Aborting closes the player (play time used up with "close the game" on). */
  stop?: AbortSignal;
  /** Called once the player is running. */
  onStarted?: () => void;
  list?: () => Promise<RunningProcess[]>;
  kill?: (pid: number) => void;
  platform?: NodeJS.Platform;
}

/**
 * Follows a Roblox session started from a roblox:// link: waits for the player to start, then
 * resolves with how long it ran, in seconds (0 when it never started). Roblox runs one game at
 * a time, so the player running is the game running.
 */
export async function trackRoblox(opts: RobloxTrackOptions = {}): Promise<number> {
  const platform = opts.platform ?? process.platform;
  const list = opts.list ?? (() => listProcesses(platform));
  const pollMs = opts.pollMs ?? 5000;
  const kill =
    opts.kill ??
    ((pid: number) => {
      if (platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
      else {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
    });
  const sleep = () => new Promise((r) => setTimeout(r, pollMs));
  const players = async () => (await list().catch(() => [] as RunningProcess[])).filter(isRobloxPlayer).map((p) => p.pid);

  const deadline = Date.now() + (opts.startTimeoutMs ?? 120_000);
  while (!(await players()).length) {
    if (Date.now() >= deadline || opts.stop?.aborted) return 0;
    await sleep();
  }
  const started = Date.now();
  opts.onStarted?.();
  for (;;) {
    const left = await players();
    if (!left.length) return Math.round((Date.now() - started) / 1000);
    if (opts.stop?.aborted) left.forEach(kill);
    await sleep();
  }
}
