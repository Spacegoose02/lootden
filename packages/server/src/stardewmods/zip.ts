import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * Just enough of the zip format to read the small files in a mod's zip (its manifest.json
 * files) without unpacking it: the central directory lists every entry, and each wanted one is
 * read and inflated on its own. Zip64 archives (over 4 GB) aren't mods and aren't read.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export async function zipEntries(file: string): Promise<ZipEntry[]> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new Error("That isn't a zip file");
    // The end record is in the last 64 KB (its comment is at most 65535 bytes).
    const tailLen = Math.min(size, 22 + 65_535);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let at = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { at = i; break; }
    if (at < 0) throw new Error("That isn't a zip file");
    const count = tail.readUInt16LE(at + 10);
    const cdSize = tail.readUInt32LE(at + 12);
    const cdOffset = tail.readUInt32LE(at + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("That zip is too big to be a mod");
    if (cdOffset + cdSize > size) throw new Error("That zip is damaged");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== CENTRAL) throw new Error("That zip is damaged");
      const flags = cd.readUInt16LE(p + 8);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const raw = cd.subarray(p + 46, p + 46 + nameLen);
      out.push({
        name: (flags & 0x800 ? raw.toString("utf8") : raw.toString("latin1")).replace(/\\/g, "/"),
        method: cd.readUInt16LE(p + 10),
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** One entry's bytes (stored or deflated); refuses anything over maxBytes. */
export async function readZipEntry(file: string, entry: ZipEntry, maxBytes = 1024 * 1024): Promise<Buffer> {
  if (entry.size > maxBytes || entry.compressedSize > maxBytes) throw new Error(`${entry.name} is too big`);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name} is packed in a way LootDen can't read`);
  const fh = await open(file, "r");
  try {
    const head = Buffer.alloc(30);
    await fh.read(head, 0, 30, entry.offset);
    if (head.readUInt32LE(0) !== LOCAL) throw new Error("That zip is damaged");
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const data = Buffer.alloc(entry.compressedSize);
    await fh.read(data, 0, entry.compressedSize, start);
    return entry.method === 0 ? data : inflateRawSync(data, { maxOutputLength: maxBytes });
  } finally {
    await fh.close();
  }
}
