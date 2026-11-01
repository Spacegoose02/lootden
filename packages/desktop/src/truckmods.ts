import { mkdirSync } from "node:fs";
import { copyFile, mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, dialog, ipcMain, Notification, shell, type BaseWindow, type DownloadItem, type IpcMainInvokeEvent, type WebContents } from "electron";
import {
  findSevenZip,
  installedTruckModKey,
  installTruckMod,
  linkTruckMod,
  listTruckMods,
  readTruckManifest,
  removeTruckMod,
  scanTruckMods,
  truckGameVersion,
  truckModsFolder,
  type GameServerClient,
} from "@lootden/client";
import {
  isTruckGame,
  isTruckyModsUrl,
  TRUCK_GAMES,
  truckGameFromUrl,
  truckModFileName,
  truckModTitle,
  truckModType,
  type InstalledTruckMod,
  type TruckGame,
} from "@lootden/shared";
import type { SettingsStore } from "./settings.js";

/**
 * ATS and ETS2 mods on this PC: downloads in the built-in browser that are mods (any .scs, and
 * archives from TruckyMods) go into the game's mod folder and to the server, so every other PC
 * can add them from the game's page; and the page's own calls (list, install, remove, folder).
 */

export interface TruckModDeps {
  settings: () => SettingsStore;
  client: () => Promise<GameServerClient>;
  /** Tells LootDen's window (the game's page) something changed or is happening. */
  send: (payload: object) => void;
  fromServer: (e: IpcMainInvokeEvent) => void;
}

/** 7-Zip that can open RAR when a full install is there; else the bundled one. */
async function sevenZip(bundled: string) {
  const system = await findSevenZip("").catch(() => null);
  if (system?.supportsRar) return system;
  return bundled ? { path: bundled, supportsRar: false } : system;
}

export class TruckMods {
  constructor(
    private readonly deps: TruckModDeps,
    private readonly bundled7za: () => string,
  ) {}

  folder(game: TruckGame): string {
    const custom = this.deps.settings().get().truckModFolders?.[game];
    return truckModsFolder(game, { documents: app.getPath("documents"), custom });
  }

  private progress(game: TruckGame, line: string, done = false, error = false) {
    this.deps.send({ gameId: `truck-mods:${game}`, type: "truckMods", game, line: line.slice(0, 200), done, error });
  }

  private notify(title: string, body: string) {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  }

  /**
   * Whether a download in the browser is a truck mod: a .scs from anywhere, or an archive from
   * TruckyMods (the file or the page it was started on).
   */
  static isModDownload(fileName: string, url: string, pageUrl: string): boolean {
    const type = truckModType(fileName);
    if (!type) return false;
    return type === "scs" || isTruckyModsUrl(url) || isTruckyModsUrl(pageUrl);
  }

  /**
   * The browser's will-download: a mod is saved to a temporary folder at once (so there's no
   * save dialog), then the person picks the game, and it's installed and shared when it's done.
   * Returns false for every other download, which goes on as usual.
   */
  handleDownload(item: DownloadItem, wc: WebContents | undefined, owner: BaseWindow | null): boolean {
    const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() : "";
    const fileName = item.getFilename();
    if (!TruckMods.isModDownload(fileName, item.getURL(), pageUrl)) return false;
    const pageTitle = wc && !wc.isDestroyed() ? wc.getTitle() : "";
    const tmp = path.join(os.tmpdir(), `lootden-truckmod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
    item.setSavePath(path.join(tmp, safeName(fileName)));

    const guess = truckGameFromUrl(pageUrl) ?? truckGameFromUrl(item.getURL());
    const finished = new Promise<boolean>((resolve) => item.once("done", (_e, state) => resolve(state === "completed")));
    const games: TruckGame[] = guess === "ets2" ? ["ets2", "ats"] : ["ats", "ets2"];
    const ask = owner && !owner.isDestroyed()
      ? dialog.showMessageBox(owner as never, {
          type: "question",
          message: `Add ${fileName} to your truck mods?`,
          detail: "LootDen puts it in the game's mod folder on this PC; turn it on in the game's Mod Manager.",
          buttons: [...games.map((g) => `Add to ${TRUCK_GAMES[g].short}`), "Save to Downloads"],
          defaultId: 0,
          cancelId: 2,
          checkboxLabel: "Keep it on the server for my other PCs",
          checkboxChecked: true,
        })
      : Promise.resolve({ response: 0, checkboxChecked: true });

    void (async () => {
      const [{ response, checkboxChecked }, ok] = await Promise.all([ask, finished]);
      const saved = item.getSavePath();
      try {
        if (!ok) return;
        if (response >= games.length) {
          const dest = await uniquePath(app.getPath("downloads"), safeName(fileName));
          await moveFile(saved, dest);
          shell.showItemInFolder(dest);
          return;
        }
        const game = games[response]!;
        const title = titleFrom(pageTitle, pageUrl, fileName);
        await this.addFile(game, saved, { fileName, title, sourceUrl: isTruckyModsUrl(pageUrl) ? pageUrl : null, share: checkboxChecked });
      } catch (err) {
        this.notify("Couldn't add the mod", (err as Error).message);
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    })();
    return true;
  }

  /** Installs a downloaded mod file here and (with share) keeps it on the server, linked to the copy here. */
  async addFile(game: TruckGame, file: string, info: { fileName: string; title: string; sourceUrl: string | null; share: boolean }): Promise<InstalledTruckMod> {
    const name = TRUCK_GAMES[game].short;
    const dir = this.folder(game);
    this.progress(game, `Adding ${info.title} to ${name}…`);
    let mod: InstalledTruckMod;
    try {
      mod = await installTruckMod(file, dir, { serverId: null, title: info.title, fileName: info.fileName, sourceUrl: info.sourceUrl }, await sevenZip(this.bundled7za()));
    } catch (err) {
      this.progress(game, (err as Error).message, true, true);
      throw err;
    }
    let shared = "";
    if (info.share) {
      try {
        this.progress(game, `Keeping ${info.title} on the server for your other PCs…`);
        const zip = await sevenZip(this.bundled7za());
        const manifest = zip ? await readTruckManifest(path.join(dir, mod.files[0]!), zip) : null;
        const kept = await (await this.deps.client()).uploadTruckMod(game, file, {
          fileName: info.fileName,
          title: info.title,
          sourceUrl: info.sourceUrl,
          modVersion: manifest?.version,
          compatibleVersions: manifest?.compatibleVersions,
        });
        await linkTruckMod(dir, installedTruckModKey(mod), kept.id);
        mod = { ...mod, serverId: kept.id };
        shared = " and on the server";
      } catch (err) {
        shared = `. It isn't on the server: ${(err as Error).message}`;
      }
    }
    const line = `${info.title} is in ${name}'s mod folder${shared}`;
    this.progress(game, line, true);
    this.notify(`Mod added to ${name}`, line);
    return mod;
  }

  registerIpc(): void {
    const game = (g: unknown): TruckGame => {
      if (!isTruckGame(g)) throw new Error("Not a truck game");
      return g;
    };

    /** The mod folder, the game's version, LootDen's mods and every mod file there with whether it fits. */
    ipcMain.handle("gm:truckMods:local", async (e, g: unknown) => {
      this.deps.fromServer(e);
      const dir = this.folder(game(g));
      const version = await truckGameVersion(dir);
      const zip = await sevenZip(this.bundled7za()).catch(() => null);
      return {
        folder: dir,
        custom: !!this.deps.settings().get().truckModFolders?.[game(g)],
        gameVersion: version,
        installed: await listTruckMods(dir),
        files: await scanTruckMods(dir, zip, version),
      };
    });

    /** A mod from the server, installed on this PC (or updated to the server's newer copy). */
    ipcMain.handle("gm:truckMods:install", async (e, g: unknown, id: unknown) => {
      this.deps.fromServer(e);
      const tg = game(g);
      const serverId = Number(id);
      if (!Number.isInteger(serverId) || serverId <= 0) throw new Error("Not a mod");
      const api = await this.deps.client();
      const mod = (await api.listTruckMods(tg)).find((m) => m.id === serverId);
      if (!mod) throw new Error("That mod isn't on the server any more");
      const tmp = await mkdtemp(path.join(os.tmpdir(), "lootden-truckmod-"));
      try {
        const file = path.join(tmp, safeName(mod.fileName));
        let last = 0;
        await api.downloadTruckMod(serverId, file, (got, total) => {
          if (Date.now() - last < 500) return;
          last = Date.now();
          this.progress(tg, `Downloading ${mod.title}… ${total ? Math.round((got / total) * 100) : Math.round(got / 1048576)}${total ? "%" : " MB"}`);
        });
        this.progress(tg, `Adding ${mod.title}…`);
        const installed = await installTruckMod(file, this.folder(tg), { serverId, title: mod.title, fileName: mod.fileName, sourceUrl: mod.sourceUrl }, await sevenZip(this.bundled7za()));
        this.progress(tg, `${mod.title} is in the mod folder`, true);
        return installed;
      } catch (err) {
        this.progress(tg, (err as Error).message, true, true);
        throw err;
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    });

    ipcMain.handle("gm:truckMods:remove", async (e, g: unknown, key: unknown) => {
      this.deps.fromServer(e);
      await removeTruckMod(this.folder(game(g)), String(key));
    });

    /** A mod file picked on this PC (one downloaded outside LootDen), added like a browser download. */
    ipcMain.handle("gm:truckMods:addFile", async (e, g: unknown, share: unknown) => {
      this.deps.fromServer(e);
      const tg = game(g);
      const picked = await dialog.showOpenDialog({ title: `Add a mod to ${TRUCK_GAMES[tg].name}`, properties: ["openFile"], filters: [{ name: "Truck mods", extensions: ["scs", "zip", "7z", "rar"] }] });
      const file = picked.filePaths[0];
      if (picked.canceled || !file) return null;
      const fileName = truckModFileName(path.basename(file));
      return this.addFile(tg, file, { fileName, title: truckModTitle(fileName), sourceUrl: null, share: share !== false });
    });

    ipcMain.handle("gm:truckMods:openFolder", async (e, g: unknown) => {
      this.deps.fromServer(e);
      const dir = this.folder(game(g));
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
      await shell.openPath(dir);
    });

    /** Picks the mod folder (a custom -homedir), or with reset goes back to the usual one. */
    ipcMain.handle("gm:truckMods:pickFolder", async (e, g: unknown, reset?: boolean) => {
      this.deps.fromServer(e);
      const tg = game(g);
      const folders = { ...(this.deps.settings().get().truckModFolders ?? {}) };
      if (reset) delete folders[tg];
      else {
        const picked = await dialog.showOpenDialog({ title: `${TRUCK_GAMES[tg].name}'s mod folder`, defaultPath: this.folder(tg), properties: ["openDirectory", "createDirectory"] });
        if (picked.canceled || !picked.filePaths[0]) return this.folder(tg);
        folders[tg] = picked.filePaths[0];
      }
      this.deps.settings().update({ truckModFolders: folders });
      return this.folder(tg);
    });
  }
}

/** The page's title without the site's name ("W900 | TruckyMods"), else the file's name. */
function titleFrom(pageTitle: string, pageUrl: string, fileName: string): string {
  if (isTruckyModsUrl(pageUrl)) {
    const t = pageTitle.replace(/\s*[|\-–—]\s*Trucky\s*Mods.*$/i, "").replace(/^\s*Trucky\s*Mods\s*[|\-–—]\s*/i, "").trim();
    if (t && !/^trucky\s*mods$/i.test(t)) return t.slice(0, 200);
  }
  return truckModTitle(fileName);
}

function safeName(fileName: string): string {
  try {
    return truckModFileName(fileName);
  } catch {
    return "mod.scs";
  }
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const { existsSync } = await import("node:fs");
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 2; existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

/** Moves a file, copying when it's on another drive. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}
