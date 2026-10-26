import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { createInflateRaw } from "node:zlib";
import type { AgeRating, Platform } from "@lootden/shared";
import type { FetchLike } from "./http.js";
import type { Candidate, MetadataProvider, ProviderResult } from "./types.js";

export const LAUNCHBOX_ZIP = "https://gamesdb.launchbox-app.com/Metadata.zip";
const IMAGES = "https://images.launchbox-app.com/";
const REFRESH_DAYS = 30;

/** LaunchBox platform names for LootDen's platforms. */
const PLATFORMS: Record<string, string> = {
  pc: "Windows", nes: "Nintendo Entertainment System", snes: "Super Nintendo Entertainment System", n64: "Nintendo 64",
  gb: "Nintendo Game Boy", gbc: "Nintendo Game Boy Color", gba: "Nintendo Game Boy Advance", nds: "Nintendo DS",
  gamecube: "Nintendo GameCube", wii: "Nintendo Wii", genesis: "Sega Genesis", saturn: "Sega Saturn", dreamcast: "Sega Dreamcast",
  ps1: "Sony Playstation", ps2: "Sony Playstation 2", ps3: "Sony Playstation 3", psp: "Sony PSP", xbox: "Microsoft Xbox",
};
const COVER_TYPES = ["Box - Front", "Box - Front - Reconstructed", "Fanart - Box - Front"];
const SHOT_TYPES = ["Screenshot - Gameplay", "Screenshot - Game Title", "Fanart - Background"];
const REGION_RANK = ["", "North America", "United States", "World", "Europe", "United Kingdom", "Japan"];

const SCHEMA = `
  CREATE TABLE games (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT, year INTEGER, release_date TEXT, overview TEXT,
    genres TEXT, rating REAL, max_players INTEGER, cooperative INTEGER, esrb TEXT);
  CREATE TABLE names (game_id TEXT NOT NULL, norm TEXT NOT NULL);
  CREATE TABLE images (game_id TEXT NOT NULL, type TEXT NOT NULL, region TEXT, file TEXT NOT NULL);
  CREATE TABLE info (key TEXT PRIMARY KEY, value TEXT);
`;
const INDEXES = `
  CREATE INDEX names_game ON names (game_id);
  CREATE INDEX images_game ON images (game_id);
  CREATE INDEX games_platform ON games (platform);
`;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );

/** Lower-case words without punctuation, for LIKE searches: "Sonic the Hedgehog 2" -> "sonic the hedgehog 2". */
export const normName = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

/**
 * LaunchBox Games Database. It has no search API, so the whole database (a ~100 MB zip,
 * refreshed monthly) is downloaded and indexed into a local SQLite file under the data folder.
 */
export class LaunchBoxProvider implements MetadataProvider {
  readonly name = "launchbox";
  private db: DatabaseSync | null = null;
  private building: Promise<void> | null = null;
  lastError: string | null = null;

  constructor(
    readonly enabled: boolean,
    private readonly dir: string,
    private readonly log: Log,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private get file(): string {
    return path.join(this.dir, "launchbox.db");
  }

  /** Opens the local copy, starting a download when it is missing or a month old. */
  private async open(): Promise<DatabaseSync | null> {
    if (!this.db) {
      const s = await stat(this.file).catch(() => null);
      if (s) this.db = new DatabaseSync(this.file, { readOnly: true });
      if (!s || Date.now() - s.mtimeMs > REFRESH_DAYS * 86400_000) void this.refresh().catch(() => {});
    }
    return this.db;
  }

  /** Downloads and indexes the database; concurrent calls share one download. */
  refresh(): Promise<void> {
    if (!this.building) {
      this.building = this.build()
        .then(() => {
          this.lastError = null;
        })
        .catch((err: Error) => {
          this.lastError = err.message;
          this.log.warn({ err: err.message }, "LaunchBox database download failed");
          throw err;
        })
        .finally(() => {
          this.building = null;
        });
    }
    return this.building;
  }

  get downloading(): boolean {
    return !!this.building;
  }

  /** Number of games in the local copy, or null before the first download finishes. */
  async count(): Promise<number | null> {
    const db = await this.open();
    return db ? (db.prepare("SELECT COUNT(*) AS n FROM games").get() as { n: number }).n : null;
  }

  private async build(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const zip = path.join(this.dir, "Metadata.zip");
    this.log.info({ url: LAUNCHBOX_ZIP }, "Downloading the LaunchBox games database");
    const res = await this.fetchImpl(LAUNCHBOX_ZIP, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`gamesdb.launchbox-app.com answered ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(`${zip}.tmp`));
    await rename(`${zip}.tmp`, zip);

    const tmp = `${this.file}.tmp`;
    await rm(tmp, { force: true });
    const db = new DatabaseSync(tmp);
    try {
      db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
      db.exec(SCHEMA);
      const games = await indexXml(await zipEntry(zip, "Metadata.xml"), db);
      db.exec(INDEXES);
      db.prepare("INSERT INTO info (key, value) VALUES ('built_at', ?)").run(new Date().toISOString());
      this.log.info({ games }, "LaunchBox games database ready");
    } finally {
      db.close();
    }
    this.db?.close();
    this.db = null;
    await rename(tmp, this.file);
    await rm(zip, { force: true });
  }

  async search(query: string, platform?: Platform): Promise<Candidate[]> {
    const db = await this.open();
    if (!db) return [];
    const words = normName(query).split(" ").filter((w) => w.length > 1 || /\d/.test(w)).slice(0, 6);
    if (!words.length) return [];
    const lbPlatform = PLATFORMS[platform?.id ?? "pc"] ?? platform?.name ?? "Windows";
    const rows = db
      .prepare(
        `SELECT DISTINCT g.id, g.name, g.year FROM names n JOIN games g ON g.id = n.game_id
         WHERE g.platform = ? ${words.map(() => "AND (' ' || n.norm || ' ') LIKE ?").join(" ")} LIMIT 20`,
      )
      .all(lbPlatform, ...words.map((w) => `% ${w} %`)) as Array<{ id: string; name: string; year: number | null }>;
    return rows.map((r) => ({ provider: this.name, providerId: r.id, name: r.name, year: r.year, coverUrl: this.images(db, r.id, COVER_TYPES)[0] ?? null }));
  }

  private images(db: DatabaseSync, id: string, types: string[]): string[] {
    const rows = db.prepare("SELECT type, region, file FROM images WHERE game_id = ?").all(id) as Array<{ type: string; region: string | null; file: string }>;
    const rank = (r: string | null) => {
      const i = REGION_RANK.indexOf(r ?? "");
      return i < 0 ? REGION_RANK.length : i;
    };
    return rows
      .filter((r) => types.includes(r.type))
      .sort((a, b) => types.indexOf(a.type) - types.indexOf(b.type) || rank(a.region) - rank(b.region))
      .map((r) => IMAGES + r.file.split("/").map(encodeURIComponent).join("/"));
  }

  async fetch(id: string): Promise<ProviderResult | null> {
    if (!/^\d+$/.test(id)) return null;
    const db = await this.open();
    if (!db) return null;
    const g = db.prepare("SELECT * FROM games WHERE id = ?").get(id) as
      | { id: string; name: string; release_date: string | null; overview: string | null; genres: string | null; rating: number | null; max_players: number | null; cooperative: number | null; esrb: string | null }
      | undefined;
    if (!g) return null;
    const esrb = g.esrb?.split(" - ")[0]?.trim();
    const ageRatings: AgeRating[] = esrb && esrb !== "Not Rated" ? [{ organization: "ESRB", rating: esrb }] : [];
    const modes = [g.max_players && g.max_players > 1 ? "Multiplayer" : g.max_players === 1 ? "Single player" : null, g.cooperative ? "Co-op" : null];
    return {
      provider: this.name,
      providerId: g.id,
      name: g.name,
      summary: g.overview?.trim() || null,
      coverUrl: this.images(db, id, COVER_TYPES)[0] ?? null,
      screenshots: this.images(db, id, SHOT_TYPES).slice(0, 8),
      genres: (g.genres ?? "").split(";").map((x) => x.trim()).filter(Boolean),
      themes: [],
      gameModes: modes.filter((x): x is string => !!x),
      releaseDate: g.release_date,
      // Community ratings are out of 5.
      rating: g.rating ? Math.round(g.rating * 20) : null,
      ageRatings,
      controllerSupport: null,
      steamAppId: null,
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

/** Streams one file out of a zip (stored or deflated), reading the central directory for its offsets. */
export async function zipEntry(file: string, name: string): Promise<NodeJS.ReadableStream> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error("The LaunchBox download is not a zip file");
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    // Zip64: the real values are in the zip64 end record just before.
    const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), eocd);
    if (cdOffset === 0xffffffff && loc >= 0) {
      const recOffset = Number(tail.readBigUInt64LE(loc + 8));
      const rec = Buffer.alloc(56);
      await fh.read(rec, 0, 56, recOffset);
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      const method = cd.readUInt16LE(p + 10);
      let compressed = cd.readUInt32LE(p + 20);
      let uncompressed = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let local = cd.readUInt32LE(p + 42);
      const entry = cd.toString("utf8", p + 46, p + 46 + nameLen);
      // Zip64 extra field holds whichever sizes overflowed, in this order.
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 1) {
          let q = e + 4;
          if (uncompressed === 0xffffffff) (uncompressed = Number(cd.readBigUInt64LE(q)), (q += 8));
          if (compressed === 0xffffffff) (compressed = Number(cd.readBigUInt64LE(q)), (q += 8));
          if (local === 0xffffffff) local = Number(cd.readBigUInt64LE(q));
        }
        e += 4 + len;
      }
      p = end + commentLen;
      if (entry !== name) continue;
      const header = Buffer.alloc(30);
      await fh.read(header, 0, 30, local);
      const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      if (!compressed) return Readable.from([]);
      const raw = createReadStream(file, { start, end: start + compressed - 1 });
      if (method === 0) return raw;
      if (method === 8) return raw.pipe(createInflateRaw());
      throw new Error(`Unsupported zip compression method ${method}`);
    }
    throw new Error(`${name} is missing from the LaunchBox download`);
  } finally {
    await fh.close();
  }
}

const TOP = /<(Game|GameAlternateName|GameImage)>([\s\S]*?)<\/\1>/g;
const CHILD = /<(\w+)>([\s\S]*?)<\/\1>/g;

function fields(inner: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of inner.matchAll(CHILD)) out[m[1]!] = decode(m[2]!);
  return out;
}

/** Reads Metadata.xml as it streams and writes games, alternate names and images. Returns the game count. */
export async function indexXml(stream: NodeJS.ReadableStream, db: DatabaseSync): Promise<number> {
  const insGame = db.prepare(
    "INSERT OR REPLACE INTO games (id, name, platform, year, release_date, overview, genres, rating, max_players, cooperative, esrb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insName = db.prepare("INSERT INTO names (game_id, norm) VALUES (?, ?)");
  const insImage = db.prepare("INSERT INTO images (game_id, type, region, file) VALUES (?, ?, ?, ?)");
  const wanted = new Set([...COVER_TYPES, ...SHOT_TYPES]);
  const decoder = new TextDecoder();
  let buf = "";
  let games = 0;
  let pending = 0;
  db.exec("BEGIN");
  const handle = (tag: string, f: Record<string, string>) => {
    const id = f.DatabaseID;
    if (!id) return;
    if (tag === "Game" && f.Name) {
      const date = f.ReleaseDate?.slice(0, 10);
      insGame.run(
        id,
        f.Name,
        f.Platform ?? null,
        Number(f.ReleaseYear) || (date ? Number(date.slice(0, 4)) : null) || null,
        date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
        f.Overview ?? null,
        f.Genres ?? null,
        Number(f.CommunityRating) || null,
        Number(f.MaxPlayers) || null,
        f.Cooperative === "true" ? 1 : 0,
        f.ESRB ?? null,
      );
      insName.run(id, normName(f.Name));
      games++;
    } else if (tag === "GameAlternateName" && f.AlternateName) insName.run(id, normName(f.AlternateName));
    else if (tag === "GameImage" && f.FileName && wanted.has(f.Type ?? "")) insImage.run(id, f.Type!, f.Region ?? null, f.FileName);
    if (++pending >= 5000) {
      db.exec("COMMIT; BEGIN");
      pending = 0;
    }
  };
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      buf += decoder.decode(chunk, { stream: true });
      let last = 0;
      TOP.lastIndex = 0;
      for (let m = TOP.exec(buf); m; m = TOP.exec(buf)) {
        handle(m[1]!, fields(m[2]!));
        last = TOP.lastIndex;
      }
      buf = buf.slice(last);
      // Skip long stretches of other elements (platforms, emulators) instead of buffering them.
      if (buf.length > 1_000_000 && !/<Game(AlternateName|Image)?>/.test(buf)) buf = buf.slice(-64);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return games;
}
