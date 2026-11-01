import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recompInfo, type RecompInfo, type RecompMods } from "@lootden/shared";
import { download, listFiles, readTools, writeTools } from "./emulators.js";
import { extractArchive, type SevenZip } from "./extractor.js";
import { readRecompManifest, recompDir } from "./recomps.js";

// Mods for recomps from Thunderstore (thunderstore.io/c/<community>), the way Zelda 64: Recompiled
// and its family share them. Installing puts a mod's files (.nrm mods, .rtz texture packs and the
// native library for this system) in the recomp's mods folder and remembers them, so they can be
// taken out again.

type Fetch = typeof fetch;

export interface ModPackage {
  /** Owner-Name: the package's id on Thunderstore. */
  full: string;
  name: string;
  owner: string;
  description: string;
  icon: string;
  version: string;
  url: string;
  page: string;
  downloads: number;
  rating: number;
  /** Owner-Name of the mods it needs. */
  deps: string[];
}

export interface InstalledMod {
  full: string;
  name: string;
  version: string;
  files: string[];
  /** Put in because another mod needed it. */
  dep: boolean;
}

const lists = new Map<string, { at: number; list: ModPackage[] }>();
const LIST_FRESH_MS = 30 * 60 * 1000;

/** Reads Thunderstore's package list for a community: newest version of each, no deprecated or NSFW ones. */
export function parseThunderstore(input: unknown): ModPackage[] {
  const out: ModPackage[] = [];
  for (const p of Array.isArray(input) ? input : []) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (o.is_deprecated === true || o.has_nsfw_content === true) continue;
    const versions = Array.isArray(o.versions) ? (o.versions as Array<Record<string, unknown>>) : [];
    const v = versions[0];
    if (!v || typeof o.full_name !== "string" || typeof v.download_url !== "string") continue;
    const str = (x: unknown) => (typeof x === "string" ? x : "");
    out.push({
      full: o.full_name,
      name: str(o.name).replace(/_/g, " "),
      owner: str(o.owner),
      description: str(v.description),
      icon: str(v.icon),
      version: str(v.version_number),
      url: v.download_url,
      page: str(o.package_url),
      downloads: versions.reduce((n, x) => n + (typeof x.downloads === "number" ? x.downloads : 0), 0),
      rating: typeof o.rating_score === "number" ? o.rating_score : 0,
      // "Owner-Name-1.2.3" -> "Owner-Name"
      deps: (Array.isArray(v.dependencies) ? v.dependencies : []).filter((d): d is string => typeof d === "string").map((d) => d.replace(/-\d+\.\d+\.\d+$/, "")),
    });
  }
  return out.sort((a, b) => b.rating - a.rating || b.downloads - a.downloads);
}

export async function listThunderstore(community: string, fetchImpl: Fetch = fetch): Promise<ModPackage[]> {
  if (!/^[\w.-]{1,80}$/.test(community)) throw new Error("That isn't a mod community");
  const hit = lists.get(community);
  if (hit && Date.now() - hit.at < LIST_FRESH_MS) return hit.list;
  const res = await fetchImpl(`https://thunderstore.io/c/${community}/api/v1/package/`, { headers: { "User-Agent": "LootDen" } });
  if (!res.ok) throw new Error(`Thunderstore answered ${res.status}`);
  const list = parseThunderstore(await res.json());
  lists.set(community, { at: Date.now(), list });
  return list;
}

/** The files of a mod that go in the mods folder: mods, texture packs, and the library for this system. */
export function wantedModFile(name: string, platform: NodeJS.Platform = process.platform): boolean {
  const n = name.toLowerCase();
  return n.endsWith(".nrm") || n.endsWith(".rtz") || n.endsWith(platform === "win32" ? ".dll" : platform === "darwin" ? ".dylib" : ".so");
}

export interface RecompModOptions {
  toolsDir: string;
  sevenZip: SevenZip;
  added?: RecompInfo[];
  fetchImpl?: Fetch;
  platform?: NodeJS.Platform;
}

async function setup(recompId: string, opts: { toolsDir: string; added?: RecompInfo[] }): Promise<{ source: RecompMods | null; modsDir: string; name: string }> {
  const tools = await readTools(opts.toolsDir);
  const state = tools.recomps[recompId];
  if (!state) throw new Error("Set up the recomp first (Emulation, then Recomps)");
  const info = recompInfo(recompId, opts.added ?? []) ?? state.info;
  const manifest = await readRecompManifest(recompDir(opts.toolsDir, recompId));
  // LootDen runs recomps portable (portable.txt beside the program), so their mods folder is there too.
  return { source: manifest?.mods ?? info?.mods ?? null, modsDir: path.join(path.dirname(path.join(opts.toolsDir, state.exe)), "mods"), name: info?.name ?? recompId };
}

/** The recomp's Thunderstore mods and the ones installed here; null when it has no mod community. */
export async function recompMods(recompId: string, opts: { toolsDir: string; added?: RecompInfo[]; fetchImpl?: Fetch }): Promise<{ community: string; available: ModPackage[]; installed: InstalledMod[]; others: string[] } | null> {
  const { source, modsDir } = await setup(recompId, opts);
  if (!source) return null;
  const installed = (await readTools(opts.toolsDir)).recomps[recompId]?.mods ?? [];
  const mine = new Set(installed.flatMap((m) => m.files));
  // Mods put in by hand, shown so they aren't a surprise.
  const others = (await readdir(modsDir).catch(() => [] as string[])).filter((f) => !f.startsWith(".") && !mine.has(f));
  return { community: source.thunderstore, available: await listThunderstore(source.thunderstore, opts.fetchImpl), installed, others };
}

/** Installs a mod (and the mods it needs) into the recomp's mods folder. */
export async function installRecompMod(recompId: string, full: string, opts: RecompModOptions): Promise<InstalledMod[]> {
  const { source, modsDir } = await setup(recompId, opts);
  if (!source) throw new Error("This recomp has no mods LootDen can install");
  const list = await listThunderstore(source.thunderstore, opts.fetchImpl);
  const byName = new Map(list.map((p) => [p.full, p]));
  const wanted = byName.get(full);
  if (!wanted) throw new Error("That mod isn't on Thunderstore any more");

  // The mod itself last, after what it needs; anything already here is left as it is.
  const tools = await readTools(opts.toolsDir);
  const have = new Set((tools.recomps[recompId]!.mods ?? []).map((m) => m.full));
  const order: ModPackage[] = [];
  const visit = (p: ModPackage, depth: number) => {
    if (depth > 10 || order.includes(p)) return;
    for (const d of p.deps) {
      const dep = byName.get(d);
      if (dep && !have.has(dep.full)) visit(dep, depth + 1);
    }
    order.push(p);
  };
  visit(wanted, 0);

  const added: InstalledMod[] = [];
  await mkdir(modsDir, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "lootden-mod-"));
  try {
    for (const p of order) {
      const zip = path.join(tmp, `${p.full}.zip`);
      await download(opts.fetchImpl ?? fetch, p.url, zip);
      const out = path.join(tmp, p.full);
      await extractArchive(opts.sevenZip, "zip", zip, out);
      const files: string[] = [];
      for (const rel of await listFiles(out)) {
        const name = path.posix.basename(rel);
        if (!wantedModFile(name, opts.platform)) continue;
        await copyFile(path.join(out, ...rel.split("/")), path.join(modsDir, name));
        files.push(name);
      }
      if (!files.length && p === wanted) throw new Error(`${p.name} has no files the game reads by itself. Its page says how to set it up: ${p.page}`);
      added.push({ full: p.full, name: p.name, version: p.version, files, dep: p !== wanted });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const t = await readTools(opts.toolsDir);
  const state = t.recomps[recompId]!;
  state.mods = [...(state.mods ?? []).filter((m) => !added.some((a) => a.full === m.full)), ...added];
  await writeTools(opts.toolsDir, t);
  return state.mods;
}

/** Takes a mod's files out of the mods folder. */
export async function removeRecompMod(recompId: string, full: string, opts: { toolsDir: string; added?: RecompInfo[] }): Promise<InstalledMod[]> {
  const { modsDir } = await setup(recompId, opts);
  const t = await readTools(opts.toolsDir);
  const state = t.recomps[recompId]!;
  const mod = state.mods?.find((m) => m.full === full);
  if (!mod) throw new Error("That mod isn't installed");
  for (const f of mod.files) {
    if (f.includes("/") || f.includes("\\") || f === ".." || f === ".") continue;
    // Another installed mod can share a file name (a library); only take it when nothing else uses it.
    if (state.mods!.some((m) => m.full !== full && m.files.includes(f))) continue;
    if (await stat(path.join(modsDir, f)).catch(() => null)) await rm(path.join(modsDir, f), { force: true });
  }
  state.mods = state.mods!.filter((m) => m.full !== full);
  await writeTools(opts.toolsDir, t);
  return state.mods;
}
