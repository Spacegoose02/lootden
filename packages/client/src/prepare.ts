import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { safeFolderName, type GameDetail } from "@lootden/shared";
import type { GameServerClient } from "./api.js";
import { extractArchive, type SevenZip } from "./extractor.js";
import { installGame, LEGACY_MANIFEST_NAME, MANIFEST_NAME, type InstallEvent } from "./installer.js";

export type PrepareStep =
  | { step: "download"; event: InstallEvent }
  | { step: "unpack-disc"; file: string }
  | { step: "install"; setup: string; target: string }
  /** Zipping: bytes and files done so far out of the folder's total (absent on the first step). */
  | { step: "zip"; folder: string; done?: number; total?: number; files?: number; totalFiles?: number; current?: string }
  | { step: "upload"; bytes: number; sent?: number }
  | { step: "done"; game: GameDetail };

export interface PrepareOptions {
  /** Scratch folder with room for the download, the installed game and its zip. Deleted afterwards. */
  workDir: string;
  sevenZip: SevenZip;
  version?: string;
  onStep?: (s: PrepareStep) => void;
  /** Stops zipping or uploading. */
  signal?: AbortSignal;
  /** Runs the setup program and resolves when it closes. The desktop app shows it to the user. */
  runInstaller: (setup: string, target: string, args: string[]) => Promise<void>;
  /**
   * Asks the user where the game ended up (installers don't always honour the folder we ask
   * for). Resolve with the folder to upload, or null to cancel.
   */
  confirmInstalled: (suggested: string) => Promise<string | null>;
}

async function walk(dir: string, depth: number, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) await walk(p, depth - 1, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** The setup program of a disc or installer: autorun.inf's choice, else setup/install*.exe nearest the top. */
export async function findSetup(dir: string): Promise<string | null> {
  const files = await walk(dir, 2);
  const autorun = files.find((f) => path.basename(f).toLowerCase() === "autorun.inf");
  if (autorun) {
    const open = (await readFile(autorun, "latin1")).match(/^\s*open\s*=\s*"?([^"\r\n]+?\.exe)/im)?.[1];
    const target = open ? files.find((f) => path.relative(path.dirname(autorun), f).toLowerCase() === open.replace(/\\/g, "/").toLowerCase().replace(/\//g, path.sep)) : undefined;
    if (target) return target;
  }
  const setups = files
    .filter((f) => /^(setup|install(er)?)[^\\/]*\.exe$/i.test(path.basename(f)))
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || path.basename(a).length - path.basename(b).length);
  return setups[0] ?? null;
}

/** Silent-ish arguments that point common installer types at our folder. */
export async function installerArgs(setup: string, target: string): Promise<string[]> {
  const head = (await readFile(setup).catch(() => Buffer.alloc(0))).subarray(0, 4 * 1024 * 1024).toString("latin1");
  if (head.includes("Inno Setup")) return [`/DIR=${target}`, "/NOICONS"];
  if (head.includes("Nullsoft")) return [`/D=${target}`];
  return [];
}

export interface ZipProgress {
  /** Bytes read from the folder so far, and in all. */
  done: number;
  total: number;
  /** Files zipped so far, and in all. */
  files: number;
  totalFiles: number;
  /** The file 7-Zip is on. */
  current?: string;
}

const ZIP_SKIP_ANYWHERE = ".lootden-backup";

/** The files zipFolder takes from a folder, and their size. */
export async function measureFolder(folder: string, top = true): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  for (const e of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (e.name === ZIP_SKIP_ANYWHERE || (top && (e.name === MANIFEST_NAME || e.name === LEGACY_MANIFEST_NAME))) continue;
    const p = path.join(folder, e.name);
    if (e.isDirectory()) {
      const sub = await measureFolder(p, false);
      bytes += sub.bytes;
      files += sub.files;
    } else if (e.isFile()) {
      bytes += await stat(p).then((x) => x.size, () => 0);
      files++;
    }
  }
  return { bytes, files };
}

/**
 * Reads 7-Zip's progress output (-bsp1): "  12% 345 + Data\\file.pak", redrawn in place with
 * backspaces. Returns the latest percent, files done and file name in a chunk, if any.
 */
export function parseSevenZipProgress(chunk: string): { percent: number; files?: number; current?: string } | null {
  let found: { percent: number; files?: number; current?: string } | null = null;
  for (const part of chunk.split(/[\b\r\n]+/)) {
    const m = part.match(/^\s*(\d{1,3})%(?:\s+(\d+))?(?:\s+[+U=]\s+(.+?))?\s*$/);
    if (m) found = { percent: Math.min(100, Number(m[1])), files: m[2] ? Number(m[2]) : undefined, current: m[3] || undefined };
  }
  return found;
}

/**
 * Zips a folder's contents with 7-Zip (store-fast: games barely compress). LootDen's own
 * files stay out: update backups, and the install manifest (it names this PC's copy).
 * Reports how far it has got (measured from the folder, paced by 7-Zip's own percent).
 */
export async function zipFolder(sevenZip: SevenZip, folder: string, zipPath: string, opts: { onProgress?: (p: ZipProgress) => void; signal?: AbortSignal } = {}): Promise<void> {
  const size = opts.onProgress ? await measureFolder(folder) : { bytes: 0, files: 0 };
  opts.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(sevenZip.path, ["a", "-tzip", "-mx1", "-bso0", "-bsp1", "-y", zipPath, "*", `-xr!${ZIP_SKIP_ANYWHERE}`, `-x!${MANIFEST_NAME}`, `-x!${LEGACY_MANIFEST_NAME}`], {
      cwd: folder,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let err = "";
    let best = 0;
    let files = 0;
    child.stdout.on("data", (d: Buffer) => {
      const p = parseSevenZipProgress(d.toString());
      if (!p) return;
      // 7-Zip's percent can step back a little; the bar shouldn't.
      best = Math.max(best, p.percent);
      if (p.files !== undefined) files = Math.max(files, Math.min(p.files, size.files));
      opts.onProgress?.({ done: Math.round((best / 100) * size.bytes), total: size.bytes, files, totalFiles: size.files, current: p.current });
    });
    child.stderr.on("data", (d) => (err += d.toString()));
    const abort = () => child.kill();
    opts.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", abort);
      if (opts.signal?.aborted) return reject(new Error("Cancelled"));
      if (code !== 0) return reject(new Error(`7-Zip exited with code ${code}: ${err.trim()}`));
      opts.onProgress?.({ done: size.bytes, total: size.bytes, files: size.files, totalFiles: size.files });
      resolve();
    });
  });
}

/** Zips an already-installed game and uploads it in place of the disc or installer copy. */
export async function uploadInstalledFolder(
  api: GameServerClient,
  gameId: string,
  folder: string,
  opts: Pick<PrepareOptions, "workDir" | "sevenZip" | "version" | "onStep" | "signal"> & { ticket?: string },
): Promise<GameDetail> {
  const s = await stat(folder).catch(() => null);
  if (!s?.isDirectory() || (await readdir(folder)).length === 0) throw new Error(`${folder} is empty or missing`);
  await mkdir(opts.workDir, { recursive: true });
  const zip = path.join(opts.workDir, "upload.zip");
  await rm(zip, { force: true });
  opts.onStep?.({ step: "zip", folder });
  let game: GameDetail;
  try {
    await zipFolder(opts.sevenZip, folder, zip, { signal: opts.signal, onProgress: (p) => opts.onStep?.({ step: "zip", folder, ...p }) });
    opts.onStep?.({ step: "upload", bytes: (await stat(zip)).size });
    game = await api.uploadPrepared(gameId, zip, opts.version, (sent, bytes) => opts.onStep?.({ step: "upload", bytes, sent }), opts.ticket, opts.signal);
  } finally {
    await rm(zip, { force: true }).catch(() => {});
  }
  opts.onStep?.({ step: "done", game });
  return game;
}

/**
 * Option B for disc and installer games: download, unpack the disc, run its installer once,
 * then zip the installed folder and upload it so everyone else gets a normal game.
 */
export async function prepareGame(api: GameServerClient, gameId: string, opts: PrepareOptions): Promise<GameDetail | null> {
  await rm(opts.workDir, { recursive: true, force: true });
  await mkdir(opts.workDir, { recursive: true });
  try {
    const downloaded = await installGame(api, gameId, {
      installDir: path.join(opts.workDir, "download"),
      keepArchives: false,
      sevenZipPath: opts.sevenZip.path,
      report: false,
      signal: opts.signal,
      onEvent: (event) => opts.onStep?.({ step: "download", event }),
    });
    const title = (await api.getGame(gameId)).title;

    let media = downloaded;
    const mounted: string[] = [];
    const images = (await walk(downloaded, 2)).filter((f) => /\.iso$/i.test(f));
    for (const [i, iso] of images.entries()) {
      opts.onStep?.({ step: "unpack-disc", file: path.basename(iso) });
      const out = path.join(opts.workDir, images.length > 1 ? `disc${i + 1}` : "disc");
      try {
        await extractArchive(opts.sevenZip, "zip", iso, out);
        await rm(iso, { force: true });
        if (i === 0) media = out;
      } catch (err) {
        // The bundled 7za can't read ISOs; Windows can mount them itself.
        if (process.platform !== "win32") throw new Error(`Couldn't unpack ${path.basename(iso)}; install full 7-Zip (p7zip-full or 7zip). ${(err as Error).message}`);
        const drive = await mountIso(iso);
        mounted.push(iso);
        if (i === 0) media = drive;
      }
    }
    const setup = await findSetup(media);
    if (!setup) throw new Error(`No setup program found in ${media}. Install it yourself, then use "Upload an installed folder".`);

    const target = path.join(opts.workDir, "installed", safeFolderName(title));
    await mkdir(target, { recursive: true });
    opts.onStep?.({ step: "install", setup, target });
    await opts.runInstaller(setup, target, await installerArgs(setup, target));

    const folder = await opts.confirmInstalled(target);
    for (const iso of mounted) await dismountIso(iso).catch(() => {});
    if (!folder) return null;
    return await uploadInstalledFolder(api, gameId, folder, { ...opts, workDir: path.join(opts.workDir, "zip") });
  } finally {
    await rm(opts.workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function powershell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `PowerShell exited with ${code}`))));
  });
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Mounts an ISO with Windows' built-in support and returns its drive root, like "E:\\". */
async function mountIso(iso: string): Promise<string> {
  const letter = await powershell(`(Mount-DiskImage -ImagePath ${psQuote(iso)} -PassThru | Get-Volume).DriveLetter`);
  if (!/^[A-Z]$/i.test(letter)) throw new Error(`Windows mounted ${path.basename(iso)} but gave no drive letter`);
  return `${letter}:\\`;
}

async function dismountIso(iso: string): Promise<void> {
  await powershell(`Dismount-DiskImage -ImagePath ${psQuote(iso)} | Out-Null`);
}

/**
 * Runs the setup program of a downloaded disc or installer game in place, installing into
 * target (a folder beside the setup files). On Windows ISOs are mounted for the run; elsewhere
 * they're unpacked with 7-Zip. Resolves when the installer closes.
 */
export async function runLocalSetup(
  dir: string,
  target: string,
  opts: { sevenZip: SevenZip; runInstaller: PrepareOptions["runInstaller"]; onStep?: (message: string) => void },
): Promise<void> {
  let media = dir;
  const mounted: string[] = [];
  try {
    const images = (await walk(dir, 2)).filter((f) => /\.iso$/i.test(f));
    if (images.length) {
      const iso = images.sort()[0]!;
      if (process.platform === "win32") {
        opts.onStep?.(`Mounting ${path.basename(iso)}`);
        media = await mountIso(iso);
        mounted.push(iso);
      } else {
        opts.onStep?.(`Unpacking ${path.basename(iso)}`);
        media = path.join(dir, ".disc");
        await extractArchive(opts.sevenZip, "zip", iso, media);
      }
    }
    const setup = await findSetup(media);
    if (!setup) throw new Error(`No setup program found in ${media}. Run it yourself from Open folder.`);
    await mkdir(target, { recursive: true });
    opts.onStep?.("Running the installer. Finish it, then come back here.");
    await opts.runInstaller(setup, target, await installerArgs(setup, target));
  } finally {
    for (const iso of mounted) await dismountIso(iso).catch(() => {});
  }
}
