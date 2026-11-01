import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
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

/**
 * Folders where the Roblox player keeps its settings (GlobalBasicSettings_<n>.xml): the Windows
 * player under %LOCALAPPDATA%\Roblox, Sober (Linux) in its Flatpak data.
 */
export function robloxSettingsDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "win32") return env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, "Roblox")] : [];
  const home = env.HOME;
  return home ? [path.posix.join(home, ".var/app/org.vinegarhq.Sober/data/sober/appData")] : [];
}

/** The settings with full screen switched on. Unchanged when it already is. */
export function withFullscreen(xml: string): string {
  const flag = /<bool\s+name="Fullscreen"\s*>\s*(true|false)\s*<\/bool>/i;
  const m = flag.exec(xml);
  if (m) return m[1]!.toLowerCase() === "true" ? xml : xml.replace(flag, '<bool name="Fullscreen">true</bool>');
  // Never switched yet: Roblox reads it from the game settings' Properties.
  const props = /<Properties>/i.exec(xml);
  return props ? `${xml.slice(0, props.index + props[0].length)}\n\t\t\t<bool name="Fullscreen">true</bool>${xml.slice(props.index + props[0].length)}` : xml;
}

/**
 * Sets the Roblox player to start in full screen, as if the player had pressed F11 last time.
 * Roblox reads this when it starts, so it's done before the roblox:// link opens. Settings files
 * that aren't there (Roblox never run on this PC) are left alone. Returns the files changed.
 */
export async function setRobloxFullscreen(dirs: string[] = robloxSettingsDirs()): Promise<string[]> {
  const changed: string[] = [];
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter((n) => /^GlobalBasicSettings_\d+\.xml$/i.test(n))) {
      const file = path.join(dir, name);
      const xml = await readFile(file, "utf8").catch(() => null);
      if (xml === null) continue;
      const next = withFullscreen(xml);
      if (next !== xml) {
        await writeFile(file, next, "utf8");
        changed.push(file);
      }
    }
  }
  return changed;
}
