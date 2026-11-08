import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { GameDetail, GameFile, RomCheck, RomCheckProgress, RomDat, RomFileCheck, RomStatus } from "@lootden/shared";
import { resolveGameFile } from "../catalog/scanner.js";
import { now, type Db } from "../db/database.js";

/** DATs are XML of a few MB; Redump's biggest are about 30 MB. */
export const MAX_DAT_BYTES = 64 * 1024 ** 2;

/** Files that are never the game itself. */
const SKIP = /\.(txt|nfo|md|pdf|jpe?g|png|gif|webp|sfv|md5|sha1|dat|xml|url|ini|cfg|m3u|lootden-[\w.-]+)$/i;
/** Packed files LootDen can't look inside without unpacking. */
const OPAQUE = /\.(7z|rar|chd|rvz|wia|cso|zso|gcz|wbfs|nsz|xcz|pbp)$/i;

// ---- CRC-32 ------------------------------------------------------------------------

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

class Crc32 {
  private c = 0xffffffff;
  update(buf: Uint8Array): this {
    let c = this.c;
    for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
    this.c = c;
    return this;
  }
  hex(): string {
    return ((this.c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
  }
}

// ---- DAT files ---------------------------------------------------------------------

export interface ParsedDat {
  name: string;
  version: string | null;
  roms: Array<{ game: string; rom: string; size: number; crc: string | null; sha1: string | null }>;
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescape(m[1]!) : null;
};

/** Reads a Logiqx XML DAT, the format No-Intro (DAT-o-MATIC) and Redump both publish. */
export function parseDat(xml: string): ParsedDat {
  const header = /<header>([\s\S]*?)<\/header>/.exec(xml)?.[1] ?? "";
  const field = (n: string) => {
    const v = new RegExp(`<${n}>([^<]*)</${n}>`).exec(header)?.[1];
    return v ? unescape(v.trim()) : null;
  };
  const name = field("name") ?? field("description");
  if (!name) throw new Error("That doesn't look like a No-Intro or Redump DAT (no header name)");
  const roms: ParsedDat["roms"] = [];
  const games = /<(?:game|machine)\s[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/(?:game|machine)>/g;
  for (let g = games.exec(xml); g; g = games.exec(xml)) {
    for (const r of g[2]!.match(/<rom\s[^>]*>/g) ?? []) {
      const sha1 = attr(r, "sha1")?.toLowerCase() ?? null;
      const crc = attr(r, "crc")?.toLowerCase().padStart(8, "0") ?? null;
      if (!sha1 && !crc) continue;
      roms.push({ game: unescape(g[1]!), rom: attr(r, "name") ?? "", size: Number(attr(r, "size") ?? 0), crc, sha1 });
    }
  }
  if (!roms.length) throw new Error("That DAT has no ROMs with checksums in it");
  return { name, version: field("version"), roms };
}

// ---- Hashing -----------------------------------------------------------------------

export interface FileHashes {
  size: number;
  sha1: string;
  crc: string;
  /** The same without a copier or iNES header, which No-Intro's DATs leave out. */
  headerless?: { size: number; sha1: string; crc: string };
}

/** How many leading bytes are a header No-Intro doesn't count: iNES/FDS, Lynx, Atari 7800, or a 512-byte SNES copier header. */
export function headerBytes(name: string, size: number, first: Buffer): number {
  if (first.subarray(0, 4).toString("latin1") === "NES\x1a") return 16;
  if (first.subarray(0, 4).toString("latin1") === "FDS\x1a") return 16;
  if (first.subarray(0, 4).toString("latin1") === "LYNX") return 64;
  if (first.subarray(1, 10).toString("latin1") === "ATARI7800") return 128;
  if (/\.(smc|sfc|swc|fig)$/i.test(name) && size % 1024 === 512) return 512;
  return 0;
}

export async function hashFile(file: string, name = file): Promise<FileHashes> {
  const fh = await open(file, "r");
  const first = Buffer.alloc(128);
  let size: number;
  try {
    size = (await fh.stat()).size;
    await fh.read(first, 0, 128, 0);
  } finally {
    await fh.close();
  }
  const skip = headerBytes(name, size, first);
  const full = { sha1: createHash("sha1"), crc: new Crc32() };
  const bare = skip ? { sha1: createHash("sha1"), crc: new Crc32() } : null;
  let pos = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) {
    full.sha1.update(chunk);
    full.crc.update(chunk);
    if (bare && pos + chunk.length > skip) {
      const part = pos >= skip ? chunk : chunk.subarray(skip - pos);
      bare.sha1.update(part);
      bare.crc.update(part);
    }
    pos += chunk.length;
  }
  return {
    size,
    sha1: full.sha1.digest("hex"),
    crc: full.crc.hex(),
    ...(bare ? { headerless: { size: size - skip, sha1: bare.sha1.digest("hex"), crc: bare.crc.hex() } } : {}),
  };
}

/** A zip's entries with the CRC-32 and size its central directory records, so zipped ROMs need no unpacking. */
export async function zipEntries(file: string): Promise<Array<{ name: string; crc: string; size: number }>> {
  const fh = await open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Not a zip file");
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff) return []; // ZIP64: not worth it for ROM sets
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out: Array<{ name: string; crc: string; size: number }> = [];
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
      const nameLen = cd.readUInt16LE(p + 28);
      const extra = cd.readUInt16LE(p + 30);
      const comment = cd.readUInt16LE(p + 32);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      if (!name.endsWith("/")) out.push({ name, crc: cd.readUInt32LE(p + 16).toString(16).padStart(8, "0"), size: cd.readUInt32LE(p + 24) });
      p += 46 + nameLen + extra + comment;
    }
    return out;
  } finally {
    await fh.close();
  }
}

// ---- The checker -------------------------------------------------------------------

interface DatRow {
  id: number;
  name: string;
  version: string | null;
  games: number;
  roms: number;
  uploaded_at: string;
}
interface CheckRow {
  game_id: string;
  status: RomStatus;
  matched: string | null;
  dat: string | null;
  files: string;
  stamp: string;
  checked_at: string;
}
interface Match {
  game: string;
  dat: string;
}

const toDat = (r: DatRow): RomDat => ({ id: r.id, name: r.name, version: r.version, games: r.games, roms: r.roms, uploadedAt: r.uploaded_at });
const toCheck = (r: CheckRow): RomCheck => ({ gameId: r.game_id, status: r.status, matched: r.matched, dat: r.dat, files: JSON.parse(r.files) as RomFileCheck[], checkedAt: r.checked_at });
const stampOf = (files: GameFile[]) => files.map((f) => `${f.path}:${f.size}:${f.modifiedAt}`).join("|");

/**
 * Checks emulated games' ROMs and disc images against No-Intro and Redump DATs an admin
 * uploads, the way RomVault and clrmamepro do: a match means a known good, unmodified dump.
 */
export class RomChecker {
  private progress: RomCheckProgress = { running: false, done: 0, total: 0, current: null };

  constructor(
    private readonly db: Db,
    private readonly gamesDir: () => string,
  ) {}

  dats(): RomDat[] {
    return (this.db.prepare("SELECT d.*, (SELECT count(DISTINCT game) FROM rom_dat_roms WHERE dat_id = d.id) AS games, (SELECT count(*) FROM rom_dat_roms WHERE dat_id = d.id) AS roms FROM rom_dats d ORDER BY name").all() as unknown as DatRow[]).map(toDat);
  }

  /** Adds a DAT, replacing an older one of the same name. Old results are checked again next time. */
  addDat(xml: string): RomDat {
    const dat = parseDat(xml);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM rom_dats WHERE name = ?").run(dat.name);
      const { lastInsertRowid } = this.db.prepare("INSERT INTO rom_dats (name, version, uploaded_at) VALUES (?, ?, ?)").run(dat.name, dat.version, now());
      const add = this.db.prepare("INSERT INTO rom_dat_roms (dat_id, game, rom, size, crc, sha1) VALUES (?, ?, ?, ?, ?, ?)");
      for (const r of dat.roms) add.run(lastInsertRowid, r.game, r.rom, r.size, r.crc, r.sha1);
      // Games that didn't match before might now.
      this.db.exec("UPDATE rom_checks SET stamp = '' WHERE status != 'verified'");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.dats().find((d) => d.name === dat.name)!;
  }

  removeDat(id: number): boolean {
    const gone = this.db.prepare("DELETE FROM rom_dats WHERE id = ?").run(id).changes > 0;
    if (gone) this.db.exec("UPDATE rom_checks SET stamp = ''");
    return gone;
  }

  result(gameId: string): RomCheck | null {
    const row = this.db.prepare("SELECT * FROM rom_checks WHERE game_id = ?").get(gameId) as CheckRow | undefined;
    return row ? toCheck(row) : null;
  }

  results(): Map<string, RomCheck> {
    return new Map((this.db.prepare("SELECT * FROM rom_checks").all() as unknown as CheckRow[]).map((r) => [r.game_id, toCheck(r)]));
  }

  status(): RomCheckProgress {
    return { ...this.progress };
  }

  private bySha1(sha1: string): Match | null {
    return (this.db.prepare("SELECT r.game, d.name AS dat FROM rom_dat_roms r JOIN rom_dats d ON d.id = r.dat_id WHERE r.sha1 = ? LIMIT 1").get(sha1) as Match | undefined) ?? null;
  }

  private byCrc(crc: string, size: number): Match | null {
    return (this.db.prepare("SELECT r.game, d.name AS dat FROM rom_dat_roms r JOIN rom_dats d ON d.id = r.dat_id WHERE r.crc = ? AND r.size = ? LIMIT 1").get(crc, size) as Match | undefined) ?? null;
  }

  /** Checks one game's files. Skips the hashing when nothing changed since the last check, unless forced. */
  async check(game: GameDetail, force = false): Promise<RomCheck> {
    const stamp = stampOf(game.files);
    const old = this.db.prepare("SELECT * FROM rom_checks WHERE game_id = ?").get(game.id) as CheckRow | undefined;
    if (old && !force && old.stamp === stamp) return toCheck(old);

    const files: RomFileCheck[] = [];
    const matches: Match[] = [];
    let opaque = 0;
    for (const f of game.files) {
      if (SKIP.test(f.path)) continue;
      if (OPAQUE.test(f.path)) {
        opaque++;
        continue;
      }
      const full = resolveGameFile(this.gamesDir(), game, f);
      if (/\.zip$/i.test(f.path)) {
        const entries = await zipEntries(full).catch(() => []);
        for (const e of entries) {
          const m = this.byCrc(e.crc, e.size);
          if (m) matches.push(m);
          files.push({ path: `${f.path}/${e.name}`, match: m?.game ?? null, sha1: null });
        }
        continue;
      }
      const h = await hashFile(full, f.path);
      const m = this.bySha1(h.sha1) ?? (h.headerless ? this.bySha1(h.headerless.sha1) : null) ?? this.byCrc(h.crc, h.size) ?? (h.headerless ? this.byCrc(h.headerless.crc, h.headerless.size) : null);
      if (m) matches.push(m);
      files.push({ path: f.path, match: m?.game ?? null, sha1: h.sha1 });
    }
    const hits = files.filter((f) => f.match).length;
    const status: RomStatus = !files.length ? (opaque ? "unchecked" : "unknown") : hits === files.length && !opaque ? "verified" : hits ? "partial" : opaque ? "unchecked" : "unknown";
    const best = matches[0] ?? null;
    const row: CheckRow = { game_id: game.id, status, matched: best?.game ?? null, dat: best?.dat ?? null, files: JSON.stringify(files), stamp, checked_at: now() };
    this.db
      .prepare(
        `INSERT INTO rom_checks (game_id, status, matched, dat, files, stamp, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_id) DO UPDATE SET status = excluded.status, matched = excluded.matched, dat = excluded.dat, files = excluded.files, stamp = excluded.stamp, checked_at = excluded.checked_at`,
      )
      .run(row.game_id, row.status, row.matched, row.dat, row.files, row.stamp, row.checked_at);
    return toCheck(row);
  }

  /** Checks every emulated game in the background, one at a time. */
  checkAll(games: GameDetail[]): RomCheckProgress {
    if (this.progress.running) return this.status();
    const list = games.filter((g) => g.platform !== "pc" && g.kind === "game");
    this.progress = { running: true, done: 0, total: list.length, current: null };
    void (async () => {
      for (const g of list) {
        this.progress.current = g.title;
        await this.check(g).catch(() => null);
        this.progress.done++;
      }
      this.progress = { ...this.progress, running: false, current: null };
    })();
    return this.status();
  }
}
