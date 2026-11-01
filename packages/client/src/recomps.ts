import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  currentChoice,
  fillRecompPath,
  parseRecompManifest,
  pickRecompAsset,
  pickRomFile,
  platformFor,
  prepareProgress,
  readConfigKeys,
  recompInfo,
  recompRomProblem,
  recompRunner,
  RECOMPS,
  settingApplies,
  sha256FromDigest,
  toZ64,
  writeConfigKeys,
  type RecompArch,
  type RecompConfigFile,
  type RecompInfo,
  type RecompManifest,
  type SaveBackup,
} from "@lootden/shared";
import type { GameServerClient } from "./api.js";
import { download, findFile, listFiles, readTools, writeTools, zipFiles, type ToolsOptions } from "./emulators.js";
import { extractArchive } from "./extractor.js";
import { checkGameCopy } from "./discs.js";
import { findExecutable } from "./launcher.js";

export { RECOMPS, recompInfo, recompsFor } from "@lootden/shared";

type OS = "win32" | "linux";
type Fetch = typeof fetch;
const hostOs = (): OS => (process.platform === "win32" ? "win32" : "linux");
const hostArch = (): RecompArch => (process.arch === "arm64" ? "arm64" : "x64");
const GITHUB = { "User-Agent": "LootDen", Accept: "application/vnd.github+json" };

/** Tools options, plus the recomps an admin added on the server (LootDen's own are always known). */
export type RecompOptions = ToolsOptions & {
  added?: RecompInfo[];
  /** The LootDen server: recomps download through it (fetched from GitHub once for the whole house), else straight from GitHub. */
  api?: GameServerClient;
};

/** A recomp by id: LootDen's own, one the server lists, or one set up here before (so it plays offline). */
async function resolveInfo(id: string, opts: { toolsDir: string; added?: RecompInfo[] }): Promise<RecompInfo> {
  const info = recompInfo(id, opts.added ?? []) ?? (await readTools(opts.toolsDir)).recomps[id]?.info;
  if (!info) throw new Error(`Unknown recomp ${id}`);
  return info;
}

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
  // An admin-added recomp without a recomplauncher.json: the program that looks most like it.
  if (!info.programs.length && !manifest?.programs.length) {
    const rel = await findExecutable(dir, `${info.name} ${info.repo.split("/")[1]}`, platform);
    if (rel) return path.join(dir, rel);
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
export async function installRecomp(id: string, opts: RecompOptions & { arch?: RecompArch }): Promise<{ version: string; exe: string; updated: boolean }> {
  const info = await resolveInfo(id, opts);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const platform = opts.platform ?? hostOs();
  const emit = opts.onEvent ?? (() => {});
  emit({ message: `Finding the latest ${info.name}` });
  const arch = opts.arch ?? hostArch();
  let release: RecompRelease | null = null;
  let getter: Fetch = fetchImpl;
  let from = "GitHub";
  if (opts.api) {
    const api = opts.api;
    try {
      const r = await api.json<{ version: string; fileName: string; sha256: string | null; cached: boolean; download: string }>(`/api/recomps/${encodeURIComponent(id)}/release?os=${platform}&arch=${arch}`);
      release = { version: r.version, fileName: r.fileName, sha256: r.sha256, url: api.urlFor(r.download) };
      getter = ((url: string | URL | Request, init: RequestInit = {}) => fetch(url, { ...init, headers: api.headers((init.headers ?? {}) as Record<string, string>) })) as Fetch;
      from = r.cached ? "your LootDen server" : "GitHub, through your LootDen server";
    } catch {
      // An older server, or it can't reach GitHub: go to GitHub from here.
    }
  }
  release ??= await latestRecompRelease(fetchImpl, info.repo, platform, arch);

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
    await download(getter, release.url, file, (received, total) => emit({ message: `Downloading ${info.name} ${release!.version} from ${from}`, received, total }), opts.signal);
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
  tools.recomps[id] = {
    ...tools.recomps[id],
    version: release.version,
    exe: path.relative(opts.toolsDir, exe),
    installedAt: new Date().toISOString(),
    sha256: release.sha256,
    ...(info.custom ? { info } : {}),
  };
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
export async function recompOverview(toolsDir: string, added: RecompInfo[] = []) {
  const tools = await readTools(toolsDir);
  return [...RECOMPS, ...added].map((r) => ({ id: r.id, installed: tools.recomps[r.id] ? { version: tools.recomps[r.id]!.version, installedAt: tools.recomps[r.id]!.installedAt } : null }));
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
  /** Messages for the recomp's exit codes, from its recomplauncher.json. */
  exitCodes: Record<string, string>;
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

/** The game file from the installed library game: the ROM, disc image or folder the recomp is handed. */
async function gameFile(gameDir: string, info: RecompInfo): Promise<string> {
  const platform = platformFor(info.platform);
  const rel = pickRomFile(await listFiles(gameDir), platform);
  return rel ? path.join(gameDir, ...rel.split("/")) : gameDir;
}

/** The places {install}, {game}, {documents}... stand for on this PC. */
function placeVars(dataDir: string, game: string, platform: OS): Record<string, string> {
  const home = os.homedir();
  return {
    install: dataDir,
    game,
    home,
    documents: path.join(home, "Documents"),
    local: platform === "win32" ? (process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")) : (process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share")),
    config: platform === "win32" ? (process.env.APPDATA ?? path.join(home, "AppData", "Roaming")) : (process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")),
    pad: "xbox",
  };
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** Where a settings file is on this PC: the first entry whose `if` exists, else the first without one. */
export async function configFilePath(cfg: RecompConfigFile, vars: Record<string, string>): Promise<string | null> {
  for (const f of cfg.file) if (f.if && (await exists(fillRecompPath(f.if, vars)))) return path.resolve(fillRecompPath(f.path, vars));
  const plain = cfg.file.find((f) => !f.if);
  return plain ? path.resolve(fillRecompPath(plain.path, vars)) : null;
}

/** A path as a value in a settings file: a quoted string in TOML and JSON, as it is in INI. */
const pathValue = (p: string, format: RecompConfigFile["format"]) => (format === "ini" ? p : JSON.stringify(p));

/** Writes the recomp's settings files before a start: defaults for a new file, missing keys, fixed keys and the game's path. */
export async function applyRecompConfig(manifest: RecompManifest, vars: Record<string, string>, game: string | null): Promise<void> {
  for (const cfg of manifest.config) {
    const file = await configFilePath(cfg, vars);
    if (!file) continue;
    const text = await readFile(file, "utf8").catch(() => null);
    const keys = text === null ? {} : readConfigKeys(text, cfg.format);
    const values: Record<string, string> = {};
    if (text === null) Object.assign(values, cfg.fresh);
    for (const [k, v] of Object.entries(cfg.ensure)) if (keys[k] === undefined || keys[k] === "" || keys[k] === '""' || keys[k] === "''") values[k] = fillRecompPath(v, vars);
    for (const [k, v] of Object.entries(cfg.always)) values[k] = fillRecompPath(v, vars);
    if (cfg.gamePath && game) values[cfg.gamePath] = pathValue(game, cfg.format);
    if (!Object.keys(values).length) continue;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, writeConfigKeys(text ?? "", cfg.format, values));
  }
}

/** Runs the recomp's setup step without a window, passing on its "progress 0.4 text" lines. */
export function runPrepare(exe: string, args: string[], cwd: string, timeoutSec: number, env: Record<string, string>, onLine: (fraction: number | null, text: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutSec * 1000);
    let rest = "";
    let lastErr = "";
    child.stdout.on("data", (d: Buffer) => {
      const lines = (rest + d.toString()).split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const l of lines) {
        const p = prepareProgress(l);
        if (p) onLine(p.fraction, p.text);
      }
    });
    child.stderr.on("data", (d: Buffer) => (lastErr = d.toString().trim().split(/\r?\n/).at(-1) ?? lastErr));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(signal ? `The setup step took longer than ${timeoutSec} seconds and was stopped` : `The setup step failed with exit code ${code}${lastErr ? `: ${lastErr}` : ""}`));
    });
  });
}

/** Works out how to start a library game with a recomp, and puts the game's ROM where the recomp looks for it. */
export async function planRecomp(gameDir: string, recompId: string, opts: RecompOptions): Promise<RecompPlan> {
  const info = await resolveInfo(recompId, opts);
  const platform = opts.platform ?? hostOs();
  const emit = opts.onEvent ?? (() => {});
  const tools = await readTools(opts.toolsDir);
  const state = tools.recomps[recompId];
  if (!state) throw new Error(`Set up ${info.name} first (Emulation, then Recomps)`);
  const dir = recompDir(opts.toolsDir, recompId);
  const manifest = await readRecompManifest(dir);
  const exe = (manifest?.programs.length ? await findProgram(dir, info, manifest, platform) : null) ?? path.join(opts.toolsDir, state.exe);
  if (!(await exists(exe))) throw new Error(`${info.name}'s program is missing. Set it up again (Emulation, then Recomps).`);
  const dataDir = path.dirname(exe);

  let rom: string;
  if (info.rom) {
    const { file, bytes } = await romBytes(gameDir, info, opts);
    rom = file;
    const problem = recompRomProblem(info, bytes);
    if (problem) throw new Error(problem);
    // The recomp checks the ROM's hash itself and asks for another if it isn't the one it was made from.
    const stored = path.join(dataDir, `${info.rom.romId}.z64`);
    const z64 = Buffer.from(toZ64(bytes));
    const have = await readFile(stored).catch(() => null);
    if (!have || !have.equals(z64)) await writeFile(stored, z64);
  } else {
    rom = await gameFile(gameDir, info);
    const want = manifest?.game;
    // A folder game ("Sonic Unleashed/default.xex") is handed over as its folder.
    if (want?.kind === "folder" || (want?.kind === "iso_or_folder" && (rom === gameDir || /\.xex$/i.test(rom)))) rom = rom === gameDir ? gameDir : path.dirname(rom);
    if (want && Object.keys(want.check).length) {
      emit({ message: `Checking ${path.basename(rom)}` });
      const problem = await checkGameCopy(rom, want.check);
      if (problem) throw new Error(`${problem}. ${info.name} needs ${want.label}.`);
    }
  }
  await writeFile(path.join(dataDir, "portable.txt"), "").catch(() => {});

  const vars = placeVars(dataDir, rom, platform);
  const env: Record<string, string> = { LOOTDEN: "1" };
  for (const [k, v] of Object.entries(manifest?.env ?? {})) env[k] = fillRecompPath(v, vars);

  if (manifest) {
    await applyRecompConfig(manifest, vars, rom);
    // The setup step runs once per game file, and again when the player's copy changes.
    const s = await stat(rom).catch(() => null);
    const signature = `${rom}|${s?.size ?? 0}`;
    if (manifest.prepare && state.prepared !== signature) {
      const prep = manifest.prepare;
      const program = await findProgram(dir, { ...info, programs: [] }, { ...manifest, programs: prep.programs }, platform);
      if (!program) throw new Error(`${info.name}'s setup step (${prep.programs[0]}) isn't in its folder`);
      // Zips don't always keep the "can run" mark on Linux.
      if (platform !== "win32") await chmod(program, 0o755).catch(() => {});
      emit({ message: prep.label });
      await runPrepare(program, prep.args.map((a) => fillRecompPath(a, vars)), path.dirname(program), prep.timeout, env, (fraction, text) =>
        emit({ message: `${prep.label}${text ? `: ${text}` : ""}${fraction !== null ? ` (${Math.round(fraction * 100)}%)` : ""}` }),
      );
      const t = await readTools(opts.toolsDir);
      if (t.recomps[recompId]) t.recomps[recompId]!.prepared = signature;
      await writeTools(opts.toolsDir, t);
    }
  }

  // Settings passed on the command line: the player's pick, or the first choice.
  const settingArgs: string[] = [];
  for (const setting of manifest?.settings ?? []) {
    if (setting.in !== "args") continue;
    const pick = setting.choices[state.choices?.[setting.id] ?? 0] ?? setting.choices[0]!;
    settingArgs.push(...pick.args.map((a) => fillRecompPath(a, vars)));
  }

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
    args: [...(manifest?.args ?? []).map((a) => fillRecompPath(a, vars)), ...settingArgs],
    saveDirs: [...new Set(["saves", ...extra])],
    exitCodes: manifest?.exitCodes ?? {},
  };
}

// ---- Settings on the game's page ------------------------------------------------------

export interface RecompSettingView {
  id: string;
  label: string;
  help: string;
  choices: string[];
  /** The choice it's on, or -1 when the file has something none of the choices set. */
  current: number;
  /** Greyed out: another setting makes this one not apply now. */
  disabled: boolean;
}

/** The recomp's settings from its recomplauncher.json, with what each is set to on this PC. */
export async function recompSettings(recompId: string, opts: { toolsDir: string; added?: RecompInfo[]; platform?: OS }): Promise<RecompSettingView[]> {
  const platform = opts.platform ?? hostOs();
  const state = (await readTools(opts.toolsDir)).recomps[recompId];
  if (!state) return [];
  const manifest = await readRecompManifest(recompDir(opts.toolsDir, recompId));
  if (!manifest?.settings.length) return [];
  const vars = placeVars(path.dirname(path.join(opts.toolsDir, state.exe)), "", platform);
  const keysOf = new Map<string, Record<string, string>>();
  for (const cfg of manifest.config) {
    const file = await configFilePath(cfg, vars);
    const text = file ? await readFile(file, "utf8").catch(() => "") : "";
    keysOf.set(cfg.id, readConfigKeys(text, cfg.format));
  }
  return manifest.settings.map((s) => {
    const keys = keysOf.get(s.in === "args" ? "main" : s.in) ?? {};
    return {
      id: s.id,
      label: s.label,
      help: s.help,
      choices: s.choices.map((c) => c.label),
      current: s.in === "args" ? Math.min(state.choices?.[s.id] ?? 0, s.choices.length - 1) : currentChoice(s, keys),
      disabled: !settingApplies(s, keys),
    };
  });
}

/** Picks a choice for one of the recomp's settings: written to its file now, or remembered for the next Play. */
export async function setRecompSetting(recompId: string, settingId: string, choice: number, opts: { toolsDir: string; platform?: OS }): Promise<RecompSettingView[]> {
  const platform = opts.platform ?? hostOs();
  const tools = await readTools(opts.toolsDir);
  const state = tools.recomps[recompId];
  if (!state) throw new Error("That recomp isn't set up on this PC");
  const manifest = await readRecompManifest(recompDir(opts.toolsDir, recompId));
  const setting = manifest?.settings.find((s) => s.id === settingId);
  const pick = setting?.choices[choice];
  if (!manifest || !setting || !pick) throw new Error("Unknown setting");
  if (setting.in === "args") {
    state.choices = { ...state.choices, [settingId]: choice };
    await writeTools(opts.toolsDir, tools);
  } else {
    const cfg = manifest.config.find((c) => c.id === setting.in);
    const vars = placeVars(path.dirname(path.join(opts.toolsDir, state.exe)), "", platform);
    const file = cfg ? await configFilePath(cfg, vars) : null;
    if (!cfg || !file) throw new Error(`${setting.label} is kept in a settings file this recomp doesn't describe`);
    const text = await readFile(file, "utf8").catch(() => null);
    const values = { ...(text === null ? cfg.fresh : {}), ...pick.set };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, writeConfigKeys(text ?? "", cfg.format, values));
  }
  return recompSettings(recompId, opts);
}

// ---- Updates -------------------------------------------------------------------------

/** Installed recomps with a newer full release on GitHub. One that can't be checked is left out. */
export async function recompUpdates(opts: { toolsDir: string; added?: RecompInfo[]; fetchImpl?: Fetch; platform?: OS; arch?: RecompArch }): Promise<Array<{ id: string; installed: string; latest: string }>> {
  const tools = await readTools(opts.toolsDir);
  const out: Array<{ id: string; installed: string; latest: string }> = [];
  for (const [id, state] of Object.entries(tools.recomps)) {
    const info = recompInfo(id, opts.added ?? []) ?? state.info;
    if (!info) continue;
    try {
      const latest = await latestRecompRelease(opts.fetchImpl ?? fetch, info.repo, opts.platform ?? hostOs(), opts.arch ?? hostArch());
      if (latest.version !== state.version) out.push({ id, installed: state.version, latest: latest.version });
    } catch {
      // Offline or rate-limited: try again next time.
    }
  }
  return out;
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
export async function restoreRecompSaves(api: GameServerClient, gameId: string, plan: RecompPlan, opts: RecompOptions & { device: string }): Promise<SaveBackup | null> {
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
  exitCode: number | null;
  /** When it closed with an error: the recomp's own message for the code, or what happened and its newest log. */
  problem: string | null;
}

/** The newest .log the recomp wrote, in its logs folder or beside it. */
async function newestLog(dataDir: string): Promise<string | null> {
  let best: { file: string; t: number } | null = null;
  for (const dir of [path.join(dataDir, "logs"), dataDir]) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!/\.log$/i.test(name)) continue;
      const s = await stat(path.join(dir, name)).catch(() => null);
      if (s?.isFile() && (!best || s.mtimeMs > best.t)) best = { file: path.join(dir, name), t: s.mtimeMs };
    }
  }
  return best?.file ?? null;
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
  opts: RecompOptions & { device: string; onStarted?: (plan: RecompPlan) => void },
): Promise<RecompSession> {
  const plan = await planRecomp(gameDir, recompId, opts);
  const restored = await restoreRecompSaves(api, gameId, plan, opts).catch(() => null);
  const before = await snapshot(plan);
  const started = Date.now();
  opts.onStarted?.(plan);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    // Started from its own folder: that's where portable.txt makes it keep everything.
    const child = spawn(plan.exe, plan.args, { cwd: plan.dataDir, env: { ...process.env, ...plan.env }, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
  let problem: string | null = null;
  if (exitCode !== null && exitCode !== 0) {
    // Windows reports crash codes as unsigned; manifests may write either form.
    const signed = exitCode > 0x7fffffff ? exitCode - 0x100000000 : exitCode;
    const own = plan.exitCodes[String(exitCode)] ?? plan.exitCodes[String(signed)] ?? plan.exitCodes[String(exitCode >>> 0)];
    const log = own ? null : await newestLog(plan.dataDir);
    problem = own ?? `${plan.recomp.name} closed with error code ${exitCode}.${log ? ` Its newest log is ${log}` : ""}`;
  }
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
  return { seconds, backup, restored, exitCode, problem };
}
