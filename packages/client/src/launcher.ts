import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
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
  await saveManifest(dir, { executable: rel });
}

/**
 * Starts the game and resolves with how long it ran, for play tracking.
 * Windows .exe files on Linux run through wine when it is installed.
 * Aborting `stop` closes the game (play time limits), with everything it started on Windows.
 */
export function launchAndTrack(dir: string, rel: string, platform: NodeJS.Platform = process.platform, stop?: AbortSignal): Promise<number> {
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
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: path.dirname(full), stdio: "ignore", windowsHide: false });
    child.on("error", (err) =>
      reject(cmd === "wine" ? new Error("This is a Windows game; install Wine (or use Proton through Lutris/Heroic) to run it on Linux") : err),
    );
    child.on("exit", () => resolve(Math.round((Date.now() - started) / 1000)));
    stop?.addEventListener("abort", () => {
      if (child.exitCode !== null || !child.pid) return;
      if (platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
      else child.kill("SIGTERM");
    });
  });
}
