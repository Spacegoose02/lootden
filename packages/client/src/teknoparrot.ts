// Sets TeknoParrot up on a Windows PC that doesn't have it, the way TeknoParrot's own installer
// (TeknoParrotInstaller, github.com/ReaverTeknoGods/TPBootstrapper) does: it asks TeknoParrot's
// update service for the newest build of each part, downloads each from teknogods' GitHub
// releases and unpacks it into the part's folder. LootDen keeps its copy in the tools folder
// (tools/teknoparrot), and an update only downloads the parts that changed.
//
// TeknoParrot also needs Microsoft's runtimes: the Visual C++ 2015-2022 runtimes (32 and 64-bit),
// the DirectX June 2010 runtimes (d3dx9 and friends, which Windows doesn't ship) and .NET
// Framework 4.8. LootDen checks for each and installs the missing ones from Microsoft's own
// downloads, with one Windows permission prompt for all of them.

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isTeknoParrotDir, readArcadeState, runText, TEKNOPARROT_EXE, writeArcadeState, type RunText } from "./arcade.js";
import { download, emulatorDir, findFile } from "./emulators.js";
import { extractArchive, type SevenZip } from "./extractor.js";

/** TeknoParrot's update service: every part, with its newest release on GitHub. */
export const TEKNOPARROT_COMPONENTS = "https://teknoparrot.com/api/updates/components";

/** Where LootDen puts its own TeknoParrot. */
export const teknoParrotHome = (toolsDir: string) => emulatorDir(toolsDir, "teknoparrot");

/** The parts LootDen downloaded and their versions, kept beside TeknoParrot. */
const PARTS_FILE = "lootden-parts.json";

/**
 * Parts that are whole emulators of their own (a few hundred MB each) for a handful of games:
 * left out, like the installer leaves them unticked. TeknoParrot's own updater gets them if a
 * game needs one.
 */
const OPTIONAL = new Set(["crediardolphin", "play", "rpcs3", "cxbxr", "pcsx2x6"]);

/** Where each part goes, from TeknoParrot's updater (UpdaterComponent.cs): the UI in the root, the rest in a folder. */
const FOLDERS: Record<string, string> = {
  teknoparrotui: "",
  opensegaapi: "TeknoParrot",
  opensndgaelco: "TeknoParrot",
  opensndvoyager: "TeknoParrot",
  scoresubmission: "TeknoParrot",
  teknodraw: "TeknoParrot",
  teknoparrotn2: "N2",
  teknoparrotelfldr2: "ElfLdr2",
};

/** Parts whose version TeknoParrot reads from a .version file beside them rather than from the DLL. */
const MANUAL_VERSION = new Set(["teknoparrotelfldr2", "crediardolphin", "play"]);

export interface TeknoParrotPart {
  component: string;
  version: string;
  url: string;
  fileName: string;
  /** Relative to the TeknoParrot folder; "" is the folder itself. */
  folder: string;
}

export const partFolder = (component: string) => FOLDERS[component.toLowerCase()] ?? component;

/** "TeknoParrotUI_1.0.0.2305" -> "1.0.0.2305", as the installer reads versions. */
export function partVersion(component: string, ...names: Array<string | undefined>): string {
  // The component's own name goes first: "OpenParrotWin32_1.0.0.787" isn't version 32.1.0.0.787.
  const strip = (n: string) => (n.toLowerCase().startsWith(component.toLowerCase()) ? n.slice(component.length) : n);
  for (const n of names) {
    const m = n && strip(n).replace(/_/g, ".").match(/v?(\d+(?:\.\d+)+)/);
    if (m) return m[1]!;
  }
  for (const n of names) {
    const rest = n?.replace(/\.(zip|7z|exe|dll)$/i, "").replace(new RegExp(component, "i"), "").replace(/^[_\-\sVv]+|[_\-\s]+$/g, "");
    if (rest) return rest;
  }
  return component;
}

type Fetch = typeof fetch;
type Asset = { name?: string; browser_download_url?: string };
type Entry = { component?: string; release?: { tag_name?: string; name?: string; assets?: Asset[] }; assets?: Asset[] };

/** The newest build of every part LootDen sets up, from TeknoParrot's update service. */
export async function teknoParrotParts(fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<TeknoParrotPart[]> {
  const res = await fetchImpl(TEKNOPARROT_COMPONENTS, { headers: { "User-Agent": "LootDen", Accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`TeknoParrot's update service answered ${res.status}`);
  const list = (await res.json()) as Entry[];
  if (!Array.isArray(list)) throw new Error("TeknoParrot's update service sent something LootDen doesn't understand");
  const parts: TeknoParrotPart[] = [];
  for (const e of list) {
    const component = e?.component;
    if (!component || OPTIONAL.has(component.toLowerCase())) continue;
    const assets = (e.release?.assets?.length ? e.release.assets : e.assets) ?? [];
    // An archive first, as the installer means to; then anything else it would take.
    const asset = assets.find((a) => /\.zip$/i.test(a.name ?? "")) ?? assets.find((a) => /\.(dll|exe)$/i.test(a.name ?? ""));
    if (!asset?.browser_download_url || !asset.name) continue;
    // Only teknogods' (and its people's) GitHub releases, never anywhere else.
    if (!/^https:\/\/github\.com\//i.test(asset.browser_download_url)) continue;
    parts.push({
      component,
      version: partVersion(component, e.release?.name, e.release?.tag_name, asset.name),
      url: asset.browser_download_url,
      fileName: path.basename(asset.name),
      folder: partFolder(component),
    });
  }
  if (!parts.some((p) => p.component.toLowerCase() === "teknoparrotui")) throw new Error("TeknoParrot's update service didn't list TeknoParrot itself");
  return parts;
}

export interface TeknoParrotInstall {
  dir: string;
  version: string;
  /** Parts downloaded this time (all of them on a first install, the changed ones on an update). */
  updated: string[];
}

export interface TeknoParrotOptions {
  toolsDir: string;
  sevenZip: SevenZip;
  fetchImpl?: Fetch;
  onEvent?: (e: { message: string; received?: number; total?: number }) => void;
  signal?: AbortSignal;
  /** Unpacks a part's zip into a folder (7-Zip by default; tests pass their own). */
  unzip?: (zip: string, dir: string) => Promise<void>;
}

async function readParts(dir: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(path.join(dir, PARTS_FILE), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Downloads TeknoParrot into the tools folder, or brings LootDen's copy up to date, and makes
 * it the TeknoParrot arcade games use on this PC. The player's profiles and settings stay.
 */
export async function installTeknoParrot(opts: TeknoParrotOptions): Promise<TeknoParrotInstall> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const emit = opts.onEvent ?? (() => {});
  const unzip = opts.unzip ?? ((zip: string, dir: string) => extractArchive(opts.sevenZip, "zip", zip, dir));
  const dir = teknoParrotHome(opts.toolsDir);

  emit({ message: "Finding the latest TeknoParrot" });
  const parts = await teknoParrotParts(fetchImpl, opts.signal);
  await mkdir(dir, { recursive: true });
  const have = await readParts(dir);
  const fresh = !(await isTeknoParrotDir(dir));
  const todo = parts.filter((p) => fresh || have[p.component] !== p.version);
  const tmp = await mkdtemp(path.join(opts.toolsDir, ".get-teknoparrot-"));
  const updated: string[] = [];
  try {
    for (const [i, p] of todo.entries()) {
      const label = `TeknoParrot ${p.component} ${p.version} (${i + 1} of ${todo.length})`;
      const file = path.join(tmp, `${i}-${p.fileName}`);
      await download(fetchImpl, p.url, file, (received, total) => emit({ message: `Downloading ${label}`, received, total }), opts.signal);
      const target = path.join(dir, p.folder);
      await mkdir(target, { recursive: true });
      if (/\.zip$/i.test(p.fileName)) {
        emit({ message: `Unpacking ${label}` });
        await unzip(file, target);
      } else {
        await copyFile(file, path.join(target, p.fileName));
      }
      if (MANUAL_VERSION.has(p.component.toLowerCase())) await writeFile(path.join(target, ".version"), p.version);
      await rm(file, { force: true });
      have[p.component] = p.version;
      updated.push(p.component);
      // Saved after each part, so a stopped download picks up where it left off.
      await writeFile(path.join(dir, PARTS_FILE), JSON.stringify(have, null, 2) + "\n");
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // TeknoParrotUi.zip has kept its program in the root so far; lift it if a release wraps it in a folder.
  if (!(await isTeknoParrotDir(dir))) {
    const exe = await findFile(dir, new RegExp(`^${TEKNOPARROT_EXE.replace(".", "\\.")}$`, "i"));
    throw new Error(exe ? `TeknoParrot unpacked to an unexpected folder (${path.relative(dir, path.dirname(exe))})` : "TeknoParrot downloaded, but its program wasn't in the download");
  }
  const state = await readArcadeState(opts.toolsDir);
  state.tpDir = dir;
  await writeArcadeState(opts.toolsDir, state);
  const version = have[parts.find((p) => p.component.toLowerCase() === "teknoparrotui")!.component] ?? "";
  emit({ message: updated.length ? `TeknoParrot ${version} is ready` : `TeknoParrot ${version} is up to date` });
  return { dir, version, updated };
}

/** The version of LootDen's own TeknoParrot, or null when this PC uses one the player installed. */
export async function managedTeknoParrot(toolsDir: string, tpDir: string | null): Promise<string | null> {
  const home = teknoParrotHome(toolsDir);
  if (!tpDir || path.resolve(tpDir).toLowerCase() !== path.resolve(home).toLowerCase()) return null;
  const parts = await readParts(home);
  const ui = Object.keys(parts).find((k) => k.toLowerCase() === "teknoparrotui");
  return ui ? parts[ui]! : null;
}

// ---- Microsoft runtimes TeknoParrot needs -------------------------------------------

export interface Prerequisite {
  id: "vc-x64" | "vc-x86" | "directx" | "dotnet48";
  name: string;
  installed: boolean;
}

interface PrereqSource {
  id: Prerequisite["id"];
  name: string;
  url: string;
  file: string;
  /** The line in the setup script that installs it quietly. */
  command: (file: string) => string;
}

/** Microsoft's own downloads for each runtime. */
const SOURCES: PrereqSource[] = [
  {
    id: "vc-x64",
    name: "Visual C++ 2015-2022 runtime (64-bit)",
    url: "https://aka.ms/vs/17/release/vc_redist.x64.exe",
    file: "vc_redist.x64.exe",
    command: (f) => `"${f}" /install /quiet /norestart`,
  },
  {
    id: "vc-x86",
    name: "Visual C++ 2015-2022 runtime (32-bit)",
    url: "https://aka.ms/vs/17/release/vc_redist.x86.exe",
    file: "vc_redist.x86.exe",
    command: (f) => `"${f}" /install /quiet /norestart`,
  },
  {
    id: "directx",
    name: "DirectX runtimes (June 2010)",
    url: "https://download.microsoft.com/download/8/4/A/84A35BF1-DAFE-4AE8-82AF-AD2AE20B6B14/directx_Jun2010_redist.exe",
    file: "directx_Jun2010_redist.exe",
    // A self-extractor: unpack it, then run its setup silently.
    command: (f) => `"${f}" /Q /T:"${path.win32.join(path.win32.dirname(f), "dx")}"\r\n"${path.win32.join(path.win32.dirname(f), "dx", "DXSETUP.exe")}" /silent`,
  },
  {
    id: "dotnet48",
    name: ".NET Framework 4.8",
    url: "https://go.microsoft.com/fwlink/?linkid=2088631",
    file: "ndp48-x86-x64-allos-enu.exe",
    command: (f) => `"${f}" /q /norestart`,
  },
];

const regValue = (out: string, name: string): string | null => out.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(\\S+)`, "mi"))?.[1] ?? null;
const regNumber = (v: string | null) => (v ? (/^0x/i.test(v) ? parseInt(v, 16) : Number(v)) : 0);

async function exists(file: string): Promise<boolean> {
  return Boolean(await stat(file).catch(() => null));
}

/** Which of TeknoParrot's runtimes this PC has. */
export async function teknoParrotPrerequisites(run: RunText = runText, env: NodeJS.ProcessEnv = process.env, has: (file: string) => Promise<boolean> = exists): Promise<Prerequisite[]> {
  const reg = (key: string) => run("reg", ["query", key, "/reg:64"]);
  const vcInstalled = async (key: string) => regNumber(regValue(await reg(key), "Installed")) === 1;
  const windir = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
  const sys32 = path.win32.join(windir, "System32");
  const wow64 = path.win32.join(windir, "SysWOW64");
  // Most arcade games are 32-bit: the 32-bit DirectX files matter most, so both are checked.
  const dx = (await has(path.win32.join(sys32, "d3dx9_43.dll"))) && (await has(path.win32.join(sys32, "xinput1_3.dll"))) && (!(await has(wow64)) || ((await has(path.win32.join(wow64, "d3dx9_43.dll"))) && (await has(path.win32.join(wow64, "xinput1_3.dll")))));
  const ndp = regNumber(regValue(await reg("HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full"), "Release"));
  const installed: Record<Prerequisite["id"], boolean> = {
    "vc-x64": await vcInstalled("HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64"),
    "vc-x86": (await vcInstalled("HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x86")) || (await vcInstalled("HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x86")),
    directx: dx,
    // 528040 is .NET Framework 4.8's release number (Windows 10 1903 and later have it built in).
    dotnet48: ndp >= 528040,
  };
  return SOURCES.map((s) => ({ id: s.id, name: s.name, installed: installed[s.id] }));
}

/** The setup script that installs the given runtimes quietly, one after another. */
export function prerequisiteScript(ids: Array<Prerequisite["id"]>, dir: string): string {
  const lines = ["@echo off"];
  for (const s of SOURCES) if (ids.includes(s.id)) lines.push(s.command(path.win32.join(dir, s.file)));
  // The installers' own codes (3010: restart needed, 1638: newer one there) aren't failures; LootDen checks again afterwards.
  lines.push("exit /b 0");
  return lines.join("\r\n") + "\r\n";
}

/** Runs a script as administrator (one Windows permission prompt) and waits for it. */
export type RunElevated = (script: string) => Promise<void>;

export const runElevated: RunElevated = (script) =>
  new Promise((resolve, reject) => {
    const quoted = script.replace(/'/g, "''");
    const ps = `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '"${quoted}"' -Verb RunAs -Wait -WindowStyle Hidden -PassThru; exit $p.ExitCode`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Windows didn't allow the runtime installers to run. Accept the permission prompt to install them.")),
    );
  });

export interface PrerequisiteOptions {
  toolsDir: string;
  fetchImpl?: Fetch;
  run?: RunText;
  elevated?: RunElevated;
  onEvent?: (e: { message: string; received?: number; total?: number }) => void;
  signal?: AbortSignal;
  /** Checks again after installing; defaults to the real check. */
  check?: () => Promise<Prerequisite[]>;
}

/** Installs whichever of TeknoParrot's runtimes are missing, then says what's still missing. */
export async function installTeknoParrotPrerequisites(opts: PrerequisiteOptions): Promise<Prerequisite[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const emit = opts.onEvent ?? (() => {});
  const check = opts.check ?? (() => teknoParrotPrerequisites(opts.run));
  const missing = (await check()).filter((p) => !p.installed);
  if (!missing.length) return check();
  const tmp = await mkdtemp(path.join(opts.toolsDir, ".get-runtimes-"));
  try {
    for (const p of missing) {
      const s = SOURCES.find((x) => x.id === p.id)!;
      await download(fetchImpl, s.url, path.join(tmp, s.file), (received, total) => emit({ message: `Downloading ${s.name}`, received, total }), opts.signal);
    }
    const script = path.join(tmp, "install-runtimes.cmd");
    await writeFile(script, prerequisiteScript(missing.map((p) => p.id), tmp));
    emit({ message: `Installing ${missing.map((p) => p.name).join(", ")}. Accept Windows' permission prompt.` });
    await (opts.elevated ?? runElevated)(script);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const after = await check();
  const still = after.filter((p) => !p.installed);
  emit({ message: still.length ? `Still missing: ${still.map((p) => p.name).join(", ")} (a restart may finish it)` : "TeknoParrot's runtimes are installed" });
  return after;
}
