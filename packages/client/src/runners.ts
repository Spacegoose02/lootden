import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { downloadFile } from "./downloader.js";

const run = promisify(execFile);
const RELEASES = "https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=8";

/** A Proton-GE build on GitHub. */
export interface RunnerRelease {
  name: string;
  publishedAt: string;
  url: string;
  size: number;
  /** The .sha512sum file next to it. */
  checksumUrl: string | null;
}

/** How a Windows game starts on Linux: Proton (a runner folder), plain Wine, or nothing chosen. */
export type RunnerChoice = string;
export const WINE = "wine";

export async function listRunnerReleases(fetchImpl: typeof fetch = fetch): Promise<RunnerRelease[]> {
  const res = await fetchImpl(RELEASES, { headers: { accept: "application/vnd.github+json", "user-agent": "LootDen" } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for Proton-GE's releases`);
  const list = (await res.json()) as Array<{ tag_name: string; published_at: string; draft?: boolean; prerelease?: boolean; assets: Array<{ name: string; browser_download_url: string; size: number }> }>;
  return list
    .filter((r) => !r.draft && !r.prerelease)
    .flatMap((r) => {
      const tar = r.assets.find((a) => /\.tar\.gz$/.test(a.name));
      if (!tar) return [];
      const sum = r.assets.find((a) => /\.sha512sum$/.test(a.name));
      return [{ name: r.tag_name, publishedAt: r.published_at, url: tar.browser_download_url, size: tar.size, checksumUrl: sum?.browser_download_url ?? null }];
    });
}

export const runnersDir = (toolsDir: string) => path.join(toolsDir, "runners");
export const prefixDir = (toolsDir: string, gameId: string) => path.join(toolsDir, "prefixes", gameId.replace(/[^\w.-]+/g, "_").slice(0, 80));

/** Proton builds installed for LootDen (folders holding a `proton` script), newest name first. */
export async function installedRunners(toolsDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(runnersDir(toolsDir), { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && (await stat(path.join(runnersDir(toolsDir), e.name, "proton")).then(() => true, () => false))) out.push(e.name);
  }
  return out.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

async function sha512(file: string): Promise<string> {
  const h = createHash("sha512");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/**
 * Downloads a Proton-GE release into the tools folder, checks it against its published SHA-512
 * and unpacks it. Answers the runner's name.
 */
export async function installRunner(
  toolsDir: string,
  release: RunnerRelease,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; onProgress?: (received: number, total: number) => void; untar?: (archive: string, into: string) => Promise<void> } = {},
): Promise<string> {
  const dir = runnersDir(toolsDir);
  await mkdir(dir, { recursive: true });
  const archive = path.join(dir, `${release.name}.tar.gz`);
  await downloadFile({ url: release.url, headers: { "user-agent": "LootDen" }, dest: archive, expectedSize: release.size, signal: opts.signal, onProgress: opts.onProgress });
  try {
    if (release.checksumUrl) {
      const res = await (opts.fetchImpl ?? fetch)(release.checksumUrl, { headers: { "user-agent": "LootDen" } });
      if (!res.ok) throw new Error(`Couldn't get ${release.name}'s checksum (${res.status})`);
      const want = (await res.text()).trim().split(/\s+/)[0]?.toLowerCase();
      if (!want || want !== (await sha512(archive))) throw new Error(`${release.name} didn't match its published SHA-512, so it wasn't installed`);
    }
    await (opts.untar ?? ((a, into) => run("tar", ["-xzf", a, "-C", into]).then(() => undefined)))(archive, dir);
  } finally {
    await rm(archive, { force: true });
  }
  if (!(await installedRunners(toolsDir)).includes(release.name)) throw new Error(`${release.name} unpacked, but has no proton script`);
  return release.name;
}

export interface RunnerCommand {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The command that starts a Windows .exe on Linux: through a Proton build with the game's own
 * prefix (like Heroic and Lutris), or Wine with its own prefix.
 */
export function runnerCommand(toolsDir: string, runner: RunnerChoice, gameId: string, exe: string, steamDir?: string | null): RunnerCommand {
  const prefix = prefixDir(toolsDir, gameId);
  if (!runner || runner === WINE) return { cmd: "wine", args: [exe], env: { WINEPREFIX: prefix } };
  if (!/^[\w.-]+$/.test(runner)) throw new Error("That isn't a runner LootDen installed");
  return {
    cmd: path.join(runnersDir(toolsDir), runner, "proton"),
    args: ["run", exe],
    env: {
      STEAM_COMPAT_DATA_PATH: prefix,
      // Proton wants Steam's folder; any folder works when Steam isn't installed.
      STEAM_COMPAT_CLIENT_INSTALL_PATH: steamDir || prefix,
      SteamGameId: "0",
    },
  };
}

/** Makes the game's prefix folder (Proton fills it on first run). */
export async function preparePrefix(toolsDir: string, gameId: string): Promise<string> {
  const p = prefixDir(toolsDir, gameId);
  await mkdir(p, { recursive: true });
  return p;
}
