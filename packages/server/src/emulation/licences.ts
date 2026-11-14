import { open, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentIdIn, pkgContentId, rapFileName, RAP_BYTES, type GameDetail, type GameLicence } from "@lootden/shared";
import { resolveGameFile } from "../catalog/scanner.js";

/** Game ids are hashes; anything else never becomes part of a path. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RAP_NAME = /^[A-Z0-9_-]+\.rap$/;

/**
 * PS3 licence files (.rap) an admin uploads for a game, kept on disk in <data>/licences/<game id>/
 * under the name the emulator looks for, so every player's RPCS3 or ARMSX3 gets them on install.
 */
export class LicenceStore {
  readonly dir: string;

  constructor(
    dataDir: string,
    private readonly gamesDir: () => string,
  ) {
    this.dir = path.join(dataDir, "licences");
  }

  private gameDir(gameId: string): string {
    if (!SAFE_ID.test(gameId)) throw new Error("Not a game id");
    return path.join(this.dir, gameId);
  }

  async list(gameId: string): Promise<GameLicence[]> {
    const dir = this.gameDir(gameId);
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: GameLicence[] = [];
    for (const name of names.filter((n) => RAP_NAME.test(n)).sort()) {
      const s = await stat(path.join(dir, name)).catch(() => null);
      if (s?.isFile()) out.push({ name, contentId: name.slice(0, -4), size: s.size, uploadedAt: s.mtime.toISOString() });
    }
    return out;
  }

  /** The file on disk, or null when the game has no licence by that name. */
  async path(gameId: string, name: string): Promise<string | null> {
    if (!RAP_NAME.test(name)) return null;
    const file = path.join(this.gameDir(gameId), name);
    return (await stat(file).catch(() => null))?.isFile() ? file : null;
  }

  /**
   * Stores a licence for a game. The name has to carry the content id it unlocks, as the emulator
   * finds it by that; a licence saved as "license(1).rap" takes the content id from the game's
   * package instead, when the game is a single PKG.
   */
  async add(game: GameDetail, uploadedName: string, data: Buffer): Promise<GameLicence> {
    if (game.platform !== "ps3") throw new Error("Licence files are for PS3 games");
    if (!/\.rap$/i.test(uploadedName)) throw new Error("Upload the game's .rap file");
    if (data.length !== RAP_BYTES) throw new Error(`A .rap file is ${RAP_BYTES} bytes; this one is ${data.length}`);
    const contentId = contentIdIn(path.basename(uploadedName)) ?? (await this.packageContentId(game));
    if (!contentId) {
      throw new Error("Name the file after the content id it unlocks, like UP0001-BLUS30001_00-0000000000000001.rap (the emulator looks for it by that name)");
    }
    const name = rapFileName(contentId);
    const dir = this.gameDir(game.id);
    await mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.${name}.uploading`);
    await writeFile(temp, data);
    await rename(temp, path.join(dir, name));
    return (await this.list(game.id)).find((l) => l.name === name)!;
  }

  async remove(gameId: string, name: string): Promise<boolean> {
    const file = await this.path(gameId, name);
    if (!file) return false;
    await rm(file, { force: true });
    return true;
  }

  async read(gameId: string, name: string): Promise<Buffer | null> {
    const file = await this.path(gameId, name);
    return file ? readFile(file) : null;
  }

  /** The content id in the header of a game's one PKG, when it has exactly one. */
  private async packageContentId(game: GameDetail): Promise<string | null> {
    const pkgs = game.files.filter((f) => /\.pkg$/i.test(f.path));
    if (pkgs.length !== 1) return null;
    const handle = await open(resolveGameFile(this.gamesDir(), game, pkgs[0]!), "r").catch(() => null);
    if (!handle) return null;
    try {
      const head = Buffer.alloc(0x30 + 36);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      return pkgContentId(head.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }
}
