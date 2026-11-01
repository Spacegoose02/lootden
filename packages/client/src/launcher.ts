import { spawn } from "node:child_process";
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { saveManifest } from "./installed.js";

/** Installers, redistributables and tools that are never the game itself. */
const NOT_THE_GAME =
  /^(unins\d*|setup|install(er)?|vc_?redist.*|vcredist.*|dxsetup|dxwebsetup|directx.*|dotnet.*|ue4prereq.*|uepre.*|crashreport.*|crashhandler.*|unitycrashhandler.*|errorreporter|easyanticheat.*|cleanup|config(uration)?|settings|7z.*|unrar|quicksfv|.*_?be|steam_?api.*)$/i;

interface Candidate {
  rel: string;
  depth: number;
  size: number;
}

async function collect(root: string, exts: RegExp, rel = "", depth = 0, out: Candidate[] = []): Promise<Candidate[]> {
  if (depth > 3) return out;
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (!/^(_?redist|_commonredist|directx|support|__installer|.*prereq.*|\.lootden.*)$/i.test(e.name)) await collect(root, exts, r, depth + 1, out);
    } else if (exts.test(e.name) && !NOT_THE_GAME.test(e.name.replace(/\.[^.]+$/, ""))) {
      out.push({ rel: r, depth, size: (await stat(path.join(root, r))).size });
    }
  }
  return out;
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

/**
 * Guesses the game's main executable: prefer names that share words with the
 * title, then shallow paths, then bigger files.
 */
export async function findExecutable(dir: string, title: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const exts = platform === "win32" ? /\.exe$/i : /(\.sh|\.x86_64|\.x86|\.AppImage|\.exe)$/i;
  const found = await collect(dir, exts);
  if (!found.length) return null;
  const titleWords = new Set(words(title));
  const score = (c: Candidate) => {
    const name = words(path.basename(c.rel).replace(/\.[^.]+$/, ""));
    const overlap = name.filter((w) => titleWords.has(w)).length;
    const native = platform !== "win32" && !/\.exe$/i.test(c.rel) ? 5 : 0;
    return overlap * 10 + native - c.depth * 3 + Math.log10(c.size + 1);
  };
  found.sort((a, b) => score(b) - score(a));
  return found[0]!.rel;
}

/** Remembers the chosen executable in the install manifest. */
export async function saveExecutable(dir: string, rel: string): Promise<void> {
  // A different exe gets a fresh stamp the next time games are listed.
  await saveManifest(dir, { executable: rel, exeStamp: null });
}

/** A running process: its id and where it was started from (executable path or command line). */
export interface RunningProcess {
  pid: number;
  path: string;
}

/** Every process this user can see, with its executable path. Empty when they can't be listed. */
export async function listProcesses(platform: NodeJS.Platform = process.platform): Promise<RunningProcess[]> {
  if (platform === "win32") {
    return new Promise((resolve) => {
      const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Process | ForEach-Object { \"$($_.Id)`t$($_.Path)\" }"], { windowsHide: true });
      let out = "";
      ps.stdout.on("data", (d: Buffer) => (out += d.toString()));
      ps.on("error", () => resolve([]));
      ps.on("close", () =>
        resolve(
          out
            .split(/\r?\n/)
            .map((l) => l.split("\t"))
            .filter(([id, p]) => id && p)
            .map(([id, p]) => ({ pid: Number(id), path: p!.trim() })),
        ),
      );
    });
  }
  const ids = await readdir("/proc").catch(() => [] as string[]);
  const out: RunningProcess[] = [];
  for (const id of ids.filter((x) => /^\d+$/.test(x))) {
    const exe = await readlink(`/proc/${id}/exe`).catch(() => "");
    const cmdline = await readFile(`/proc/${id}/cmdline`, "utf8").catch(() => "");
    const where = [exe, ...cmdline.split("\0")].filter(Boolean).join("\0");
    if (where) out.push({ pid: Number(id), path: where });
  }
  return out;
}

/** The processes running from inside any of these folders. */
export function processesIn(all: RunningProcess[], dirs: string[], platform: NodeJS.Platform = process.platform): number[] {
  const norm = (p: string) => (platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p);
  const roots = dirs.map((d) => norm(path.resolve(d)).replace(/[\\/]+$/, "") + (platform === "win32" ? "\\" : "/"));
  return all.filter((p) => p.pid !== process.pid && p.path.split("\0").some((x) => roots.some((r) => norm(x).startsWith(r)))).map((p) => p.pid);
}

export interface LaunchOptions {
  /** Folders whose processes count as the game still running (a launcher that starts the game and exits). */
  watchDirs?: string[];
  /** How often to look for them, in ms. */
  pollMs?: number;
  /** Lists running processes (tests). */
  list?: () => Promise<RunningProcess[]>;
  /** Closes processes by id (tests). */
  kill?: (pid: number) => void;
}

/**
 * Starts the game and resolves with how long it ran, for play tracking.
 * Windows .exe files on Linux run through wine when it is installed.
 * Games that start through a launcher keep counting while anything from the game's folder runs.
 * Aborting `stop` closes the game (play time limits), with everything it started on Windows.
 */
export function launchAndTrack(dir: string, rel: string, platform: NodeJS.Platform = process.platform, stop?: AbortSignal, opts: LaunchOptions = {}): Promise<number> {
  // Absolute when the installer put the game somewhere else.
  const full = path.resolve(dir, rel);
  let cmd = full;
  let args: string[] = [];
  if (platform !== "win32" && /\.exe$/i.test(rel)) {
    cmd = "wine";
    args = [full];
  } else if (platform !== "win32" && /\.sh$/i.test(rel)) {
    cmd = "sh";
    args = [full];
  }
  const watchDirs = [...new Set([dir, path.dirname(full), ...(opts.watchDirs ?? [])])];
  const list = opts.list ?? (() => listProcesses(platform));
  const killPid =
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
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: path.dirname(full), stdio: "ignore", windowsHide: false });
    let failed = false;
    child.on("error", (err) => {
      failed = true;
      reject(cmd === "wine" ? new Error("This is a Windows game; install Wine (or use Proton through Lutris/Heroic) to run it on Linux") : err);
    });
    const done = () => resolve(Math.round((Date.now() - started) / 1000));
    // The started process is gone; the game may still be running from its folder (launchers).
    const follow = async () => {
      while (!failed) {
        const left = processesIn(await list().catch(() => []), watchDirs, platform);
        if (!left.length) return done();
        if (stop?.aborted) left.forEach(killPid);
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 5000));
      }
    };
    child.on("exit", () => void follow());
    stop?.addEventListener("abort", () => {
      if (child.exitCode === null && child.pid) killPid(child.pid);
    });
  });
}
