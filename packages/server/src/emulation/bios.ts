import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { biosRequirementFor, emulatorInfo, type ServerBiosFile } from "@lootden/shared";
import { now, type Db } from "../db/database.js";

/** PS3 firmware is the biggest at about 200 MB. */
const MAX_BIOS_BYTES = 512 * 1024 ** 2;

interface Row {
  name: string;
  emulator: string;
  size: number;
  sha1: string;
  uploaded_at: string;
}

const toFile = (r: Row): ServerBiosFile => ({ name: r.name, emulator: r.emulator, size: r.size, sha1: r.sha1, uploadedAt: r.uploaded_at });

/**
 * BIOS and firmware files an admin uploads once (dumped from their own consoles),
 * so every player's desktop app can put them where its emulators look.
 */
export class BiosStore {
  readonly dir: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
  ) {
    this.dir = path.join(dataDir, "bios");
    this.refile();
  }

  /**
   * Files an older LootDen put under the wrong emulator, back where they belong. PS2 BIOS dumps
   * named like scph39001.bin used to be taken for PS1 ones, and xbox_bios.bin for a PS2 one, so
   * every PC copied them to the wrong emulator. A file its emulator doesn't take is refiled.
   */
  private refile(): void {
    let rows: Row[];
    try {
      rows = this.db.prepare("SELECT * FROM bios_files").all() as unknown as Row[];
    } catch {
      return;
    }
    for (const r of rows) {
      if (biosRequirementFor(r.name, r.emulator)) continue;
      const right = biosRequirementFor(r.name);
      if (right) this.db.prepare("UPDATE bios_files SET emulator = ? WHERE name = ?").run(right.emulator.id, r.name);
    }
  }

  list(): ServerBiosFile[] {
    return (this.db.prepare("SELECT * FROM bios_files ORDER BY emulator, name").all() as unknown as Row[]).map(toFile);
  }

  path(name: string): string | null {
    const row = this.db.prepare("SELECT name FROM bios_files WHERE name = ?").get(name) as { name: string } | undefined;
    return row ? path.join(this.dir, row.name) : null;
  }

  /** Stores a file under its own name; the emulator is guessed from the name when not given. */
  async add(name: string, body: Readable, emulator?: string): Promise<ServerBiosFile> {
    const clean = path.basename(name).trim();
    if (!clean || clean.startsWith(".") || /[\\/]/.test(clean)) throw new Error("Give the file its real name, like scph5501.bin");
    const known = biosRequirementFor(clean, emulator || undefined);
    const emu = emulator || known?.emulator.id;
    if (!emu || !emulatorInfo(emu)) throw new Error(`${clean} doesn't look like a BIOS file LootDen knows; pick the emulator it's for`);
    if (!known) throw new Error(`${clean} isn't a file ${emulatorInfo(emu)!.name} needs`);

    await mkdir(this.dir, { recursive: true });
    const temp = path.join(this.dir, `.${clean}.uploading`);
    const hash = createHash("sha1");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > MAX_BIOS_BYTES) return cb(new Error("That file is too big to be a BIOS"));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(temp));
      if (size === 0) throw new Error("The file is empty");
      await rename(temp, path.join(this.dir, clean));
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    const row: Row = { name: clean, emulator: emu, size, sha1: hash.digest("hex"), uploaded_at: now() };
    this.db
      .prepare(
        "INSERT INTO bios_files (name, emulator, size, sha1, uploaded_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET emulator = excluded.emulator, size = excluded.size, sha1 = excluded.sha1, uploaded_at = excluded.uploaded_at",
      )
      .run(row.name, row.emulator, row.size, row.sha1, row.uploaded_at);
    return toFile(row);
  }

  async remove(name: string): Promise<boolean> {
    const file = this.path(name);
    if (!file) return false;
    await rm(file, { force: true });
    this.db.prepare("DELETE FROM bios_files WHERE name = ?").run(name);
    return true;
  }
}
