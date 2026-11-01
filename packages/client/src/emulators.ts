import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  EMULATORS,
  emulatorInfo,
  pickRomFile,
  platformFor,
  RETROARCH_CORES,
  type BiosRequirement,
  type EmulatorInfo,
  type RecompInfo,
  type SaveBackup,
  type ServerBiosFile,
} from "@lootden/shared";
import type { GameServerClient } from "./api.js";
import { extractArchive, type SevenZip } from "./extractor.js";

export { EMULATORS, emulatorInfo } from "@lootden/shared";

type OS = "win32" | "linux";
const hostOs = (): OS => (process.platform === "win32" ? "win32" : "linux");

/** What the app has set up in its tools folder, kept in lootden-tools.json. */
export interface ToolsManifest {
  emulators: Record<string, { version: string; exe: string; installedAt: string; cores?: string[] }>;
  /** Recomps set up on this PC (see recomps.ts); exe is relative to the tools folder. */
  recomps: Record<
    string,
    {
      version: string;
      exe: string;
      installedAt: string;
      sha256: string | null;
      /** An admin-added recomp's details, so it still plays offline. */
      info?: RecompInfo;
      /** The game file its setup step last ran for ("path|size"). */
      prepared?: string;
      /** The player's picks for settings passed on the command line, by setting id. */
      choices?: Record<string, number>;
    }
  >;
  /** Last save backup restored per game, so the same backup isn't applied twice. */
  restored: Record<string, number>;
}

const MANIFEST = "lootden-tools.json";
const UA = { "User-Agent": "LootDen", Accept: "application/vnd.github+json" };

export async function readTools(toolsDir: string): Promise<ToolsManifest> {
  try {
    const m = JSON.parse(await readFile(path.join(toolsDir, MANIFEST), "utf8")) as Partial<ToolsManifest>;
    return { emulators: m.emulators ?? {}, recomps: m.recomps ?? {}, restored: m.restored ?? {} };
  } catch {
    return { emulators: {}, recomps: {}, restored: {} };
  }
}

export async function writeTools(toolsDir: string, m: ToolsManifest): Promise<void> {
  await mkdir(toolsDir, { recursive: true });
  await writeFile(path.join(toolsDir, MANIFEST), JSON.stringify(m, null, 2) + "\n");
}

export const emulatorDir = (toolsDir: string, id: string) => path.join(toolsDir, id);

/**
 * Where an emulator keeps BIOS files, memory cards and saves. On Windows every emulator
 * runs portable from the tools folder; Linux AppImages use their usual home folders.
 */
export function emulatorDataDir(toolsDir: string, id: string, platform: OS = hostOs()): string {
  const dir = emulatorDir(toolsDir, id);
  if (platform === "win32" || id === "retroarch" || id === "xemu") return dir;
  const home = os.homedir();
  const config = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  if (id === "duckstation") return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "duckstation");
  if (id === "pcsx2") return path.join(config, "PCSX2");
  if (id === "rpcs3") return path.join(config, "rpcs3");
  return dir;
}

// ---- Finding releases: only the projects' own release pages -------------------------

interface Release {
  url: string;
  version: string;
  fileName: string;
}

type Fetch = typeof fetch;

/** Newest release with a matching asset, preferring stable releases over previews. */
async function githubAsset(fetchImpl: Fetch, repo: string, pattern: RegExp): Promise<Release> {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=15`, { headers: UA });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}`);
  const releases = (await res.json()) as Array<{ tag_name: string; prerelease: boolean; draft: boolean; assets: Array<{ name: string; browser_download_url: string }> }>;
  const withAsset = releases.filter((r) => !r.draft && r.assets.some((a) => pattern.test(a.name)));
  const best = withAsset.find((r) => !r.prerelease) ?? withAsset[0];
  if (!best) throw new Error(`No download for this computer in ${repo}'s releases`);
  const asset = best.assets.find((a) => pattern.test(a.name))!;
  return { url: asset.browser_download_url, version: best.tag_name, fileName: asset.name };
}

/** Highest version folder on the libretro buildbot's stable page. */
async function retroarchRelease(fetchImpl: Fetch, platform: OS): Promise<Release> {
  const res = await fetchImpl("https://buildbot.libretro.com/stable/", { headers: { "User-Agent": "LootDen" } });
  if (!res.ok) throw new Error(`The libretro buildbot answered ${res.status}`);
  const html = await res.text();
  const versions = [...html.matchAll(/href="\/stable\/(\d+\.\d+\.\d+)\/"/g)].map((m) => m[1]!);
  const num = (v: string) => v.split(".").map(Number);
  versions.sort((a, b) => {
    const [x, y] = [num(a), num(b)];
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
  });
  const version = versions.at(-1);
  if (!version) throw new Error("Couldn't find a RetroArch release on the libretro buildbot");
  const folder = platform === "win32" ? "windows/x86_64" : "linux/x86_64";
  return { url: `https://buildbot.libretro.com/stable/${version}/${folder}/RetroArch.7z`, version, fileName: "RetroArch.7z" };
}

const SOURCES: Record<string, (f: Fetch, p: OS) => Promise<Release>> = {
  retroarch: retroarchRelease,
  duckstation: (f, p) => githubAsset(f, "stenzek/duckstation", p === "win32" ? /^duckstation-windows-x64-release\.zip$/i : /^DuckStation-x64\.AppImage$/i),
  pcsx2: (f, p) => githubAsset(f, "PCSX2/pcsx2", p === "win32" ? /windows-x64-Qt\.7z$/i : /linux-appimage-x64-Qt\.AppImage$/i),
  rpcs3: (f, p) => (p === "win32" ? githubAsset(f, "RPCS3/rpcs3-binaries-win", /win64.*\.7z$/i) : githubAsset(f, "RPCS3/rpcs3-binaries-linux", /linux64\.AppImage$/i)),
  xemu: (f, p) => githubAsset(f, "xemu-project/xemu", p === "win32" ? /^xemu-win-x86_64-release\.zip$|^xemu.*win.*x86_64.*(?<!pdb|dbg)\.zip$/i : /x86_64\.AppImage$/i),
};

/** The emulator's program, found after unpacking. */
const EXE: Record<string, RegExp> = {
  retroarch: /^(retroarch\.exe|RetroArch.*\.AppImage)$/i,
  duckstation: /^(duckstation-qt.*\.exe|DuckStation.*\.AppImage)$/i,
  pcsx2: /^(pcsx2-qt\.exe|pcsx2.*\.AppImage)$/i,
  rpcs3: /^(rpcs3\.exe|rpcs3.*\.AppImage)$/i,
  xemu: /^(xemu\.exe|xemu.*\.AppImage)$/i,
};

export async function download(fetchImpl: Fetch, url: string, dest: string, onProgress?: (received: number, total: number) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetchImpl(url, { headers: { "User-Agent": "LootDen" }, signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed with ${res.status}: ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _e, done) {
      received += chunk.length;
      onProgress?.(received, total);
      done(null, chunk);
    },
  });
  await mkdir(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), meter, createWriteStream(`${dest}.part`), { signal });
  await rename(`${dest}.part`, dest);
}

export async function findFile(dir: string, pattern: RegExp, depth = 0): Promise<string | null> {
  if (depth > 3) return null;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isFile() && pattern.test(e.name)) return path.join(dir, e.name);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = await findFile(path.join(dir, e.name), pattern, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export type ToolsEvent = { message: string; received?: number; total?: number };

export interface ToolsOptions {
  toolsDir: string;
  sevenZip: SevenZip;
  fetchImpl?: Fetch;
  platform?: OS;
  onEvent?: (e: ToolsEvent) => void;
  signal?: AbortSignal;
}

/** Downloads (or updates) an emulator from its official releases into the tools folder. */
export async function installEmulator(id: string, opts: ToolsOptions): Promise<{ version: string; exe: string }> {
  const info = emulatorInfo(id);
  const source = SOURCES[id];
  if (!info || !source) throw new Error(`Unknown emulator ${id}`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const platform = opts.platform ?? hostOs();
  const emit = opts.onEvent ?? (() => {});
  emit({ message: `Finding the latest ${info.name}` });
  const release = await source(fetchImpl, platform);

  const dir = emulatorDir(opts.toolsDir, id);
  await mkdir(dir, { recursive: true });
  const tmp = await mkdtemp(path.join(opts.toolsDir, `.get-${id}-`));
  try {
    const file = path.join(tmp, release.fileName);
    await download(fetchImpl, release.url, file, (received, total) => emit({ message: `Downloading ${info.name} ${release.version}`, received, total }), opts.signal);
    if (/\.AppImage$/i.test(file)) {
      // Replace the old AppImage; settings and saves live elsewhere.
      for (const old of await readdir(dir)) if (/\.AppImage$/i.test(old)) await rm(path.join(dir, old), { force: true });
      await rename(file, path.join(dir, release.fileName));
      await chmod(path.join(dir, release.fileName), 0o755);
    } else {
      emit({ message: `Unpacking ${info.name}` });
      // Unpacks over the old version: the program is replaced, BIOS, saves and settings stay.
      await extractArchive(opts.sevenZip, /\.zip$/i.test(file) ? "zip" : "7z", file, dir);
      await hoistProgram(dir, EXE[id]!);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const exe = await findFile(dir, EXE[id]!);
  if (!exe) throw new Error(`${info.name} downloaded, but its program wasn't in the download`);
  await makePortable(id, dir, path.dirname(exe));
  const tools = await readTools(opts.toolsDir);
  tools.emulators[id] = { ...tools.emulators[id], version: release.version, exe: path.relative(opts.toolsDir, exe), installedAt: new Date().toISOString() };
  await writeTools(opts.toolsDir, tools);
  emit({ message: `${info.name} ${release.version} is ready` });

  // xemu's hard drive image comes from the xemu project itself.
  if (id === "xemu" && !(await findFile(path.join(dir, "bios"), /^xbox_hdd\.qcow2$/i))) {
    await fetchXboxHdd({ ...opts, fetchImpl });
  }
  return { version: release.version, exe };
}

/** Archives often wrap the program in one folder ("RetroArch-Win64/"); lift it so paths stay stable across versions. */
async function hoistProgram(dir: string, exe: RegExp): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && exe.test(e.name))) return;
  const wrapper = entries.find((e) => e.isDirectory() && !/^(bios|system|saves|states|memcards|sstates|savestates|firmware|cores|dev_hdd0)$/i.test(e.name));
  if (!wrapper || !(await readdir(path.join(dir, wrapper.name))).some((n) => exe.test(n))) return;
  for (const child of await readdir(path.join(dir, wrapper.name))) {
    const to = path.join(dir, child);
    await rm(to, { recursive: true, force: true });
    await rename(path.join(dir, wrapper.name, child), to);
  }
  await rm(path.join(dir, wrapper.name), { recursive: true, force: true });
}

/** Keeps settings, BIOS and saves beside the program on Windows, so the tools folder is self-contained. */
async function makePortable(id: string, dir: string, exeDir: string): Promise<void> {
  if (id === "duckstation") await writeFile(path.join(exeDir, "portable.txt"), "");
  if (id === "pcsx2") await writeFile(path.join(exeDir, "portable.ini"), "");
  if (id === "retroarch") {
    for (const sub of ["system", "saves", "states"]) await mkdir(path.join(dir, sub), { recursive: true });
  }
  if (id === "xemu") await mkdir(path.join(dir, "bios"), { recursive: true });
}

async function fetchXboxHdd(opts: ToolsOptions & { fetchImpl: Fetch }): Promise<void> {
  const emit = opts.onEvent ?? (() => {});
  emit({ message: "Downloading the Xbox hard drive image from the xemu project" });
  const release = await githubAsset(opts.fetchImpl, "xemu-project/xemu-hdd-image", /xbox_hdd\.qcow2\.zip$/i);
  const bios = path.join(emulatorDir(opts.toolsDir, "xemu"), "bios");
  const zip = path.join(bios, release.fileName);
  await download(opts.fetchImpl, release.url, zip, (received, total) => emit({ message: "Downloading the Xbox hard drive image", received, total }), opts.signal);
  await extractArchive(opts.sevenZip, "zip", zip, bios);
  await rm(zip, { force: true });
  const hdd = await findFile(bios, /^xbox_hdd\.qcow2$/i);
  if (hdd && path.dirname(hdd) !== bios) await rename(hdd, path.join(bios, "xbox_hdd.qcow2"));
}

/** RetroArch cores come from the libretro buildbot, one per system, fetched the first time they're needed. */
export async function installCore(core: string, opts: ToolsOptions): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const platform = opts.platform ?? hostOs();
  const dir = path.join(emulatorDir(opts.toolsDir, "retroarch"), "cores");
  const file = `${core}_libretro.${platform === "win32" ? "dll" : "so"}`;
  const target = path.join(dir, file);
  if (await stat(target).catch(() => null)) return target;
  const folder = platform === "win32" ? "windows/x86_64" : "linux/x86_64";
  const zip = path.join(dir, `${file}.zip`);
  opts.onEvent?.({ message: `Downloading the ${core} core for RetroArch` });
  await download(fetchImpl, `https://buildbot.libretro.com/nightly/${folder}/latest/${file}.zip`, zip, undefined, opts.signal);
  await extractArchive(opts.sevenZip, "zip", zip, dir);
  await rm(zip, { force: true });
  const tools = await readTools(opts.toolsDir);
  const ra = tools.emulators.retroarch;
  if (ra) {
    ra.cores = [...new Set([...(ra.cores ?? []), core])];
    await writeTools(opts.toolsDir, tools);
  }
  return target;
}

// ---- BIOS ------------------------------------------------------------------------

export interface BiosStatus {
  emulator: string;
  requirement: BiosRequirement;
  /** The file in place, when there is one. */
  present: string | null;
}

/** Each emulator's BIOS needs and whether a matching file is already in place. */
export async function biosStatus(toolsDir: string, platform: OS = hostOs()): Promise<BiosStatus[]> {
  const tools = await readTools(toolsDir);
  const out: BiosStatus[] = [];
  for (const e of EMULATORS) {
    for (const r of e.bios) {
      let present: string | null = null;
      if (r.folder === "firmware") present = tools.emulators[e.id] && (await firmwareInstalled(toolsDir, e.id, platform)) ? "installed" : null;
      else {
        const names = await readdir(path.join(emulatorDataDir(toolsDir, e.id, platform), r.folder)).catch(() => [] as string[]);
        present = names.find((n) => new RegExp(r.match, "i").test(n)) ?? null;
      }
      out.push({ emulator: e.id, requirement: r, present });
    }
  }
  return out;
}

async function firmwareInstalled(toolsDir: string, id: string, platform: OS): Promise<boolean> {
  if (id !== "rpcs3") return false;
  const vsh = path.join(emulatorDataDir(toolsDir, id, platform), "dev_flash", "vsh", "module", "vsh.self");
  return !!(await stat(vsh).catch(() => null));
}

/**
 * Puts a BIOS file where its emulator looks. PS3 firmware is installed by RPCS3 itself.
 * Returns the requirement it satisfied.
 */
export async function addBiosFile(toolsDir: string, emulator: EmulatorInfo, file: string, platform: OS = hostOs()): Promise<BiosRequirement> {
  const name = path.basename(file);
  const req = emulator.bios.find((r) => new RegExp(r.match, "i").test(name));
  if (!req) throw new Error(`${name} isn't a file ${emulator.name} uses. It needs: ${emulator.bios.map((r) => r.examples[0]).join(", ")}`);
  if (req.folder === "firmware") {
    const tools = await readTools(toolsDir);
    const state = tools.emulators[emulator.id];
    if (!state) throw new Error(`Set up ${emulator.name} first, then add the firmware`);
    await run(path.join(toolsDir, state.exe), ["--installfw", file]);
    return req;
  }
  const dest = path.join(emulatorDataDir(toolsDir, emulator.id, platform), req.folder);
  await mkdir(dest, { recursive: true });
  await copyFile(file, path.join(dest, name));
  return req;
}

/** Copies every BIOS file the admin uploaded to the server into place. */
export async function biosFromServer(api: GameServerClient, toolsDir: string, platform: OS = hostOs()): Promise<{ added: string[]; skipped: string[] }> {
  const files = await api.json<ServerBiosFile[]>("/api/emulation/bios");
  const added: string[] = [];
  const skipped: string[] = [];
  const tmp = await mkdtemp(path.join(os.tmpdir(), "lootden-bios-"));
  try {
    for (const f of files) {
      const info = emulatorInfo(f.emulator);
      if (!info) continue;
      const local = path.join(tmp, f.name);
      await writeFile(local, await api.download(`/api/emulation/bios/${encodeURIComponent(f.name)}`));
      try {
        await addBiosFile(toolsDir, info, local, platform);
        added.push(f.name);
      } catch {
        skipped.push(f.name);
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return { added, skipped };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: path.dirname(cmd), stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with ${code}`))));
  });
}

// ---- Playing ---------------------------------------------------------------------

export interface LaunchPlan {
  emulator: EmulatorInfo;
  exe: string;
  args: string[];
  rom: string;
  /** Folders (relative to the data folder) whose changes are this game's saves. */
  saveDirs: string[];
  /** RetroArch names saves after the ROM, so only matching files count. */
  savePrefix: string | null;
  dataDir: string;
}

/** Works out how to start an emulated game. Fetches the RetroArch core if needed. */
export async function planLaunch(gameDir: string, platformId: string, opts: ToolsOptions): Promise<LaunchPlan> {
  const platform = platformFor(platformId);
  const os_ = opts.platform ?? hostOs();
  const emulator = platform.emulator ? emulatorInfo(platform.emulator) : undefined;
  if (!emulator) throw new Error(`LootDen doesn't have an emulator for ${platform.name} yet`);
  const tools = await readTools(opts.toolsDir);
  const state = tools.emulators[emulator.id];
  if (!state) throw new Error(`Set up ${emulator.name} first (Emulation, then Emulators)`);

  const missing = (await biosStatus(opts.toolsDir, os_)).filter(
    (b) => b.emulator === emulator.id && b.requirement.required && !b.present && (!b.requirement.platform || b.requirement.platform === platform.id),
  );
  if (missing.length) throw new Error(`${emulator.name} needs ${missing.map((m) => m.requirement.label).join(" and ")} first (Emulation, then Emulators)`);

  const files = await listFiles(gameDir);
  const romRel = pickRomFile(files, platform);
  if (!romRel) throw new Error(`No ${platform.short} game file found in ${gameDir}`);
  const rom = path.join(gameDir, ...romRel.split("/"));
  const exe = path.join(opts.toolsDir, state.exe);
  const dataDir = emulatorDataDir(opts.toolsDir, emulator.id, os_);
  const base = path.basename(rom).replace(/\.[^.]+$/, "");

  switch (emulator.id) {
    case "retroarch": {
      const core = await installCore(RETROARCH_CORES[platform.id] ?? "", opts);
      const cfg = path.join(dataDir, "lootden.cfg");
      const q = (p: string) => `"${p.replace(/\\/g, "/")}"`;
      // Fixed folders for saves, so backups know where to look on every PC.
      await writeFile(
        cfg,
        [
          `system_directory = ${q(path.join(dataDir, "system"))}`,
          `savefile_directory = ${q(path.join(dataDir, "saves"))}`,
          `savestate_directory = ${q(path.join(dataDir, "states"))}`,
          `sort_savefiles_enable = "false"`,
          `sort_savestates_enable = "false"`,
          `sort_savefiles_by_content_enable = "false"`,
          `sort_savestates_by_content_enable = "false"`,
          // Controllers: RetroArch's own profiles map any pad it recognises. Select+Start quits
          // back to LootDen and L3+R3 opens the menu, so nothing needs a keyboard.
          `input_autodetect_enable = "true"`,
          `input_quit_gamepad_combo = "4"`,
          `input_menu_toggle_gamepad_combo = "2"`,
          `pause_nonactive = "false"`,
          "",
        ].join("\n"),
      );
      return { emulator, exe, rom, dataDir, args: ["-f", "-L", core, "--appendconfig", cfg, rom], saveDirs: ["saves", "states"], savePrefix: base };
    }
    case "duckstation":
      // Memory cards named after the game file, the same name the browser player uses, so both share one card.
      await setIni(path.join(dataDir, "settings.ini"), "MemoryCards", { Card1Type: "PerGameFileTitle" });
      await bindController(path.join(dataDir, "settings.ini"), DUCKSTATION_PAD);
      return { emulator, exe, rom, dataDir, args: ["-batch", "-fullscreen", "--", rom], saveDirs: ["memcards", "savestates"], savePrefix: null };
    case "pcsx2":
      await bindController(path.join(dataDir, "inis", "PCSX2.ini"), PCSX2_PAD);
      return { emulator, exe, rom, dataDir, args: ["-batch", "-fullscreen", "--", rom], saveDirs: ["memcards", "sstates"], savePrefix: null };
    case "rpcs3":
      return { emulator, exe, rom, dataDir, args: ["--no-gui", rom], saveDirs: ["dev_hdd0/home/00000001/savedata"], savePrefix: null };
    case "xemu": {
      const bios = path.join(dataDir, "bios");
      const names = await readdir(bios).catch(() => [] as string[]);
      const pick = (id: string) => {
        const r = emulator.bios.find((b) => b.id === id)!;
        const n = names.find((x) => new RegExp(r.match, "i").test(x));
        return n ? path.join(bios, n).replace(/\\/g, "/") : "";
      };
      const config = path.join(dataDir, "xemu.toml");
      await writeFile(config, `[sys.files]\nbootrom_path = '${pick("mcpx")}'\nflashrom_path = '${pick("flash")}'\nhdd_path = '${pick("hdd")}'\n`);
      return { emulator, exe, rom, dataDir, args: ["-config_path", config, "-full-screen", "-dvd_path", rom], saveDirs: [], savePrefix: null };
    }
    default:
      throw new Error(`Don't know how to start ${emulator.name}`);
  }
}

/** The first controller on player 1, as SDL sees it (Xbox layout names; PlayStation and Switch pads map the same way). */
const PS_BUTTONS = {
  Up: "SDL-0/DPadUp",
  Down: "SDL-0/DPadDown",
  Left: "SDL-0/DPadLeft",
  Right: "SDL-0/DPadRight",
  Cross: "SDL-0/A",
  Circle: "SDL-0/B",
  Square: "SDL-0/X",
  Triangle: "SDL-0/Y",
  Select: "SDL-0/Back",
  Start: "SDL-0/Start",
  L1: "SDL-0/LeftShoulder",
  R1: "SDL-0/RightShoulder",
  L2: "SDL-0/+LeftTrigger",
  R2: "SDL-0/+RightTrigger",
  L3: "SDL-0/LeftStick",
  R3: "SDL-0/RightStick",
  LLeft: "SDL-0/-LeftX",
  LRight: "SDL-0/+LeftX",
  LUp: "SDL-0/-LeftY",
  LDown: "SDL-0/+LeftY",
  RLeft: "SDL-0/-RightX",
  RRight: "SDL-0/+RightX",
  RUp: "SDL-0/-RightY",
  RDown: "SDL-0/+RightY",
};

export interface PadSetup {
  /** INI sections to fill: the pad itself, plus switches that turn SDL controllers on. */
  pad: { section: string; values: Record<string, string> };
  extra: Array<{ section: string; values: Record<string, string> }>;
}

const DUCKSTATION_PAD: PadSetup = {
  pad: { section: "Pad1", values: { Type: "AnalogController", ...PS_BUTTONS, Analog: "SDL-0/Guide", SmallMotor: "SDL-0/SmallMotor", LargeMotor: "SDL-0/LargeMotor" } },
  extra: [{ section: "InputSources", values: { SDL: "true", XInput: "false" } }],
};

const PCSX2_PAD: PadSetup = {
  pad: { section: "Pad1", values: { Type: "DualShock2", ...PS_BUTTONS, Analog: "SDL-0/Guide", SmallMotor: "SDL-0/SmallMotor", LargeMotor: "SDL-0/LargeMotor" } },
  extra: [
    { section: "InputSources", values: { SDL: "true", XInput: "false" } },
    // The first-run wizard would otherwise pop up in front of the game.
    { section: "UI", values: { SetupWizardIncomplete: "false" } },
  ],
};

/**
 * Puts the first controller on player 1, unless the player already bound a controller there
 * (then their own setup stays). Without this a fresh emulator only listens to the keyboard.
 */
export async function bindController(file: string, setup: PadSetup): Promise<boolean> {
  const text = await readFile(file, "utf8").catch(() => "");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `[${setup.pad.section.toLowerCase()}]`);
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
    const body = lines.slice(start + 1, end < 0 ? undefined : end);
    if (body.some((l) => /=\s*(SDL|XInput|DInput)-\d/i.test(l))) return false;
  }
  for (const x of setup.extra) await setIni(file, x.section, x.values);
  await setIni(file, setup.pad.section, setup.pad.values);
  return true;
}

/** Sets keys in one section of an INI file, keeping everything else the emulator wrote. */
export async function setIni(file: string, section: string, values: Record<string, string>): Promise<void> {
  const lines = (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/);
  let start = lines.findIndex((l) => l.trim().toLowerCase() === `[${section.toLowerCase()}]`);
  if (start < 0) {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(`[${section}]`);
    start = lines.length - 1;
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex((l, i) => i > start && i < end && l.split("=")[0]!.trim().toLowerCase() === key.toLowerCase());
    if (at >= 0) lines[at] = `${key} = ${value}`;
    else {
      lines.splice(end, 0, `${key} = ${value}`);
      end++;
    }
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.join("\n").replace(/\n*$/, "\n"));
}

export async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Every save file under the plan's folders, with modified times, relative to the data folder. */
async function snapshot(plan: LaunchPlan): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const sub of plan.saveDirs) {
    for (const rel of await listFiles(plan.dataDir, sub)) {
      if (plan.savePrefix && !path.posix.basename(rel).startsWith(plan.savePrefix + ".")) continue;
      const s = await stat(path.join(plan.dataDir, rel)).catch(() => null);
      if (s) out.set(rel, s.mtimeMs);
    }
  }
  return out;
}

export function zipFiles(sevenZip: SevenZip, cwd: string, files: string[], zip: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZip.path, ["a", "-tzip", "-bd", "-y", zip, ...files], { cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`7-Zip exited with ${code}: ${err.trim()}`))));
  });
}

/**
 * Before playing: brings in the player's newest backup from another PC. Files are only
 * written when the backup is newer than what's here, so local progress is never rolled back.
 */
export async function restoreEmulatorSaves(api: GameServerClient, gameId: string, plan: LaunchPlan, toolsDir: string, sevenZip: SevenZip, device: string): Promise<SaveBackup | null> {
  if (!plan.saveDirs.length) return null;
  // Saves a recomp made for the same game are its own, not the emulator's.
  const latest = (await api.listSaves(gameId)).filter((s) => !s.runner)[0];
  const tools = await readTools(toolsDir);
  if (!latest || tools.restored[gameId] === latest.id || latest.device === device) return null;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "lootden-emusave-"));
  try {
    const zip = path.join(tmp, "save.zip");
    await writeFile(zip, await api.downloadSave(gameId, latest.id));
    const out = path.join(tmp, "files");
    await extractArchive(sevenZip, "zip", zip, out);
    const when = new Date(latest.createdAt);
    for (const rel of await listFiles(out)) {
      if (rel.split("/").includes("..")) continue;
      const dest = path.join(plan.dataDir, ...rel.split("/"));
      const local = await stat(dest).catch(() => null);
      if (local && local.mtime >= when) continue;
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(out, ...rel.split("/")), dest);
      await utimes(dest, when, when);
    }
    tools.restored[gameId] = latest.id;
    await writeTools(toolsDir, tools);
    return latest;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export interface EmulatedSession {
  seconds: number;
  backup: SaveBackup | null;
  restored: SaveBackup | null;
}

/**
 * Plays an emulated game: restores newer saves, runs the emulator, then uploads the
 * save files that changed while playing as this player's backup for the game.
 */
export async function playEmulated(
  api: GameServerClient,
  gameId: string,
  gameDir: string,
  platformId: string,
  opts: ToolsOptions & { device: string; onStarted?: (plan: LaunchPlan) => void },
): Promise<EmulatedSession> {
  const plan = await planLaunch(gameDir, platformId, opts);
  const restored = await restoreEmulatorSaves(api, gameId, plan, opts.toolsDir, opts.sevenZip, opts.device).catch(() => null);
  const before = await snapshot(plan);
  const started = Date.now();
  opts.onStarted?.(plan);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.exe, plan.args, { cwd: path.dirname(plan.exe), stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", () => resolve());
  });
  const seconds = Math.round((Date.now() - started) / 1000);

  const after = await snapshot(plan);
  const changed = [...after].filter(([rel, t]) => before.get(rel) !== t).map(([rel]) => rel);
  let backup: SaveBackup | null = null;
  // Offline, the save stays in the emulator's folder; the next session online that changes it backs it up.
  if (changed.length && (await api.health().then(() => true, () => false))) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "lootden-emusave-"));
    try {
      const zip = path.join(tmp, "save.zip");
      await zipFiles(opts.sevenZip, plan.dataDir, changed, zip);
      backup = await api.uploadSave(gameId, await readFile(zip), opts.device);
      const tools = await readTools(opts.toolsDir);
      tools.restored[gameId] = backup.id;
      await writeTools(opts.toolsDir, tools);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  return { seconds, backup, restored };
}

/** Emulators with what's installed and which BIOS files are in place, for the app's Emulators page. */
export async function emulatorOverview(toolsDir: string) {
  const tools = await readTools(toolsDir);
  const bios = await biosStatus(toolsDir);
  return EMULATORS.map((e) => ({
    id: e.id,
    installed: tools.emulators[e.id] ?? null,
    bios: bios.filter((b) => b.emulator === e.id).map((b) => ({ id: b.requirement.id, present: b.present })),
  }));
}
