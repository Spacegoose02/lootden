import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Db } from "../db/database.js";
import type { FetchLike } from "../metadata/http.js";

const RELEASE_KEY = "clients.release";

/** The GitHub release the hosted files came from, so newer ones can be fetched by themselves. */
export interface ReleaseSource {
  repo: string;
  tag: string;
  fetchedAt: string;
  checkedAt: string | null;
}

export interface ClientFile {
  name: string;
  size: number;
  modifiedAt: string;
  platform: "windows" | "linux" | "android" | "playnite" | "other";
  /** What the file is, in words for the downloads page. */
  kind: string;
}

const ALLOWED = /\.(exe|msi|appimage|deb|rpm|apk|zip|7z|tar\.gz|pext)$|^(gm|lootden)(-cli)?(-linux|-win)?[\w.-]*$/i;

/** Names the app and plugin files the release workflow produces; anything else is "Other". */
export function describe(name: string): Pick<ClientFile, "platform" | "kind"> {
  const n = name.toLowerCase();
  if (n.endsWith(".pext") || n.includes("playnite")) return { platform: "playnite", kind: "Playnite plugin" };
  // ARM builds are for Linux handhelds (Armada OS, ROCKNIX); everything else is a normal x64 PC.
  const arm = /(arm64|aarch64)/.test(n) ? ", ARM" : "";
  if (n.endsWith(".appimage")) return { platform: "linux", kind: `Desktop app (AppImage${arm})` };
  if (n.endsWith(".deb")) return { platform: "linux", kind: `Desktop app (Debian/Ubuntu package${arm})` };
  if (n.endsWith(".rpm")) return { platform: "linux", kind: "Desktop app (Fedora package)" };
  if (n.endsWith(".apk")) return { platform: "android", kind: "Android app" };
  // The CLI: lootden(.exe) and lootden-cli-*, or gm from before the rename.
  if (/^(gm|lootden)(\.exe)?$/.test(n) || /^(gm|lootden-cli)[-_]/.test(n)) {
    return { platform: n.includes("win") || n.endsWith(".exe") ? "windows" : "linux", kind: `Command-line client${arm ? " (ARM)" : ""}` };
  }
  if (n.endsWith(".exe") || n.endsWith(".msi")) return { platform: "windows", kind: n.includes("setup") ? "Desktop app (installer)" : "Desktop app" };
  return { platform: "other", kind: "Download" };
}

/**
 * The desktop app, CLI and Playnite plugin, hosted by the server so players can grab
 * them from the web UI. Files live in <data>/clients: drop them in, upload them from
 * the admin page, or fetch the latest GitHub release.
 */
export class ClientDownloads {
  readonly dir: string;

  constructor(
    dataDir: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly db: Db | null = null,
  ) {
    this.dir = path.join(dataDir, "clients");
  }

  /** Rejects names that could escape the folder or aren't app files. */
  static checkName(name: string): string {
    const base = path.basename(name);
    if (base !== name || base.startsWith(".") || !ALLOWED.test(base)) {
      throw new Error("Only app files can be hosted: .exe, .msi, .AppImage, .deb, .rpm, .apk, .zip, .7z, .tar.gz, .pext or the gm binary");
    }
    return base;
  }

  async list(): Promise<ClientFile[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const out: ClientFile[] = [];
    for (const name of names) {
      if (name.startsWith(".") || name.endsWith(".part")) continue;
      const s = await stat(path.join(this.dir, name)).catch(() => null);
      if (!s?.isFile()) continue;
      out.push({ name, size: s.size, modifiedAt: s.mtime.toISOString(), ...describe(name) });
    }
    const order = { windows: 0, linux: 1, android: 2, playnite: 3, other: 4 };
    // Per platform, the desktop app comes before the command-line client and other files.
    const rank = (f: ClientFile) => (f.kind.startsWith("Desktop") ? 0 : 1);
    return out.sort((a, b) => order[a.platform] - order[b.platform] || rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  path(name: string): string {
    return path.join(this.dir, ClientDownloads.checkName(name));
  }

  async save(name: string, body: Readable): Promise<ClientFile> {
    const file = this.path(name);
    await mkdir(this.dir, { recursive: true });
    await pipeline(body, createWriteStream(`${file}.part`));
    await rename(`${file}.part`, file);
    const s = await stat(file);
    return { name: path.basename(file), size: s.size, modifiedAt: s.mtime.toISOString(), ...describe(path.basename(file)) };
  }

  async remove(name: string): Promise<void> {
    await rm(this.path(name), { force: true });
  }

  /**
   * Downloads the assets of a GitHub repository's latest release (e.g. "you/lootden"),
   * replacing files with the same name. Returns what was fetched.
   */
  async fetchRelease(repo: string): Promise<{ tag: string; files: string[] }> {
    const release = await this.latest(repo);
    const files: string[] = [];
    for (const asset of release.assets) {
      let name: string;
      try {
        name = ClientDownloads.checkName(asset.name);
      } catch {
        continue;
      }
      const dl = await this.fetchImpl(asset.browser_download_url, { headers: { "User-Agent": "lootden" } });
      if (!dl.ok || !dl.body) throw new Error(`Downloading ${asset.name} failed (${dl.status})`);
      await this.save(name, Readable.fromWeb(dl.body as import("node:stream/web").ReadableStream));
      files.push(name);
    }
    if (!files.length) throw new Error(`Release ${release.tag_name} has no app files attached`);
    const at = new Date().toISOString();
    this.remember({ repo, tag: release.tag_name, fetchedAt: at, checkedAt: at });
    return { tag: release.tag_name, files };
  }

  private async latest(repo: string): Promise<{ tag_name: string; assets: Array<{ name: string; browser_download_url: string }> }> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Enter the repository as "owner/name"');
    const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "lootden" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) throw new Error(`${repo} has no published release (or the repository is private)`);
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return (await res.json()) as { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
  }

  /** The release the files came from, when an admin fetched one. */
  source(): ReleaseSource | null {
    const row = this.db?.prepare("SELECT value FROM settings WHERE key = ?").get(RELEASE_KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as ReleaseSource;
    } catch {
      return null;
    }
  }

  private remember(r: ReleaseSource): void {
    this.db?.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(RELEASE_KEY, JSON.stringify(r));
  }

  /**
   * Once an admin has fetched a release, newer ones are fetched by themselves, so the desktop
   * apps (which update from this server) pick them up. Returns the new tag, or null.
   */
  async refresh(): Promise<string | null> {
    const src = this.source();
    if (!src) return null;
    const release = await this.latest(src.repo);
    if (release.tag_name === src.tag) {
      this.remember({ ...src, checkedAt: new Date().toISOString() });
      return null;
    }
    return (await this.fetchRelease(src.repo)).tag;
  }
}
