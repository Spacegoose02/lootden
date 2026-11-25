// Greenlight (github.com/unknownskl/greenlight): an open-source app that streams games from
// your own Xbox console, and the second way LootDen does remote play (the first is Xbox's own
// page in the built-in browser). LootDen downloads it from the project's own releases into the
// tools folder, the way it downloads emulators, and starts it on a console with
// "--fullscreen --connect=<console id>".
//
// Greenlight is an Electron app: on Windows the portable zip is unpacked and run as it is, on
// Linux the AppImage is made runnable. A copy the person installed themselves (a Flatpak, or
// Greenlight in Program Files) is used as it is instead.

import { access, chmod, constants, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { download, emulatorDir, findFile, githubAsset, installedFlatpaks, readTools, writeTools, type ToolsEvent } from "./emulators.js";
import { extractArchive, type SevenZip } from "./extractor.js";

/** The project's releases: the only place LootDen downloads Greenlight from. */
export const GREENLIGHT_REPO = "unknownskl/greenlight";
export const GREENLIGHT_HOME = "https://github.com/unknownskl/greenlight";
/** Greenlight on Flathub, for a Linux PC that already has it. */
export const GREENLIGHT_FLATPAK = "io.github.unknownskl.greenlight";

/** Where LootDen keeps its own copy. */
export const greenlightHome = (toolsDir: string) => emulatorDir(toolsDir, "greenlight");

const EXE = /^(Greenlight\.exe|Greenlight.*\.AppImage)$/i;
/** The portable Windows build (not the installer, which needs a prompt) and the Linux AppImage. */
const ASSET = {
  win32: /^Greenlight-[\d.]+-win\.zip$/i,
  linux: /^Greenlight-[\d.]+\.AppImage$/i,
} as const;

export type GreenlightOs = "win32" | "linux";

const hostGreenlightOs = (): GreenlightOs => (process.platform === "win32" ? "win32" : "linux");

export interface GreenlightOptions {
  toolsDir: string;
  sevenZip: SevenZip;
  fetchImpl?: typeof fetch;
  platform?: GreenlightOs;
  /** Installed Flatpak app ids; asks flatpak itself by default (tests pass their own). */
  flatpaks?: () => Promise<Set<string>>;
  onEvent?: (e: ToolsEvent) => void;
  signal?: AbortSignal;
}

export interface GreenlightState {
  /** What LootDen can do here: macOS has no download in LootDen, so remote play there stays in the browser. */
  supported: boolean;
  /** The program that runs, when there is one: LootDen's own copy, a Flatpak, or one found on this PC. */
  exe: string | null;
  version: string | null;
  /** Whether [exe] is LootDen's own download (it can be updated from here) or the person's own copy. */
  managed: boolean;
}

/** Greenlight as LootDen last set it up, plus a Flatpak or a copy found on this PC. */
export async function greenlightState(opts: { toolsDir: string; platform?: GreenlightOs; flatpaks?: () => Promise<Set<string>> }): Promise<GreenlightState> {
  const platform = opts.platform ?? hostGreenlightOs();
  const supported = process.platform === "win32" || process.platform === "linux";
  const saved = (await readTools(opts.toolsDir)).greenlight;
  if (saved) {
    const exe = path.isAbsolute(saved.exe) ? saved.exe : path.join(opts.toolsDir, saved.exe);
    const there =
      saved.exe.startsWith("flatpak:") ||
      (await access(exe, constants.F_OK).then(
        () => true,
        () => false,
      ));
    if (there)
      return {
        supported,
        exe: saved.exe.startsWith("flatpak:") ? saved.exe : exe,
        version: saved.version,
        managed: !saved.exe.startsWith("flatpak:"),
      };
  }
  if (platform === "linux" && (await (opts.flatpaks ?? installedFlatpaks)()).has(GREENLIGHT_FLATPAK)) {
    return {
      supported,
      exe: `flatpak:${GREENLIGHT_FLATPAK}`,
      version: "Flatpak",
      managed: false,
    };
  }
  const found = await findInstalledGreenlight(platform);
  return { supported, exe: found, version: null, managed: false };
}

/** Greenlight the person installed themselves, in the places its installer puts it. */
async function findInstalledGreenlight(platform: GreenlightOs): Promise<string | null> {
  const home = os.homedir();
  const candidates =
    platform === "win32"
      ? [
          path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs", "greenlight", "Greenlight.exe"),
          path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Greenlight", "Greenlight.exe"),
        ]
      : [path.join(home, "Applications"), path.join(home, "Downloads"), "/opt/greenlight"];
  for (const c of candidates) {
    if (/\.exe$/i.test(c)) {
      if (
        await access(c, constants.F_OK).then(
          () => true,
          () => false,
        )
      )
        return c;
      continue;
    }
    const dir = await stat(c).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!dir) continue;
    const entry = (await readdir(c).catch(() => [])).find((n) => /^Greenlight.*\.AppImage$/i.test(n));
    if (entry) return path.join(c, entry);
  }
  return null;
}

/**
 * Downloads Greenlight into the tools folder, or brings LootDen's copy up to date. On Linux a
 * Flatpak copy is used as it is (Flatpak keeps it up to date) unless LootDen already downloaded
 * its own. Returns the program to run and its version.
 */
export async function installGreenlight(opts: GreenlightOptions): Promise<{ exe: string; version: string }> {
  const platform = opts.platform ?? hostGreenlightOs();
  if (process.platform === "darwin") throw new Error("LootDen doesn't download Greenlight on macOS yet. Remote play in the built-in browser works here, or install Greenlight from its own releases");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const emit = opts.onEvent ?? (() => {});
  const dir = greenlightHome(opts.toolsDir);

  if (platform === "linux") {
    const current = (await readTools(opts.toolsDir)).greenlight;
    if (!current && (await (opts.flatpaks ?? installedFlatpaks)()).has(GREENLIGHT_FLATPAK)) {
      await saveGreenlight(opts.toolsDir, `flatpak:${GREENLIGHT_FLATPAK}`, "Flatpak");
      emit({
        message: `Using Greenlight from Flatpak (${GREENLIGHT_FLATPAK})`,
      });
      return { exe: `flatpak:${GREENLIGHT_FLATPAK}`, version: "Flatpak" };
    }
  }

  emit({ message: "Finding the latest Greenlight" });
  const release = await githubAsset(fetchImpl, GREENLIGHT_REPO, ASSET[platform]);
  await mkdir(dir, { recursive: true });
  const tmp = await mkdtemp(path.join(opts.toolsDir, ".get-greenlight-"));
  try {
    const file = path.join(tmp, release.fileName);
    await download(
      fetchImpl,
      release.url,
      file,
      (received, total) =>
        emit({
          message: `Downloading Greenlight ${release.version}`,
          received,
          total,
        }),
      opts.signal,
    );
    if (/\.AppImage$/i.test(file)) {
      for (const old of await readdir(dir).catch(() => [])) if (/\.AppImage$/i.test(old)) await rm(path.join(dir, old), { force: true });
      await rename(file, path.join(dir, release.fileName));
      await chmod(path.join(dir, release.fileName), 0o755);
    } else {
      emit({ message: "Unpacking Greenlight" });
      // Over the old version: the program is replaced, Greenlight's own settings live elsewhere.
      await extractArchive(opts.sevenZip, "zip", file, dir);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const exe = await findFile(dir, EXE);
  if (!exe) throw new Error("Greenlight downloaded, but its program wasn't in the download");
  await saveGreenlight(opts.toolsDir, path.relative(opts.toolsDir, exe), release.version);
  emit({ message: `Greenlight ${release.version} is ready` });
  return { exe, version: release.version };
}

async function saveGreenlight(toolsDir: string, exe: string, version: string): Promise<void> {
  const tools = await readTools(toolsDir);
  tools.greenlight = { version, exe, installedAt: new Date().toISOString() };
  await writeTools(toolsDir, tools);
}

/** Forgets LootDen's copy (the Settings button that takes it off this PC); the files go too. */
export async function removeGreenlight(toolsDir: string): Promise<void> {
  const tools = await readTools(toolsDir);
  delete tools.greenlight;
  await writeTools(toolsDir, tools);
  await rm(greenlightHome(toolsDir), { recursive: true, force: true });
}

/**
 * The command that starts Greenlight, streaming one console when given its id. Greenlight's own
 * arguments: --fullscreen, and --connect=<console id> for a console (xcloud_<title> for cloud
 * games, which LootDen doesn't use here).
 */
export function greenlightCommand(exe: string, consoleId?: string | null, opts: { fullscreen?: boolean } = {}): { cmd: string; args: string[] } {
  const args: string[] = [];
  if (opts.fullscreen !== false) args.push("--fullscreen");
  if (consoleId) args.push(`--connect=${consoleId.toUpperCase()}`);
  if (exe.startsWith("flatpak:"))
    return {
      cmd: "flatpak",
      args: ["run", exe.slice("flatpak:".length), ...args],
    };
  return { cmd: exe, args };
}
