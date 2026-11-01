import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  fillRecompPath,
  parseRecompManifest,
  pickRecompAsset,
  pickRomFile,
  platformFor,
  recompInfo,
  recompRomProblem,
  recompRunner,
  RECOMPS,
  sha256FromDigest,
  toZ64,
  type RecompArch,
  type RecompInfo,
  type RecompManifest,
  type SaveBackup,
} from "@lootden/shared";
import type { GameServerClient } from "./api.js";
import { download, findFile, listFiles, readTools, writeTools, zipFiles, type ToolsOptions } from "./emulators.js";
import { extractArchive } from "./extractor.js";

export { RECOMPS, recompInfo, recompsFor } from "@lootden/shared";

type OS = "win32" | "linux";
type Fetch = typeof fetch;
const hostOs = (): OS => (process.platform === "win32" ? "win32" : "linux");
const hostArch = (): RecompArch => (process.arch === "arm64" ? "arm64" : "x64");
const GITHUB = { "User-Agent": "LootDen", Accept: "application/vnd.github+json" };

/** Each recomp gets its own folder in the tools folder and runs portable from it, saves included. */
export const recompDir = (toolsDir: string, id: string) => path.join(toolsDir, "recomps", id);

export interface RecompRelease {
  version: string;
  url: string;
  fileName: string;
  /** GitHub's SHA-256 of the file, checked after downloading. Null for files uploaded before GitHub kept one. */
  sha256: string | null;
}

/** The newest full release (not a pre-release) with a file for this PC, from the developer's own GitHub. */
export async function latestRecompRelease(fetchImpl: Fetch, repo: string, platform: OS, arch: RecompArch = hostArch()): Promise<RecompRelease> {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=15`, { headers: GITHUB });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}`);
  const releases = (await res.json()) as Array<{ tag_name: string; prerelease: boolean; draft: boolean; assets: Array<{ name: string; browser_download_url: string; digest?: string | null }> }>;
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
    const name = pickRecompAsset(r.assets.map((a) => a.name), platform, arch);
    const asset = name ? r.assets.find((a) => a.name === name) : undefined;
    if (asset) return { version: r.tag_name, url: asset.browser_download_url, fileName: asset.name, sha256: sha256FromDigest(asset.digest) };
  }
  throw new Error(`No download for this computer in ${repo}'s releases`);
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The recomp's program: one its recomplauncher.json names, else one of LootDen's known names. */
async function findProgram(dir: string, info: RecompInfo, manifest: RecompManifest | null, platform: OS): Promise<string | null> {
  for (const rel of manifest?.programs ?? []) {
    const full = path.join(dir, ...rel.split(/[\\/]/));
    if (await stat(full).then((s) => s.isFile(), () => false)) return full;
  }
  for (const name of info.programs) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = platform === "win32" ? new RegExp(`^${esc}\\.exe$`, "i") : new RegExp(`^${esc}(\\.x86_64|[-_.].*\\.AppImage)?$|^${esc}\\.AppImage$`, "i");
    const hit = await findFile(dir, pattern);
    if (hit) return hit;
  }
  return null;
}

/** recomplauncher.json from the release, when the developer ships one. */
export async function readRecompManifest(dir: string): Promise<RecompManifest | null> {
  const file = await findFile(dir, /^recomplauncher\.json$/i);
  if (!file) return null;
  try {
    return parseRecompManifest(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return null;
  }
}

/** When a release unpacks into one folder ("Zelda64Recompiled-v1.2.2/"), the folder inside it. */
async function unwrap(dir: string): Promise<string> {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith("__MACOSX"));
  return entries.length === 1 && entries[0]!.isDirectory() ? unwrap(path.join(dir, entries[0]!.name)) : dir;
}

/**
 * Downloads (or updates) a recomp from its developer's GitHub releases into the tools folder.
 * The file is checked against GitHub's SHA-256 before anything is unpacked. An update unpacks over
 * the old folder, so saves, settings and mods the recomp keeps there stay.
 */
export async function installRecomp(id: string, opts: ToolsOptions & { arch?: RecompArch }): Promise<{ version: string; exe: string; updated: boolean }> {
  const info = recompInfo(id);
  if (!info) throw new Error(`Unknown recomp ${id}`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const platform = opts.platform ?? hostOs();
  const emit = opts.onEvent ?? (() => {});
  emit({ message: `Finding the latest ${info.name}` });
  const release = await latestRecompRelease(fetchImpl, info.repo, platform, opts.arch ?? hostArch());

  const dir = recompDir(opts.toolsDir, id);
  const before = (await readTools(opts.toolsDir)).recomps[id];
  if (before?.version === release.version && (await stat(path.join(opts.toolsDir, before.exe)).then(() => true, () => false))) {
    emit({ message: `${info.name} ${release.version} is up to date` });
    return { version: release.version, exe: path.join(opts.toolsDir, before.exe), updated: false };
  }

  await mkdir(dir, { recursive: true });
  const tmp = await mkdtemp(path.join(opts.toolsDir, `.get-${id}-`));
  try {
    const file = path.join(tmp, release.fileName);
    await download(fetchImpl, release.url, file, (received, total) => emit({ message: `Downloading ${info.name} ${release.version}`, received, total }), opts.signal);
    if (release.sha256) {
      emit({ message: `Checking ${release.fileName}` });
      if ((await sha256File(file)) !== release.sha256) throw new Error(`${release.fileName} doesn't match the checksum GitHub has for it, so it wasn't installed. Try again.`);
    }
    if (/\.AppImage$/i.test(file)) {
      for (const old of await readdir(dir)) if (/\.AppImage$/i.test(old)) await rm(path.join(dir, old), { force: true });
      await rename(file, path.join(dir, release.fileName));
    } else {
      emit({ message: `Unpacking ${info.name}` });
      const staging = path.join(tmp, "unpacked");
      await extractArchive(opts.sevenZip, /\.zip$/i.test(file) ? "zip" : "7z", file, staging);
      await cp(await unwrap(staging), dir, { recursive: true, force: true });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const exe = await findProgram(dir, info, await readRecompManifest(dir), platform);
  if (!exe) throw new Error(`${info.name} downloaded, but its program wasn't in the download`);
  if (platform !== "win32") await chmod(exe, 0o755);
  // N64ModernRuntime recomps keep settings, saves and the ROM beside the program when this is in the folder they start in.
  await writeFile(path.join(path.dirname(exe), "portable.txt"), "");
  const tools = await readTools(opts.toolsDir);
  tools.recomps[id] = { version: release.version, exe: path.relative(opts.toolsDir, exe), installedAt: new Date().toISOString(), sha256: release.sha256 };
  await writeTools(opts.toolsDir, tools);
  emit({ message: `${info.name} ${release.version} is ready` });
  return { version: release.version, exe, updated: true };
}

/** Takes a recomp off this PC. Its saves folder stays, so setting it up again carries on where it was. */
export async function removeRecomp(id: string, toolsDir: string): Promise<{ keptSaves: boolean }> {
  const tools = await readTools(toolsDir);
  const state = tools.recomps[id];
  const dir = recompDir(toolsDir, id);
  const exeDir = state ? path.dirname(path.join(toolsDir, state.exe)) : dir;
  let keptSaves = false;
  const saves = path.join(exeDir, "saves");
  const hasSaves = await stat(saves).then((s) => s.isDirectory(), () => false);
  if (hasSaves) {
    const keep = path.join(toolsDir, "recomps", `.${id}-saves`);
    await rm(keep, { recursive: true, force: true });
    await rename(saves, keep);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await rename(keep, path.join(dir, "saves"));
    keptSaves = true;
  } else {
    await rm(dir, { recursive: true, force: true });
  }
  delete tools.recomps[id];
  await writeTools(toolsDir, tools);
  return { keptSaves };
}

/** Every recomp LootDen knows, with what's set up on this PC, for the Emulation page. */
export async function recompOverview(toolsDir: string) {
  const tools = await readTools(toolsDir);
  return RECOMPS.map((r) => ({ id: r.id, installed: tools.recomps[r.id] ? { version: tools.recomps[r.id]!.version, installedAt: tools.recomps[r.id]!.installedAt } : null }));
}

// ---- Playing ---------------------------------------------------------------------

export interface RecompPlan {
  recomp: RecompInfo;
  exe: string;
  args: string[];
  /** Added to the environment the recomp starts with. */
  env: Record<string, string>;
  /** The library ROM handed over. */
  rom: string;
  /** The recomp's portable folder: saves, settings and the stored ROM. */
  dataDir: string;
  /** Folders (relative to dataDir) whose changes are this game's saves. */
  saveDirs: string[];
}

const ARCHIVE = /\.(zip|7z)$/i;
const N64_ROM = /\.(z64|n64|v64)$/i;

/** The ROM file from the installed library game, unpacking a zipped one into scratch space. */
async function romBytes(gameDir: string, info: RecompInfo, opts: ToolsOptions): Promise<{ file: string; bytes: Uint8Array }> {
  const platform = platformFor(info.platform);
  const files = await listFiles(gameDir);
  const rel = pickRomFile(files, platform);
  if (!rel) throw new Error(`No ${platform.short} game file found in ${gameDir}`);
  const file = path.join(gameDir, ...rel.split("/"));
  if (!ARCHIVE.test(file)) return { file, bytes: await readFile(file) };
  const tmp = await mkdtemp(path.join(os.tmpdir(), "lootden-rom-"));
  try {
    await extractArchive(opts.sevenZip, /\.zip$/i.test(file) ? "zip" : "7z", file, tmp);
    const inner = await findFile(tmp, N64_ROM);
    if (!inner) throw new Error(`${path.basename(file)} has no N64 ROM in it`);
    return { file, bytes: await readFile(inner) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Works out how to start a library game with a recomp, and puts the game's ROM where the recomp looks for it. */
export async function planRecomp(gameDir: string, recompId: string, opts: ToolsOptions): Promise<RecompPlan> {
  const info = recompInfo(recompId);
  if (!info) throw new Error(`Unknown recomp ${recompId}`);
  const platform = opts.platform ?? hostOs();
  const state = (await readTools(opts.toolsDir)).recomps[recompId];
  if (!state) throw new Error(`Set up ${info.name} first (Emulation, then Recomps)`);
  const dir = recompDir(opts.toolsDir, recompId);
  const manifest = await readRecompManifest(dir);
  const exe = (manifest?.programs.length ? await findProgram(dir, info, manifest, platform) : null) ?? path.join(opts.toolsDir, state.exe);
  if (!(await stat(exe).then(() => true, () => false))) throw new Error(`${info.name}'s program is missing. Set it up again (Emulation, then Recomps).`);
  const dataDir = path.dirname(exe);

  const { file: rom, bytes } = await romBytes(gameDir, info, opts);
  const problem = recompRomProblem(info, bytes);
  if (problem) throw new Error(problem);
  if (info.rom) {
    // The recomp checks the ROM's hash itself and asks for another if it isn't the one it was made from.
    const stored = path.join(dataDir, `${info.rom.romId}.z64`);
    const z64 = Buffer.from(toZ64(bytes));
    const have = await readFile(stored).catch(() => null);
    if (!have || !have.equals(z64)) await writeFile(stored, z64);
  }
  await writeFile(path.join(dataDir, "portable.txt"), "").catch(() => {});

  const home = os.homedir();
  const vars: Record<string, string> = {
    install: dataDir,
    game: rom,
    home,
    documents: path.join(home, "Documents"),
    local: platform === "win32" ? (process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")) : (process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share")),
    config: platform === "win32" ? (process.env.APPDATA ?? path.join(home, "AppData", "Roaming")) : (process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")),
    pad: "xbox",
  };
  const env: Record<string, string> = { LOOTDEN: "1" };
  for (const [k, v] of Object.entries(manifest?.env ?? {})) env[k] = fillRecompPath(v, vars);
  // Saves the manifest names inside the recomp's own folder are backed up too.
  const extra = (manifest?.saves ?? [])
    .map((s) => path.relative(dataDir, fillRecompPath(s, vars)))
    .filter((r) => r && !r.startsWith("..") && !path.isAbsolute(r))
    .map((r) => r.split(path.sep).join("/"));
  return {
    recomp: info,
    exe,
    rom,
    dataDir,
    env,
    args: (manifest?.args ?? []).map((a) => fillRecompPath(a, vars)),
    saveDirs: [...new Set(["saves", ...extra])],
  };
}

const restoredKey = (gameId: string, recompId: string) => `${gameId}#${recompRunner(recompId)}`;

async function snapshot(plan: RecompPlan): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const sub of plan.saveDirs) {
    const s = await stat(path.join(plan.dataDir, sub)).catch(() => null);
    const rels = s?.isFile() ? [sub] : await listFiles(plan.dataDir, sub);
    for (const rel of rels) {
      const st = await stat(path.join(plan.dataDir, rel)).catch(() => null);
      if (st) out.set(rel, st.mtimeMs);
    }
  }
  return out;
}

/**
 * Before playing: brings in the newest backup this recomp made on another PC. Files are only
 * written when the backup is newer than what's here, so local progress is never rolled back.
 */
export async function restoreRecompSaves(api: GameServerClient, gameId: string, plan: RecompPlan, opts: ToolsOptions & { device: string }): Promise<SaveBackup | null> {
  const runner = recompRunner(plan.recomp.id);
  const latest = (await api.listSaves(gameId)).find((s) => s.runner === runner);
  const tools = await readTools(opts.toolsDir);
  const key = restoredKey(gameId, plan.recomp.id);
  if (!latest || tools.restored[key] === latest.id || latest.device === opts.device) return null;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "lootden-recompsave-"));
  try {
    const zip = path.join(tmp, "save.zip");
    await writeFile(zip, await api.downloadSave(gameId, latest.id));
    const out = path.join(tmp, "files");
    await extractArchive(opts.sevenZip, "zip", zip, out);
    const when = new Date(latest.createdAt);
    for (const rel of await listFiles(out)) {
      if (rel.split("/").includes("..")) continue;
      const dest = path.join(plan.dataDir, ...rel.split("/"));
      const local = await stat(dest).catch(() => null);
      if (local && local.mtime >= when) continue;
      await mkdir(path.dirname(dest), { recursive: true });
      await cp(path.join(out, ...rel.split("/")), dest);
      await utimes(dest, when, when);
    }
    tools.restored[key] = latest.id;
    await writeTools(opts.toolsDir, tools);
    return latest;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export interface RecompSession {
  seconds: number;
  backup: SaveBackup | null;
  restored: SaveBackup | null;
}

/**
 * Plays a library game with a recomp: puts the ROM in place, brings in newer saves, runs it, then
 * uploads the save files that changed as this player's backup (marked as the recomp's).
 */
export async function playRecomp(
  api: GameServerClient,
  gameId: string,
  gameDir: string,
  recompId: string,
  opts: ToolsOptions & { device: string; onStarted?: (plan: RecompPlan) => void },
): Promise<RecompSession> {
  const plan = await planRecomp(gameDir, recompId, opts);
  const restored = await restoreRecompSaves(api, gameId, plan, opts).catch(() => null);
  const before = await snapshot(plan);
  const started = Date.now();
  opts.onStarted?.(plan);
  await new Promise<void>((resolve, reject) => {
    // Started from its own folder: that's where portable.txt makes it keep everything.
    const child = spawn(plan.exe, plan.args, { cwd: plan.dataDir, env: { ...process.env, ...plan.env }, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", () => resolve());
  });
  const seconds = Math.round((Date.now() - started) / 1000);

  const after = await snapshot(plan);
  const changed = [...after].filter(([rel, t]) => before.get(rel) !== t).map(([rel]) => rel);
  let backup: SaveBackup | null = null;
  if (changed.length && (await api.health().then(() => true, () => false))) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "lootden-recompsave-"));
    try {
      const zip = path.join(tmp, "save.zip");
      await zipFiles(opts.sevenZip, plan.dataDir, changed, zip);
      backup = await api.uploadSave(gameId, await readFile(zip), opts.device, recompRunner(recompId));
      const tools = await readTools(opts.toolsDir);
      tools.restored[restoredKey(gameId, recompId)] = backup.id;
      await writeTools(opts.toolsDir, tools);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  return { seconds, backup, restored };
}
