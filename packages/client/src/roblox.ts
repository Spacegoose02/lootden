import { spawn } from "node:child_process";
import { open, readdir, readFile, stat, writeFile } from "node:fs/promises";
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
  /** How long to wait for a game to start after the link opens, in ms (the player may update itself first). */
  startTimeoutMs?: number;
  /** How long out of a game, with Roblox still open (its home screen, or the tray), ends the session. */
  leaveGraceMs?: number;
  pollMs?: number;
  /** Aborting closes the player (play time used up with "close the game" on). */
  stop?: AbortSignal;
  /** Called once a game is running. */
  onStarted?: () => void;
  list?: () => Promise<RunningProcess[]>;
  kill?: (pid: number) => void;
  platform?: NodeJS.Platform;
  /** Whether a game is open right now; null when it can't be told (then the player running counts). Defaults to reading Roblox's logs. */
  inGame?: () => Promise<boolean | null>;
}

/**
 * Follows a Roblox session started from a roblox:// link and resolves with the seconds spent
 * in a game. Roblox keeps running after a game closes (its home screen, or the tray icon), so
 * the player running isn't enough: Roblox's own log says when a game is joined and left. Time
 * only counts while a game is open, and the session ends when the player closes or a game was
 * left and none joined again for a while. 0 when no game ever started.
 */
export async function trackRoblox(opts: RobloxTrackOptions = {}): Promise<number> {
  const platform = opts.platform ?? process.platform;
  const list = opts.list ?? (() => listProcesses(platform));
  const pollMs = opts.pollMs ?? 5000;
  const startTimeoutMs = opts.startTimeoutMs ?? 180_000;
  const leaveGraceMs = opts.leaveGraceMs ?? 45_000;
  const watcher = opts.inGame ? null : new RobloxLogWatcher(robloxLogDirs(platform), Date.now());
  const inGame = opts.inGame ?? (() => watcher!.poll());
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

  const began = Date.now();
  let seconds = 0;
  let last = began;
  let started = false;
  let outSince: number | null = null;
  for (;;) {
    const pids = await players();
    const state = pids.length ? await inGame().catch(() => null) : false;
    const at = Date.now();
    // Unknown (no log to read): the player running is the game running.
    const playing = pids.length > 0 && state !== false;
    if (playing && started) seconds += (at - last) / 1000;
    last = at;
    if (playing && !started) {
      started = true;
      opts.onStarted?.();
    }
    if (playing) outSince = null;
    else if (started) {
      outSince ??= at;
      // Closed, or back on Roblox's home screen (or in the tray) for a while: the game's over.
      if (!pids.length || at - outSince >= leaveGraceMs) return Math.round(seconds);
    } else if (at - began >= startTimeoutMs || opts.stop?.aborted) return 0;
    if (opts.stop?.aborted) pids.forEach(kill);
    await sleep();
  }
}

/** Where the Roblox player writes its logs: %LOCALAPPDATA%\Roblox\logs on Windows, Sober's on Linux. */
export function robloxLogDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  return robloxSettingsDirs(platform, env).map((d) => (platform === "win32" ? path.win32.join(d, "logs") : path.posix.join(d, "logs")));
}

/** Log lines for joining a game (the same ones Bloxstrap and other Roblox tools watch for). */
const JOINED = /\[FLog::Output\] ! Joining game|\[FLog::Network\] serverId:/;
/** Log lines for leaving one (back to the app's home screen, a disconnect, or closing). */
const LEFT = /\[FLog::Network\] Time to disconnect replication data|\[FLog::SingleSurfaceApp\] leaveUGCGameInternal|\[FLog::Network\] Client:Disconnect/;

/**
 * Reads the Roblox player's newest log as it grows and says whether a game is open. Null when
 * there's no log folder at all (Roblox somewhere LootDen doesn't know), so the caller can fall
 * back to the player running.
 */
export class RobloxLogWatcher {
  private file: string | null = null;
  private offset = 0;
  private rest = "";
  private state = false;

  constructor(
    private readonly dirs: string[],
    /** Only logs written since about then belong to this session. */
    private readonly since: number,
  ) {}

  async poll(): Promise<boolean | null> {
    let found = false;
    let newest: { file: string; mtime: number; size: number } | null = null;
    for (const dir of this.dirs) {
      const names = await readdir(dir).catch(() => null);
      if (!names) continue;
      found = true;
      for (const name of names.filter((n) => /\.log$/i.test(n))) {
        const file = path.join(dir, name);
        const st = await stat(file).catch(() => null);
        if (st && st.mtimeMs >= this.since - 60_000 && (!newest || st.mtimeMs > newest.mtime)) newest = { file, mtime: st.mtimeMs, size: st.size };
      }
    }
    if (!found) return null;
    if (!newest) return this.state;
    if (newest.file !== this.file || newest.size < this.offset) {
      // A new player (or a new log): start from what it has written, but not megabytes of it.
      this.file = newest.file;
      this.offset = Math.max(0, newest.size - 2 * 1024 * 1024);
      this.rest = "";
      this.state = false;
    }
    if (newest.size > this.offset) {
      const fh = await open(newest.file, "r").catch(() => null);
      if (fh) {
        try {
          const length = Math.min(newest.size - this.offset, 4 * 1024 * 1024);
          const buf = Buffer.alloc(length);
          const { bytesRead } = await fh.read(buf, 0, length, this.offset);
          this.offset += bytesRead;
          const lines = (this.rest + buf.toString("utf8", 0, bytesRead)).split(/\r?\n/);
          this.rest = lines.pop() ?? "";
          for (const line of lines) {
            if (JOINED.test(line)) this.state = true;
            else if (LEFT.test(line)) this.state = false;
          }
        } finally {
          await fh.close();
        }
      }
    }
    return this.state;
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
