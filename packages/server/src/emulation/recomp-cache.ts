import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pickRecompAsset, sha256FromDigest, type RecompArch, type RecompInfo, type RecompOs } from "@lootden/shared";
import type { FetchLike } from "../metadata/http.js";

/** How long a release list from GitHub is trusted before asking again. */
const RELEASES_FRESH_MS = 60 * 60 * 1000;
/** Recomp releases are a few hundred MB at most; anything bigger isn't one. */
const MAX_BYTES = 4 * 1024 * 1024 * 1024;

export interface CachedRelease {
  version: string;
  fileName: string;
  sha256: string | null;
  /** Already on the server: PCs get it at LAN speed. */
  cached: boolean;
}

interface Latest {
  version: string;
  fileName: string;
  url: string;
  sha256: string | null;
}

/**
 * Recomp downloads, fetched from the developer's GitHub once and kept on the server, so every PC in the
 * house installs and updates from here instead of each going to GitHub. Files are checked against
 * GitHub's SHA-256 on the way in; only the newest version of each recomp is kept.
 */
export class RecompCache {
  readonly dir: string;
  private readonly lists = new Map<string, { at: number; latest: Latest }>();
  private readonly fetching = new Map<string, Promise<string>>();

  constructor(
    dataDir: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.dir = path.join(dataDir, "recomp-cache");
  }

  /** The newest full release with a file for that kind of PC. */
  private async latest(info: RecompInfo, os: RecompOs, arch: RecompArch): Promise<Latest> {
    const key = `${info.repo}|${os}|${arch}`;
    const hit = this.lists.get(key);
    if (hit && Date.now() - hit.at < RELEASES_FRESH_MS) return hit.latest;
    const res = await this.fetchImpl(`https://api.github.com/repos/${info.repo}/releases?per_page=15`, { headers: { "User-Agent": "LootDen", Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${info.repo}`);
    const releases = (await res.json()) as Array<{ tag_name: string; prerelease: boolean; draft: boolean; assets: Array<{ name: string; browser_download_url: string; digest?: string | null }> }>;
    for (const r of releases) {
      if (r.draft || r.prerelease) continue;
      const name = pickRecompAsset(r.assets.map((a) => a.name), os, arch);
      const asset = name ? r.assets.find((a) => a.name === name) : undefined;
      if (!asset) continue;
      const latest = { version: r.tag_name, fileName: asset.name, url: asset.browser_download_url, sha256: sha256FromDigest(asset.digest) };
      this.lists.set(key, { at: Date.now(), latest });
      return latest;
    }
    throw new Error(`No download for that computer in ${info.repo}'s releases`);
  }

  private where(info: RecompInfo, latest: Latest): string {
    // Tags and file names come from GitHub: keep them to one plain folder and file name.
    const safe = (s: string) => s.replace(/[^\w.+-]+/g, "_").replace(/^\.+/, "_").slice(0, 120);
    return path.join(this.dir, safe(info.id), safe(latest.version), safe(latest.fileName));
  }

  async release(info: RecompInfo, os: RecompOs, arch: RecompArch): Promise<CachedRelease> {
    const latest = await this.latest(info, os, arch);
    const cached = await stat(this.where(info, latest)).then((s) => s.isFile(), () => false);
    return { version: latest.version, fileName: latest.fileName, sha256: latest.sha256, cached };
  }

  /** The release file on the server's disk, downloading and checking it first when it isn't there yet. */
  async file(info: RecompInfo, os: RecompOs, arch: RecompArch): Promise<{ path: string; release: CachedRelease }> {
    const latest = await this.latest(info, os, arch);
    const target = this.where(info, latest);
    const release = { version: latest.version, fileName: latest.fileName, sha256: latest.sha256, cached: true };
    if (await stat(target).then((s) => s.isFile(), () => false)) return { path: target, release };
    // Two PCs asking at once share one download.
    let job = this.fetching.get(target);
    if (!job) {
      job = this.download(info, latest, target).finally(() => this.fetching.delete(target));
      this.fetching.set(target, job);
    }
    return { path: await job, release };
  }

  private async download(info: RecompInfo, latest: Latest, target: string): Promise<string> {
    await mkdir(path.dirname(target), { recursive: true });
    const part = `${target}.part`;
    const res = await this.fetchImpl(latest.url, { headers: { "User-Agent": "LootDen" }, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`Downloading ${latest.fileName} failed with ${res.status}`);
    const hash = createHash("sha256");
    let size = 0;
    const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => {
      size += chunk.length;
      hash.update(chunk);
      if (size > MAX_BYTES) body.destroy(new Error(`${latest.fileName} is bigger than a recomp should be`));
    });
    try {
      await pipeline(body, createWriteStream(part));
      const sum = hash.digest("hex");
      if (latest.sha256 && sum !== latest.sha256) throw new Error(`${latest.fileName} doesn't match the checksum GitHub has for it`);
      await writeFile(`${target}.sha256`, sum);
      await rename(part, target);
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
    // Older versions of this recomp aren't needed any more.
    const versions = path.dirname(path.dirname(target));
    for (const v of await readdir(versions).catch(() => [] as string[])) {
      if (v !== path.basename(path.dirname(target))) await rm(path.join(versions, v), { recursive: true, force: true });
    }
    return target;
  }

  /** The checksum the server worked out when it downloaded the file. */
  async sha256Of(file: string): Promise<string> {
    const kept = await readFile(`${file}.sha256`, "utf8").catch(() => null);
    if (kept && /^[0-9a-f]{64}$/.test(kept.trim())) return kept.trim();
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  }
}
