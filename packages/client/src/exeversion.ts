import { open, stat } from "node:fs/promises";

/** VS_FIXEDFILEINFO's signature, which starts the numbers in an exe's version resource. */
const FIXED_SIGNATURE = 0xfeef04bd;
const VERSION_KEY = Buffer.from("VS_VERSION_INFO", "utf16le");
/** Resource sections hold icons too; a version resource lives well inside this. */
const MAX_RESOURCES = 64 * 1024 * 1024;

const cache = new Map<string, { key: string; version: string | null }>();

/**
 * The file version stamped on a Windows executable ("1.0.141.13368"), read from its version
 * resource, or null when it has none (or isn't an exe). Falls back to the product version when
 * the file version is all zeros. Reads only the headers and the resource section.
 */
export async function exeVersion(file: string): Promise<string | null> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  const key = `${info.size}:${info.mtimeMs}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.version;
  const version = await readVersion(file).catch(() => null);
  cache.set(file, { key, version });
  return version;
}

async function readVersion(file: string): Promise<string | null> {
  const fh = await open(file, "r");
  try {
    const read = async (pos: number, length: number) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, pos);
      return buf.subarray(0, bytesRead);
    };
    const dos = await read(0, 64);
    if (dos.length < 64 || dos.toString("latin1", 0, 2) !== "MZ") return null;
    const peAt = dos.readUInt32LE(0x3c);
    const coff = await read(peAt, 24);
    if (coff.length < 24 || coff.readUInt32LE(0) !== 0x00004550) return null;
    const sections = coff.readUInt16LE(6);
    const optionalSize = coff.readUInt16LE(20);
    const table = await read(peAt + 24 + optionalSize, sections * 40);
    for (let i = 0; i + 40 <= table.length; i += 40) {
      if (table.toString("latin1", i, i + 8).replace(/\0+$/, "") !== ".rsrc") continue;
      const size = Math.min(table.readUInt32LE(i + 16), MAX_RESOURCES);
      return parseVersionResource(await read(table.readUInt32LE(i + 20), size));
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** Finds the VS_VERSION_INFO block in a resource section and reads its fixed version numbers. */
export function parseVersionResource(rsrc: Buffer): string | null {
  for (let at = rsrc.indexOf(VERSION_KEY); at >= 0; at = rsrc.indexOf(VERSION_KEY, at + 2)) {
    // The key is followed by padding to a 4-byte boundary, then VS_FIXEDFILEINFO.
    const end = at + VERSION_KEY.length + 2;
    for (let p = end; p <= end + 6 && p + 24 <= rsrc.length; p += 2) {
      if (rsrc.readUInt32LE(p) !== FIXED_SIGNATURE) continue;
      const file = [rsrc.readUInt32LE(p + 8), rsrc.readUInt32LE(p + 12)];
      const product = [rsrc.readUInt32LE(p + 16), rsrc.readUInt32LE(p + 20)];
      const pick = file[0] || file[1] ? file : product;
      if (!pick[0] && !pick[1]) return null;
      return [pick[0]! >>> 16, pick[0]! & 0xffff, pick[1]! >>> 16, pick[1]! & 0xffff].join(".");
    }
  }
  return null;
}
