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

/** The recomp's Thunderstore mods and the ones installed here; null when it has no mods LootDen can install. */
export async function recompMods(
  recompId: string,
  opts: { toolsDir: string; added?: RecompInfo[]; fetchImpl?: Fetch },
): Promise<{ community: string | null; gamebanana: number | null; available: ModPackage[]; installed: InstalledMod[]; others: string[] } | null> {
  const { source, modsDir } = await setup(recompId, opts);
  if (!source) return null;
  const installed = (await readTools(opts.toolsDir)).recomps[recompId]?.mods ?? [];
  const mine = new Set(installed.flatMap((m) => m.files));
  // Mods put in by hand, shown so they aren't a surprise.
  const others = (await readdir(modsDir).catch(() => [] as string[])).filter((f) => !f.startsWith(".") && !mine.has(f));
  return {
    community: source.thunderstore ?? null,
    gamebanana: source.gamebanana ?? null,
    available: source.thunderstore ? await listThunderstore(source.thunderstore, opts.fetchImpl) : [],
    installed,
    others,
  };
}

/** Installs a mod (and the mods it needs) into the recomp's mods folder. */
export async function installRecompMod(recompId: string, full: string, opts: RecompModOptions): Promise<InstalledMod[]> {
  const { source, modsDir } = await setup(recompId, opts);
  if (!source?.thunderstore) throw new Error("This recomp has no Thunderstore mods");
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

// ---- GameBanana ----------------------------------------------------------------------

const GAMEBANANA = "https://gamebanana.com/apiv11";

export interface GameBananaMod {
  id: number;
  name: string;
  owner: string;
  likes: number;
  image: string;
  category: string;
  page: string;
}

/** A page of a game's mods on GameBanana, most liked first, or a search. Mods with content ratings are left out. */
export function parseGameBananaList(input: unknown): GameBananaMod[] {
  const records = (input && typeof input === "object" ? (input as Record<string, unknown>)._aRecords : null) ?? [];
  const out: GameBananaMod[] = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (o._sModelName !== "Mod" || typeof o._idRow !== "number" || typeof o._sName !== "string" || o._bHasContentRatings === true) continue;
    const media = (o._aPreviewMedia as { _aImages?: Array<Record<string, string>> } | undefined)?._aImages?.[0];
    out.push({
      id: o._idRow,
      name: o._sName,
      owner: String((o._aSubmitter as Record<string, unknown> | undefined)?._sName ?? ""),
      likes: typeof o._nLikeCount === "number" ? o._nLikeCount : 0,
      image: media?._sBaseUrl && (media._sFile530 || media._sFile) ? `${media._sBaseUrl}/${media._sFile530 || media._sFile}` : "",
      category: String((o._aRootCategory as Record<string, unknown> | undefined)?._sName ?? ""),
      page: `https://gamebanana.com/mods/${o._idRow}`,
    });
  }
  return out;
}

export async function listGameBanana(game: number, query: string, fetchImpl: Fetch = fetch): Promise<GameBananaMod[]> {
  const q = query.trim().slice(0, 60);
  const url = q
    ? `${GAMEBANANA}/Util/Search/Results?_sModelName=Mod&_sSearchString=${encodeURIComponent(q)}&_idGameRow=${game}&_nPage=1`
    : `${GAMEBANANA}/Mod/Index?_nPerpage=30&_aFilters[Generic_Game]=${game}&_sSort=Generic_MostLiked&_nPage=1`;
  const res = await fetchImpl(url, { headers: { "User-Agent": "LootDen" } });
  if (!res.ok) throw new Error(`GameBanana answered ${res.status}`);
  return parseGameBananaList(await res.json());
}

/** The recomp's GameBanana mods (most liked, or a search); empty when it has none there. */
export async function recompGameBanana(recompId: string, query: string, opts: { toolsDir: string; added?: RecompInfo[]; fetchImpl?: Fetch }): Promise<GameBananaMod[]> {
  const { source } = await setup(recompId, opts);
  return source?.gamebanana ? listGameBanana(source.gamebanana, query, opts.fetchImpl) : [];
}

/** A mod's files that LootDen may install: passed GameBanana's virus scan, and an archive it can open. */
export function gameBananaFiles(input: unknown, rar: boolean): Array<{ id: number; name: string; size: number }> {
  const files = (input && typeof input === "object" ? (input as Record<string, unknown>)._aFiles : null) ?? [];
  return (Array.isArray(files) ? files : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .filter((f) => typeof f._idRow === "number" && typeof f._sFile === "string" && f._sAvResult === "clean" && (rar ? /\.(zip|7z|rar)$/i : /\.(zip|7z)$/i).test(f._sFile))
    .map((f) => ({ id: f._idRow as number, name: f._sFile as string, size: typeof f._nFilesize === "number" ? f._nFilesize : 0 }));
}

/** The files of a GameBanana mod that go in the mods folder, for how the game reads them. */
export function wantedGameBananaFile(name: string, loader: "nrm" | "otr", platform: NodeJS.Platform = process.platform): boolean {
  return loader === "otr" ? /\.(otr|o2r)$/i.test(name) : wantedModFile(name, platform);
}

/** Installs a GameBanana mod: its first clean archive, unpacked into the recomp's mods folder. */
export async function installGameBananaMod(recompId: string, modId: number, opts: RecompModOptions): Promise<InstalledMod[]> {
  const { source, modsDir } = await setup(recompId, opts);
  if (!source?.gamebanana || !source.loader) throw new Error("This recomp has no GameBanana mods LootDen can install");
  if (!Number.isInteger(modId) || modId <= 0) throw new Error("Unknown mod");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${GAMEBANANA}/Mod/${modId}/ProfilePage`, { headers: { "User-Agent": "LootDen" } });
  if (!res.ok) throw new Error(`GameBanana answered ${res.status}`);
  const profile = (await res.json()) as Record<string, unknown>;
  const name = typeof profile._sName === "string" ? profile._sName : `Mod ${modId}`;
  const file = gameBananaFiles(profile, opts.sevenZip.supportsRar)[0];
  if (!file) throw new Error(`${name} has no file LootDen can install (it needs a virus-scanned zip or 7z). Get it from https://gamebanana.com/mods/${modId}`);
  await mkdir(modsDir, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "lootden-gb-"));
  const files: string[] = [];
  try {
    const archive = path.join(tmp, file.name.replace(/[^\w.-]+/g, "_"));
    await download(fetchImpl, `https://gamebanana.com/dl/${file.id}`, archive);
    const out = path.join(tmp, "out");
    await extractArchive(opts.sevenZip, /\.zip$/i.test(file.name) ? "zip" : /\.rar$/i.test(file.name) ? "rar" : "7z", archive, out);
    for (const rel of await listFiles(out)) {
      const base = path.posix.basename(rel);
      if (!wantedGameBananaFile(base, source.loader, opts.platform)) continue;
      await copyFile(path.join(out, ...rel.split("/")), path.join(modsDir, base));
      files.push(base);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  if (!files.length) throw new Error(`${name} has no files the game reads by itself. Its page says how to set it up: https://gamebanana.com/mods/${modId}`);
  const t = await readTools(opts.toolsDir);
  const state = t.recomps[recompId]!;
  const full = `gamebanana:${modId}`;
  state.mods = [...(state.mods ?? []).filter((m) => m.full !== full), { full, name, version: file.name, files, dep: false }];
  await writeTools(opts.toolsDir, t);
  return state.mods;
}
