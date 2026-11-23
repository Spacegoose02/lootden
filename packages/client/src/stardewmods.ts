import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isSmapiBundled, parseSmapiManifest, type LocalStardewMod, type StardewMod, type StardewSyncResult } from "@lootden/shared";

/**
 * Stardew Valley's Mods folder on this PC, made to match the household's shared mod set.
 * LootDen keeps a list of the folders it put there (.lootden-stardew.json); a mod is switched
 * off by putting a dot in front of its folder's name, which SMAPI skips, so nothing a person
 * put there is ever deleted.
 */

export const STARDEW_TRACKING_FILE = ".lootden-stardew.json";
const INCOMING = ".lootden-incoming-";

interface Tracked {
  sharedId: number;
  /** The folder in Mods, without the dot it gets when switched off. */
  folder: string;
  /** The shared mod's updatedAt when it was installed; a newer one is an update. */
  updatedAt: string;
  uniqueIds: string[];
}

/** Files in the game's folder that only Stardew Valley has. */
const MARKERS = ["Stardew Valley.dll", "Stardew Valley.exe", "StardewValley.exe", "StardewModdingAPI.exe", "StardewModdingAPI", "StardewValley", "Stardew Valley.deps.json"];

/** The game's folder: home, or a folder up to two down from it, with Stardew Valley's own files. */
export async function findStardewDir(home: string): Promise<string | null> {
  const has = (dir: string) => MARKERS.some((m) => existsSync(path.join(dir, m)));
  if (has(home)) return home;
  let level = [home];
  for (let depth = 0; depth < 2; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (has(full)) return full;
        next.push(full);
      }
    }
    level = next.slice(0, 200);
  }
  return null;
}

/** Where Steam and GOG put the game when nobody moved it. */
export function stardewDefaultDirs(platform: NodeJS.Platform = process.platform, home = os.homedir()): string[] {
  if (platform === "win32") {
    return [
      "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Stardew Valley",
      "C:\\Program Files\\Steam\\steamapps\\common\\Stardew Valley",
      "C:\\Program Files (x86)\\GOG Galaxy\\Games\\Stardew Valley",
      "C:\\GOG Games\\Stardew Valley",
    ];
  }
  if (platform === "darwin") return [path.join(home, "Library", "Application Support", "Steam", "steamapps", "common", "Stardew Valley", "Contents", "MacOS")];
  return [
    path.join(home, ".local", "share", "Steam", "steamapps", "common", "Stardew Valley"),
    path.join(home, ".steam", "steam", "steamapps", "common", "Stardew Valley"),
    path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam", "steamapps", "common", "Stardew Valley"),
    path.join(home, "GOG Games", "Stardew Valley", "game"),
  ];
}

async function readTracked(modsDir: string): Promise<Tracked[]> {
  const raw = await readFile(path.join(modsDir, STARDEW_TRACKING_FILE), "utf8").catch(() => "");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { mods?: Tracked[] };
    return (parsed.mods ?? []).filter((t) => t && Number.isInteger(t.sharedId) && typeof t.folder === "string" && t.folder === path.basename(t.folder) && !t.folder.startsWith("."));
  } catch {
    return [];
  }
}

async function writeTracked(modsDir: string, mods: Tracked[]): Promise<void> {
  const file = path.join(modsDir, STARDEW_TRACKING_FILE);
  await writeFile(`${file}.tmp`, JSON.stringify({ mods }, null, 2));
  await rename(`${file}.tmp`, file);
}

const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false;

/** The manifests under a folder, stopping at the first one down each path (as SMAPI does). */
async function manifestsIn(dir: string, rel: string, depth: number, out: Array<{ rel: string; text: string }>): Promise<void> {
  if (depth > 5) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const manifest = entries.find((e) => e.isFile() && e.name.toLowerCase() === "manifest.json");
  if (manifest) {
    const text = await readFile(path.join(dir, manifest.name), "utf8").catch(() => "");
    if (text) out.push({ rel, text });
    return;
  }
  for (const e of entries) if (e.isDirectory()) await manifestsIn(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1, out);
}

/** Every SMAPI mod in the Mods folder, switched on or off, and which shared mod LootDen installed it from. */
export async function scanStardewMods(modsDir: string): Promise<LocalStardewMod[]> {
  const tracked = await readTracked(modsDir);
  const owner = new Map(tracked.map((t) => [t.folder.toLowerCase(), t.sharedId]));
  const found: Array<{ rel: string; text: string }> = [];
  for (const e of await readdir(modsDir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith(INCOMING)) continue;
    await manifestsIn(path.join(modsDir, e.name), e.name, 1, found);
  }
  const out: LocalStardewMod[] = [];
  for (const f of found) {
    const m = parseSmapiManifest(f.text, f.rel);
    if (!m) continue;
    const top = f.rel.split("/")[0]!;
    out.push({
      uniqueId: m.uniqueId,
      name: m.name,
      version: m.version,
      path: f.rel,
      enabled: !f.rel.split("/").some((s) => s.startsWith(".")),
      sharedId: owner.get(top.replace(/^\.+/, "").toLowerCase()) ?? null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** A free ".<name>" (or ".<name> (2)") to switch a folder off as. */
function offName(modsDir: string, name: string): string {
  let candidate = `.${name}`;
  for (let i = 2; existsSync(path.join(modsDir, candidate)); i++) candidate = `.${name} (${i})`;
  return candidate;
}

/** Every config.json under a folder (relative paths): settings people changed, kept through updates. */
async function configsIn(dir: string, rel = "", depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 5) return out;
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) await configsIn(dir, r, depth + 1, out);
    else if (e.isFile() && e.name.toLowerCase() === "config.json") out.push(r);
  }
  return out;
}

/** The folder in an unpacked zip that goes into Mods: its only folder, else the whole thing (as the server decides). */
async function unpackedRoot(dir: string): Promise<string> {
  await rm(path.join(dir, "__MACOSX"), { recursive: true, force: true });
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.length === 1 && entries[0]!.isDirectory() ? path.join(dir, entries[0]!.name) : dir;
}

export interface StardewSyncDeps {
  /** Fetches a shared mod's zip to dest. */
  download: (mod: StardewMod, dest: string) => Promise<void>;
  /** Unpacks a zip into a folder. */
  extract: (zip: string, outDir: string) => Promise<void>;
  /** Also switch off mods put there by hand that aren't on in the set, so every PC loads the same mods. */
  strict: boolean;
  onProgress?: (line: string) => void;
}

/**
 * Makes the Mods folder match the shared set: mods switched on there are added or updated
 * (keeping their config.json), mods switched off or deleted there are switched off here, and
 * with strict, other mods on here are switched off too. Copies of a shared mod put there by
 * hand are switched off so SMAPI doesn't find two of one mod. SMAPI's own mods are left alone.
 */
export async function syncStardewMods(modsDir: string, set: StardewMod[], deps: StardewSyncDeps): Promise<StardewSyncResult> {
  await mkdir(modsDir, { recursive: true });
  const result: StardewSyncResult = { folder: modsDir, added: [], updated: [], switchedOn: [], switchedOff: [], extrasOff: [], failed: [] };
  let tracked = await readTracked(modsDir);
  const at = (name: string) => path.join(modsDir, name);
  const switchOff = async (name: string) => {
    await rename(at(name), at(offName(modsDir, name)));
  };
  // Leftovers from a sync that stopped half way.
  for (const e of await readdir(modsDir).catch(() => [] as string[])) if (e.startsWith(INCOMING)) await rm(at(e), { recursive: true, force: true });

  for (const mod of set) {
    const t = tracked.find((x) => x.sharedId === mod.id);
    const ids = new Set(mod.mods.map((m) => m.uniqueId.toLowerCase()));
    if (!mod.enabled) {
      if (t && (await isDir(at(t.folder)))) {
        await switchOff(t.folder);
        result.switchedOff.push(mod.title);
      }
      continue;
    }
    const current = t ? ((await isDir(at(t.folder))) ? t.folder : (await isDir(at(`.${t.folder}`))) ? `.${t.folder}` : null) : null;
    if (t && current && t.updatedAt === mod.updatedAt && t.folder === mod.folder) {
      if (current.startsWith(".")) {
        if (await isDir(at(mod.folder))) await switchOff(mod.folder);
        await rename(at(current), at(mod.folder));
        result.switchedOn.push(mod.title);
      }
      continue;
    }
    let work: string | null = null;
    try {
      deps.onProgress?.(`Getting ${mod.title}…`);
      work = await mkdtemp(path.join(os.tmpdir(), "lootden-stardew-"));
      const zip = path.join(work, "mod.zip");
      await deps.download(mod, zip);
      const unpacked = path.join(work, "unpacked");
      await mkdir(unpacked);
      await deps.extract(zip, unpacked);
      const src = await unpackedRoot(unpacked);
      // Into a folder beside the others first, so a failure leaves the old version as it was.
      const incoming = at(`${INCOMING}${mod.id}`);
      await cp(src, incoming, { recursive: true });
      if (current) {
        for (const c of await configsIn(at(current))) {
          if (existsSync(path.join(incoming, c))) continue;
          await mkdir(path.dirname(path.join(incoming, c)), { recursive: true });
          await cp(path.join(at(current), c), path.join(incoming, c));
        }
        await rm(at(current), { recursive: true, force: true });
      }
      // The same mods put there by hand (or a folder already using the name) are switched off.
      for (const local of await scanStardewMods(modsDir)) {
        const top = local.path.split("/")[0]!;
        if (local.enabled && local.sharedId === null && ids.has(local.uniqueId.toLowerCase()) && (await isDir(at(top)))) {
          await switchOff(top);
          result.switchedOff.push(`${local.name} (put there by hand; the shared copy replaces it)`);
        }
      }
      if (await isDir(at(mod.folder))) await switchOff(mod.folder);
      await rename(incoming, at(mod.folder));
      (t ? result.updated : result.added).push(mod.title);
      tracked = [...tracked.filter((x) => x.sharedId !== mod.id), { sharedId: mod.id, folder: mod.folder, updatedAt: mod.updatedAt, uniqueIds: mod.mods.map((m) => m.uniqueId) }];
      await writeTracked(modsDir, tracked);
    } catch (err) {
      await rm(at(`${INCOMING}${mod.id}`), { recursive: true, force: true }).catch(() => {});
      result.failed.push({ name: mod.title, error: (err as Error).message });
    } finally {
      if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Mods deleted from the set: switched off here, and no longer LootDen's.
  const inSet = new Set(set.map((m) => m.id));
  for (const t of tracked.filter((x) => !inSet.has(x.sharedId))) {
    if (await isDir(at(t.folder))) {
      await switchOff(t.folder);
      result.switchedOff.push(t.folder);
    }
  }
  tracked = tracked.filter((x) => inSet.has(x.sharedId));
  await writeTracked(modsDir, tracked);

  if (deps.strict) {
    const want = new Set(set.filter((m) => m.enabled).flatMap((m) => m.mods.map((x) => x.uniqueId.toLowerCase())));
    const byTop = new Map<string, LocalStardewMod[]>();
    for (const m of await scanStardewMods(modsDir)) {
      if (!m.enabled || m.sharedId !== null) continue;
      const top = m.path.split("/")[0]!;
      byTop.set(top, [...(byTop.get(top) ?? []), m]);
    }
    for (const [top, mods] of byTop) {
      if (mods.some((m) => isSmapiBundled(m.uniqueId) || want.has(m.uniqueId.toLowerCase()))) continue;
      await switchOff(top);
      result.extrasOff.push(mods.map((m) => m.name).join(", "));
    }
  }
  return result;
}
