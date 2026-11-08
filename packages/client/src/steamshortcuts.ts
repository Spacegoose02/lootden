import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { steamRoots } from "./stores/steam.js";

/**
 * Steam's shortcuts.vdf: its binary KeyValues format. Maps (0x00), strings (0x01) and 32-bit
 * ints (0x02), each with a NUL-terminated name, a map ending with 0x08.
 */
export type BinVdf = { [key: string]: string | number | BinVdf };

export function parseBinaryVdf(buf: Buffer): BinVdf {
  let i = 0;
  const cstr = () => {
    const end = buf.indexOf(0, i);
    if (end < 0) throw new Error("shortcuts.vdf is cut off");
    const s = buf.toString("utf8", i, end);
    i = end + 1;
    return s;
  };
  const map = (): BinVdf => {
    const out: BinVdf = {};
    while (i < buf.length) {
      const type = buf[i++];
      if (type === 0x08) return out;
      const key = cstr();
      if (type === 0x00) out[key] = map();
      else if (type === 0x01) out[key] = cstr();
      else if (type === 0x02) {
        out[key] = buf.readInt32LE(i);
        i += 4;
      } else throw new Error(`shortcuts.vdf has an unknown field type ${type}`);
    }
    return out;
  };
  return map();
}

export function writeBinaryVdf(v: BinVdf): Buffer {
  const parts: Buffer[] = [];
  const cstr = (s: string) => parts.push(Buffer.from(s, "utf8"), Buffer.from([0]));
  const map = (m: BinVdf) => {
    for (const [k, val] of Object.entries(m)) {
      if (typeof val === "number") {
        parts.push(Buffer.from([0x02]));
        cstr(k);
        const b = Buffer.alloc(4);
        b.writeInt32LE(val | 0);
        parts.push(b);
      } else if (typeof val === "string") {
        parts.push(Buffer.from([0x01]));
        cstr(k);
        cstr(val);
      } else {
        parts.push(Buffer.from([0x00]));
        cstr(k);
        map(val);
      }
    }
    parts.push(Buffer.from([0x08]));
  };
  map(v);
  return Buffer.concat(parts);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(s: string): number {
  let c = 0xffffffff;
  for (const b of Buffer.from(s, "utf8")) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The id Steam gives a non-Steam shortcut (what its grid art files are named after). */
export function shortcutAppId(exe: string, name: string): number {
  return (crc32(exe + name) | 0x80000000) >>> 0;
}

export interface SteamUser {
  /** userdata/<id> */
  dir: string;
  id: string;
}

/** Steam accounts that have signed in on this PC. */
export async function steamUsers(roots?: string[]): Promise<SteamUser[]> {
  const out: SteamUser[] = [];
  const seen = new Set<string>();
  for (const root of roots ?? (await steamRoots(process.platform))) {
    for (const e of await readdir(path.join(root, "userdata"), { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || !/^\d+$/.test(e.name) || e.name === "0" || seen.has(e.name)) continue;
      seen.add(e.name);
      out.push({ id: e.name, dir: path.join(root, "userdata", e.name) });
    }
  }
  return out;
}

/** A picture's bytes and whether it's a PNG or a JPEG (Steam goes by the file name's extension). */
export interface Picture {
  data: Buffer;
  ext: "png" | "jpg";
}

export interface SteamShortcut {
  gameId: string;
  title: string;
  /** The LootDen app, which starts the game through lootden://play/<id>. */
  appPath: string;
  /** Picture files to use: portrait cover, wide header, hero background, logo. */
  art?: { cover?: Picture; wide?: Picture; hero?: Picture; logo?: Picture };
}

const TAG = "LootDen";
const quote = (p: string) => `"${p}"`;

async function readShortcuts(file: string): Promise<BinVdf> {
  try {
    return parseBinaryVdf(await readFile(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { shortcuts: {} };
    throw err;
  }
}

/** LootDen games already in this account's Steam library, by LootDen id. */
export async function listSteamShortcuts(user: SteamUser): Promise<Map<string, number>> {
  const v = await readShortcuts(path.join(user.dir, "config", "shortcuts.vdf"));
  const out = new Map<string, number>();
  for (const s of Object.values((v.shortcuts as BinVdf) ?? {})) {
    if (typeof s !== "object") continue;
    const id = /lootden:\/\/play\/([\w-]+)/.exec(String(s.LaunchOptions ?? ""))?.[1];
    if (id) out.set(id, Number(s.appid) >>> 0);
  }
  return out;
}

/**
 * Adds (or updates) LootDen games as non-Steam games with their artwork, so they show in Big
 * Picture and the Steam Deck's Game Mode. Steam reads the file when it starts, so it needs a
 * restart to show them. Answers how many were added or changed.
 */
export async function addSteamShortcuts(user: SteamUser, games: SteamShortcut[]): Promise<number> {
  const config = path.join(user.dir, "config");
  await mkdir(path.join(config, "grid"), { recursive: true });
  const file = path.join(config, "shortcuts.vdf");
  const v = await readShortcuts(file);
  const list = Object.values((v.shortcuts as BinVdf) ?? {}).filter((s): s is BinVdf => typeof s === "object");
  let changed = 0;
  for (const g of games) {
    const exe = quote(g.appPath);
    const appid = shortcutAppId(exe, g.title);
    const entry: BinVdf = {
      appid: appid | 0,
      AppName: g.title,
      Exe: exe,
      StartDir: quote(path.dirname(g.appPath)),
      icon: "",
      ShortcutPath: "",
      LaunchOptions: `lootden://play/${g.gameId}`,
      IsHidden: 0,
      AllowDesktopConfig: 1,
      AllowOverlay: 1,
      OpenVR: 0,
      Devkit: 0,
      DevkitGameID: "",
      DevkitOverrideAppID: 0,
      LastPlayTime: 0,
      FlatpakAppID: "",
      tags: { "0": TAG },
    };
    const at = list.findIndex((s) => String(s.LaunchOptions ?? "").includes(`lootden://play/${g.gameId}`));
    if (at >= 0) list[at] = { ...list[at], ...entry, LastPlayTime: list[at]!.LastPlayTime ?? 0 };
    else list.push(entry);
    changed++;
    const art = g.art ?? {};
    const write = async (stem: string, pic?: Picture) => {
      if (!pic) return;
      for (const ext of ["png", "jpg"]) await rm(path.join(config, "grid", `${stem}.${ext}`), { force: true });
      await writeFile(path.join(config, "grid", `${stem}.${pic.ext}`), pic.data);
    };
    await write(`${appid}p`, art.cover);
    await write(`${appid}`, art.wide);
    await write(`${appid}_hero`, art.hero);
    await write(`${appid}_logo`, art.logo);
  }
  const shortcuts: BinVdf = {};
  list.forEach((s, n) => (shortcuts[String(n)] = s));
  await writeFile(file, writeBinaryVdf({ ...v, shortcuts }));
  return changed;
}

/** Takes LootDen games back out of Steam (all of them, or the ones given). */
export async function removeSteamShortcuts(user: SteamUser, gameIds?: string[]): Promise<number> {
  const config = path.join(user.dir, "config");
  const file = path.join(config, "shortcuts.vdf");
  const v = await readShortcuts(file);
  const list = Object.values((v.shortcuts as BinVdf) ?? {}).filter((s): s is BinVdf => typeof s === "object");
  const ours = (s: BinVdf) => {
    const id = /lootden:\/\/play\/([\w-]+)/.exec(String(s.LaunchOptions ?? ""))?.[1];
    return !!id && (!gameIds || gameIds.includes(id));
  };
  const gone = list.filter(ours);
  for (const s of gone) {
    const appid = Number(s.appid) >>> 0;
    for (const suffix of ["p", "", "_hero", "_logo"]) for (const ext of ["png", "jpg"]) await rm(path.join(config, "grid", `${appid}${suffix}.${ext}`), { force: true });
  }
  const shortcuts: BinVdf = {};
  list.filter((s) => !ours(s)).forEach((s, n) => (shortcuts[String(n)] = s));
  if (gone.length) await writeFile(file, writeBinaryVdf({ ...v, shortcuts }));
  return gone.length;
}
