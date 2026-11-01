import { spawn, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { splitArgs, type LaunchAction, type LaunchStep } from "@lootden/shared";
import { listProcesses, processesIn, type RunningProcess } from "./launcher.js";

/** Starts a process; tests pass a fake. Resolves with its exit code once it closes (null when killed). */
export type Spawner = (cmd: string, args: string[], opts: SpawnOptions) => { pid?: number; exited: Promise<number | null> };

export interface StepContext {
  /** The game's folder: relative paths and `{game}` point here. */
  gameDir: string;
  platform?: NodeJS.Platform;
  spawn?: Spawner;
  sleep?: (ms: number) => Promise<void>;
  /** Stops between steps (the person cancelled, or play time ran out). */
  signal?: AbortSignal;
  /** Each step as it starts, for the game page. */
  onStep?: (step: LaunchStep, index: number) => void;
}

const realSpawn: Spawner = (cmd, args, opts) => {
  const child = spawn(cmd, args, opts);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  // Nobody may wait on it; a failed start is reported by the caller that does.
  exited.catch(() => {});
  if (opts.detached) child.unref();
  return { pid: child.pid, exited };
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A link such as steam://rungameid/271590 rather than a file. */
export const isLaunchUrl = (p: string) => /^[a-z][a-z0-9+.-]{1,30}:\/\//i.test(p) && !/^file:/i.test(p);

/** Where a step's program is: `{game}` filled in, relative paths inside the game's folder. */
export function stepTarget(p: string, gameDir: string): string {
  const filled = p.replace(/\{game\}/gi, gameDir);
  if (isLaunchUrl(filled)) return filled;
  return path.isAbsolute(filled) || /^[a-z]:[\\/]/i.test(filled) ? filled : path.resolve(gameDir, filled);
}

/** How to start a file on this system: scripts through their shell, Windows programs through Wine elsewhere. */
export function commandFor(target: string, args: string[], platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (isLaunchUrl(target)) {
    return platform === "win32" ? { cmd: "cmd.exe", args: ["/d", "/c", "start", '""', target] } : { cmd: platform === "darwin" ? "open" : "xdg-open", args: [target] };
  }
  const ext = path.extname(target).toLowerCase();
  if (platform === "win32") {
    if (ext === ".bat" || ext === ".cmd") return { cmd: "cmd.exe", args: ["/d", "/c", target, ...args] };
    if (ext === ".ps1") return { cmd: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", target, ...args] };
    if (ext === ".exe" || ext === ".com") return { cmd: target, args };
    // Shortcuts, .url files and anything else open the way Explorer would.
    return { cmd: "cmd.exe", args: ["/d", "/c", "start", '""', target, ...args] };
  }
  if (ext === ".exe" || ext === ".bat") return { cmd: "wine", args: [target, ...args] };
  if (ext === ".sh") return { cmd: "sh", args: [target, ...args] };
  return { cmd: target, args };
}

/** Folders that never count as "the game is still running" (Windows itself, shells). */
const SYSTEM_DIR = /^([a-z]:\\windows\\|\/(usr\/)?s?bin\/|\/usr\/lib\/)/i;

/** Closes every process with this file name. */
function closeByName(name: string, platform: NodeJS.Platform, run: Spawner): Promise<unknown> {
  const c = platform === "win32" ? { cmd: "taskkill", args: ["/IM", name, "/T", "/F"] } : { cmd: "pkill", args: ["-x", name] };
  return run(c.cmd, c.args, { stdio: "ignore", windowsHide: true }).exited.catch(() => null);
}

/**
 * Runs steps in order: starts programs (waiting for ones marked so), waits, closes programs.
 * Resolves with the folders the started programs live in, so play tracking can follow them.
 */
export async function runLaunchSteps(steps: LaunchStep[], ctx: StepContext): Promise<string[]> {
  const platform = ctx.platform ?? process.platform;
  const run = ctx.spawn ?? realSpawn;
  const sleep = ctx.sleep ?? realSleep;
  const dirs: string[] = [];
  for (const [i, step] of steps.entries()) {
    if (ctx.signal?.aborted) throw new Error("Cancelled");
    ctx.onStep?.(step, i);
    if (step.type === "wait") {
      await sleep(step.seconds * 1000);
      continue;
    }
    if (step.type === "close") {
      await closeByName(step.name, platform, run);
      continue;
    }
    const target = stepTarget(step.path, ctx.gameDir);
    const { cmd, args } = commandFor(target, splitArgs(step.args ?? ""), platform);
    const url = isLaunchUrl(target);
    const cwd = step.cwd ? stepTarget(step.cwd, ctx.gameDir) : url ? ctx.gameDir : path.dirname(target);
    const child = run(cmd, args, { cwd, stdio: "ignore", windowsHide: !!step.hidden, detached: !step.waitForExit && platform !== "win32" });
    if (!url) {
      const dir = path.dirname(target);
      if (!SYSTEM_DIR.test(dir.endsWith(path.sep) ? dir : dir + path.sep)) dirs.push(dir);
    }
    if (step.waitForExit) {
      await child.exited.catch((err: Error) => {
        throw new Error(`Couldn't start ${path.basename(target)}: ${err.message}`);
      });
    } else {
      // A program that can't start at all fails within a moment; one that runs keeps running.
      const failed = await Promise.race([child.exited.then(() => null, (err: Error) => err), sleep(300).then(() => null)]);
      if (failed) throw new Error(`Couldn't start ${path.basename(target)}: ${failed.message}`);
    }
  }
  return [...new Set(dirs)];
}

export interface ActionTrackOptions extends StepContext {
  /** More folders whose processes count as the game (another store's install folder). */
  watchDirs?: string[];
  pollMs?: number;
  /** How long to wait for the game to show up after the steps, for launchers that take a while. */
  graceMs?: number;
  list?: () => Promise<RunningProcess[]>;
  kill?: (pid: number) => void;
  now?: () => number;
}

/**
 * Starts the game with one of its launch actions and resolves with how many seconds it ran.
 * The game counts as running while anything runs from its folder, the started programs' folders
 * or `watchDirs`. Aborting the signal closes all of it (play time limits).
 */
export async function launchActionAndTrack(action: LaunchAction, opts: ActionTrackOptions): Promise<number> {
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const started = now();
  const dirs = await runLaunchSteps(action.steps, opts);
  const watch = [...new Set([opts.gameDir, ...dirs, ...(opts.watchDirs ?? [])])];
  const list = opts.list ?? (() => listProcesses(platform));
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
  const stepsDone = now();
  let seen = false;
  for (;;) {
    const left = processesIn(await list().catch(() => []), watch, platform);
    if (left.length) {
      seen = true;
      if (opts.signal?.aborted) left.forEach(kill);
    } else if (seen || now() - stepsDone >= (opts.graceMs ?? 60_000) || opts.signal?.aborted) {
      break;
    }
    await sleep(opts.pollMs ?? 5000);
  }
  return Math.round((now() - started) / 1000);
}

/**
 * Pauses (or resumes) processes, so a game can be suspended from the controller and picked up
 * later. Windows uses NtSuspendProcess; Linux and macOS send SIGSTOP / SIGCONT.
 */
export function suspendProcesses(pids: number[], resume: boolean, platform: NodeJS.Platform = process.platform, run: Spawner = realSpawn): Promise<unknown> {
  if (!pids.length) return Promise.resolve();
  if (platform !== "win32") {
    for (const pid of pids) {
      try {
        process.kill(pid, resume ? "SIGCONT" : "SIGSTOP");
      } catch {
        // Gone already.
      }
    }
    return Promise.resolve();
  }
  const fn = resume ? "NtResumeProcess" : "NtSuspendProcess";
  const script = [
    `Add-Type -Name P -Namespace L -MemberDefinition '[DllImport("ntdll.dll")] public static extern int ${fn}(System.IntPtr h); [DllImport("kernel32.dll")] public static extern System.IntPtr OpenProcess(int a, bool i, int p); [DllImport("kernel32.dll")] public static extern bool CloseHandle(System.IntPtr h);'`,
    `foreach ($id in @(${pids.map((p) => Math.trunc(p)).join(",")})) { $h = [L.P]::OpenProcess(0x0800, $false, $id); if ($h -ne [System.IntPtr]::Zero) { [void][L.P]::${fn}($h); [void][L.P]::CloseHandle($h) } }`,
  ].join("; ");
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true }).exited.catch(() => null);
}
