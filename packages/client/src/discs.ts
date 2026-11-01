import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

// Telling whether a disc image or game folder is the right game, by a file that should be on it:
// a PlayStation 2 (or any ISO 9660) disc, an Xbox or Xbox 360 (XDVDFS) disc, or a folder. Only the
// directory listings are read, never the whole disc.

const SECTOR = 2048;

async function readAt(fh: import("node:fs/promises").FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  return buf.subarray(0, bytesRead);
}

/** Names in the top folder of an ISO 9660 disc image (2048-byte sectors), upper case, without ";1". */
export async function iso9660RootNames(file: string): Promise<string[] | null> {
  const fh = await open(file, "r");
  try {
    const pvd = await readAt(fh, 16 * SECTOR, SECTOR);
    if (pvd.length < SECTOR || pvd[0] !== 1 || pvd.toString("ascii", 1, 6) !== "CD001") return null;
    const extent = pvd.readUInt32LE(156 + 2);
    const size = Math.min(pvd.readUInt32LE(156 + 10), 1024 * 1024);
    const dir = await readAt(fh, extent * SECTOR, size);
    const names: string[] = [];
    for (let at = 0; at < dir.length; ) {
      const len = dir[at]!;
      if (len === 0) {
        // Records don't cross sectors: skip to the next one.
        at = (Math.floor(at / SECTOR) + 1) * SECTOR;
        continue;
      }
      const nameLen = dir[at + 32]!;
      const raw = dir.toString("latin1", at + 33, at + 33 + nameLen);
      if (raw !== "\0" && raw !== "\x01") names.push(raw.replace(/;\d+$/, "").replace(/\.$/, "").toUpperCase());
      at += len;
    }
    return names;
  } finally {
    await fh.close();
  }
}

/** Where the game partition starts on the kinds of Xbox and Xbox 360 discs, tried in turn. */
const XDVDFS_OFFSETS = [0, 0x18300000, 0xfd90000, 0x2080000];
const XDVDFS_MAGIC = "MICROSOFT*XBOX*MEDIA";

/** Names in the top folder of an Xbox or Xbox 360 disc image, upper case. */
export async function xdvdfsRootNames(file: string): Promise<string[] | null> {
  const fh = await open(file, "r");
  try {
    for (const base of XDVDFS_OFFSETS) {
      const head = await readAt(fh, base + 32 * SECTOR, 28);
      if (head.length < 28 || head.toString("ascii", 0, 20) !== XDVDFS_MAGIC) continue;
      const rootSector = head.readUInt32LE(20);
      const rootSize = Math.min(head.readUInt32LE(24), 1024 * 1024);
      const dir = await readAt(fh, base + rootSector * SECTOR, rootSize);
      const names: string[] = [];
      // The folder is a binary tree; offsets are in 4-byte steps from the start of the folder.
      const seen = new Set<number>();
      const walk = (off: number) => {
        if (off + 14 > dir.length || seen.has(off) || seen.size > 10000) return;
        seen.add(off);
        const left = dir.readUInt16LE(off);
        const right = dir.readUInt16LE(off + 2);
        if (left === 0xffff && right === 0xffff) return;
        const nameLen = dir[off + 13]!;
        names.push(dir.toString("latin1", off + 14, off + 14 + nameLen).toUpperCase());
        if (left && left !== 0xffff) walk(left * 4);
        if (right && right !== 0xffff) walk(right * 4);
      };
      walk(0);
      return names;
    }
    return null;
  } finally {
    await fh.close();
  }
}

export interface GameCheck {
  file?: string;
  iso9660?: string;
  xdvdfs?: string;
}

/**
 * Whether the game file (a disc image or a folder) has the file a recomp looks for. Null when it does,
 * else what's wrong in words for the player.
 */
export async function checkGameCopy(game: string, check: GameCheck): Promise<string | null> {
  const s = await stat(game).catch(() => null);
  if (!s) return "The game file isn't there";
  if (check.file) {
    if (!s.isDirectory()) return "It needs the game as a folder, not a disc image";
    let dir = game;
    for (const part of check.file.split(/[\\/]/).filter(Boolean)) {
      const entry = (await readdir(dir).catch(() => [] as string[])).find((n) => n.toLowerCase() === part.toLowerCase());
      if (!entry) return `There's no ${check.file} in that folder`;
      dir = path.join(dir, entry);
    }
    return null;
  }
  const want = (check.iso9660 ?? check.xdvdfs)?.toUpperCase();
  if (!want) return null;
  if (s.isDirectory()) {
    const names = (await readdir(game)).map((n) => n.toUpperCase());
    return names.includes(want) ? null : `There's no ${want} in that folder`;
  }
  const names = check.iso9660 ? await iso9660RootNames(game) : await xdvdfsRootNames(game);
  if (!names) return check.iso9660 ? "That isn't a disc image LootDen can read (it needs a 2048-byte-sector .iso)" : "That isn't an Xbox disc image";
  return names.includes(want) ? null : `That disc doesn't have ${want} on it, so it's another game or region`;
}
