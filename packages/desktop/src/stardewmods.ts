import { existsSync, mkdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dialog, ipcMain, Notification, shell, type BaseWindow, type DownloadItem, type IpcMainInvokeEvent, type WebContents } from "electron";
import { extractArchive, findStardewDir, scanStardewMods, stardewDefaultDirs, syncStardewMods, type GameServerClient, type SevenZip } from "@lootden/client";
import { isStardew, type StardewSyncResult } from "@lootden/shared";
import type { SettingsStore } from "./settings.js";

/**
 * Stardew Valley's Mods folder on this PC, kept the same as the household's shared mod set:
 * the game page's calls (look, sync, add a zip, folder, options), a sync before the game starts
 * (so co-op players always have matching mods), and mod zips downloaded from Nexus in LootDen's
 * browser, which go into the set.
 */

export interface StardewModDeps {
  settings: () => SettingsStore;
  client: () => Promise<GameServerClient>;
  send: (payload: object) => void;
  fromServer: (e: IpcMainInvokeEvent) => void;
  sevenZip: () => Promise<SevenZip>;
  /** Folders Stardew Valley may be installed in on this PC: LootDen's install and other stores'. */
  installs: () => Promise<Array<{ title: string; dir: string }>>;
}

export class StardewMods {
  private syncing: Promise<StardewSyncResult> | null = null;

  constructor(private readonly deps: StardewModDeps) {}

  private progress(line: string, done = false, error = false) {
    this.deps.send({ gameId: "stardew-mods", type: "stardewMods", line: line.slice(0, 200), done, error });
  }

  /** The game's folder: the one picked on this PC, else where it's installed, else where Steam or GOG put it. */
  async gameDir(home?: string | null): Promise<string | null> {
    const custom = this.deps.settings().get().stardewGameDir;
    if (custom && existsSync(custom)) return custom;
    const tries = [...(home ? [home] : []), ...(await this.deps.installs().catch(() => [])).filter((g) => isStardew(null, g.title)).map((g) => g.dir), ...stardewDefaultDirs()];
    for (const dir of tries) {
      const found = await findStardewDir(dir);
      if (found) return found;
    }
    return null;
  }

  private async modsDir(home?: string | null): Promise<string> {
    const dir = await this.gameDir(home);
    if (!dir) throw new Error("LootDen couldn't find Stardew Valley on this PC. Pick its folder with Change folder.");
    return path.join(dir, "Mods");
  }

  /** Tells the server what this PC loads, so the mod set page shows whether it matches. */
  private async report(modsDir: string): Promise<void> {
    const mods = (await scanStardewMods(modsDir)).filter((m) => m.enabled).map((m) => ({ uniqueId: m.uniqueId, name: m.name, version: m.version }));
    await (await this.deps.client()).reportStardewMods(os.hostname(), mods);
  }

  /** Makes the Mods folder match the set (one sync at a time). */
  sync(home?: string | null): Promise<StardewSyncResult> {
    this.syncing ??= (async () => {
      try {
        const dir = await this.modsDir(home);
        const api = await this.deps.client();
        const { mods } = await api.stardewMods();
        const zip = await this.deps.sevenZip();
        this.progress("Matching Stardew mods to the shared set…");
        const result = await syncStardewMods(dir, mods, {
          strict: this.deps.settings().get().stardewStrict !== false,
          download: (mod, dest) => api.downloadStardewMod(mod.id, dest),
          extract: (file, out) => extractArchive(zip, "zip", file, out),
          onProgress: (line) => this.progress(line),
        });
        await this.report(dir).catch(() => {});
        const changed = result.added.length + result.updated.length + result.switchedOn.length + result.switchedOff.length + result.extrasOff.length;
        this.progress(result.failed.length ? `Couldn't get ${result.failed.map((f) => f.name).join(", ")}` : changed ? "Stardew mods match the shared set" : "Stardew mods already match", true, result.failed.length > 0);
        return result;
      } catch (err) {
        this.progress((err as Error).message, true, true);
        throw err;
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  /**
   * Before Stardew Valley starts (from LootDen or another store): syncs when that's on, and never
   * stops the game; a failure (no server, say) is a warning and the mods stay as they were.
   */
  async beforePlay(title: string, home: string, warn: (message: string) => void): Promise<void> {
    if (!isStardew(null, title) || this.deps.settings().get().stardewAutoSync === false) return;
    try {
      const r = await this.sync(home);
      if (r.failed.length) warn(`Some shared Stardew mods couldn't be updated: ${r.failed.map((f) => `${f.name} (${f.error})`).join(", ")}`);
    } catch (err) {
      warn(`Stardew mods weren't synced: ${(err as Error).message}`);
    }
  }

  /** Adds a mod zip on this PC to the shared set. */
  private async upload(file: string, info: { fileName: string; sourceUrl: string | null }) {
    this.progress(`Adding ${info.fileName} to the shared Stardew mods…`);
    try {
      const mod = await (await this.deps.client()).uploadStardewMod(file, info);
      this.progress(`${mod.title} is in the shared set${mod.enabled ? "" : "; an admin has to switch it on"}`, true);
      return mod;
    } catch (err) {
      this.progress((err as Error).message, true, true);
      throw err;
    }
  }

  /** Whether a download in the browser is a Stardew mod: a .zip started from Nexus's Stardew pages. */
  static isModDownload(fileName: string, url: string, pageUrl: string): boolean {
    if (!/\.zip$/i.test(fileName)) return false;
    return [url, pageUrl].some((u) => /^https:\/\/(www\.)?nexusmods\.com\/stardewvalley\//i.test(u));
  }

  /** The browser's will-download: a Stardew mod from Nexus is offered to the shared set; false for anything else. */
  handleDownload(item: DownloadItem, wc: WebContents | undefined, owner: BaseWindow | null): boolean {
    const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() : "";
    const fileName = item.getFilename();
    if (!StardewMods.isModDownload(fileName, item.getURL(), pageUrl)) return false;
    const tmp = path.join(os.tmpdir(), `lootden-stardew-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
    const saved = path.join(tmp, path.basename(fileName).replace(/[<>:"/\\|?*]+/g, "_"));
    item.setSavePath(saved);
    const finished = new Promise<boolean>((resolve) => item.once("done", (_e, state) => resolve(state === "completed")));
    const ask =
      owner && !owner.isDestroyed()
        ? dialog.showMessageBox(owner as never, {
            type: "question",
            message: `Add ${fileName} to your shared Stardew mods?`,
            detail: "LootDen keeps it on the server and puts it in the Mods folder of every PC at their next sync (or when Stardew starts).",
            buttons: ["Add to shared mods", "Save to Downloads"],
            defaultId: 0,
            cancelId: 1,
          })
        : Promise.resolve({ response: 0 });
    void (async () => {
      const [{ response }, ok] = await Promise.all([ask, finished]);
      try {
        if (!ok) return;
        if (response !== 0) {
          const { app } = await import("electron");
          const { copyFile } = await import("node:fs/promises");
          const dest = path.join(app.getPath("downloads"), path.basename(saved));
          await copyFile(saved, dest);
          shell.showItemInFolder(dest);
          return;
        }
        const mod = await this.upload(saved, { fileName, sourceUrl: /nexusmods\.com\/stardewvalley\/mods\/\d+/i.test(pageUrl) ? pageUrl.replace(/[?#].*$/, "") : null });
        if (mod.enabled) await this.sync().catch(() => {});
        if (Notification.isSupported()) new Notification({ title: "Stardew mod added", body: `${mod.title} is in the shared set${mod.enabled ? "" : "; an admin has to switch it on"}` }).show();
      } catch (err) {
        if (Notification.isSupported()) new Notification({ title: "Couldn't add the mod", body: (err as Error).message }).show();
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    })();
    return true;
  }

  registerIpc(): void {
    /** The game's folder here, the mods in its Mods folder, and this PC's options. */
    ipcMain.handle("gm:stardew:local", async (e) => {
      this.deps.fromServer(e);
      const s = this.deps.settings().get();
      const dir = await this.gameDir();
      const mods = dir ? await scanStardewMods(path.join(dir, "Mods")) : [];
      if (dir) void this.report(path.join(dir, "Mods")).catch(() => {});
      return { gameDir: dir, modsDir: dir ? path.join(dir, "Mods") : null, custom: !!s.stardewGameDir, autoSync: s.stardewAutoSync !== false, strict: s.stardewStrict !== false, mods };
    });

    ipcMain.handle("gm:stardew:sync", async (e) => {
      this.deps.fromServer(e);
      return this.sync();
    });

    ipcMain.handle("gm:stardew:options", async (e, patch: unknown) => {
      this.deps.fromServer(e);
      const p = (patch ?? {}) as { autoSync?: unknown; strict?: unknown };
      const s = this.deps.settings().update({
        ...(typeof p.autoSync === "boolean" ? { stardewAutoSync: p.autoSync } : {}),
        ...(typeof p.strict === "boolean" ? { stardewStrict: p.strict } : {}),
      });
      return { autoSync: s.stardewAutoSync !== false, strict: s.stardewStrict !== false };
    });

    /** A mod zip picked on this PC (downloaded outside LootDen), added to the shared set. */
    ipcMain.handle("gm:stardew:addFile", async (e) => {
      this.deps.fromServer(e);
      const picked = await dialog.showOpenDialog({ title: "Add a Stardew Valley mod", properties: ["openFile"], filters: [{ name: "Mod zips", extensions: ["zip"] }] });
      const file = picked.filePaths[0];
      if (picked.canceled || !file) return null;
      return this.upload(file, { fileName: path.basename(file), sourceUrl: null });
    });

    ipcMain.handle("gm:stardew:openFolder", async (e) => {
      this.deps.fromServer(e);
      const dir = await this.modsDir();
      await mkdir(dir, { recursive: true });
      await shell.openPath(dir);
    });

    /** Picks the game's folder, or with reset goes back to finding it. */
    ipcMain.handle("gm:stardew:pickFolder", async (e, reset?: boolean) => {
      this.deps.fromServer(e);
      if (reset) {
        this.deps.settings().update({ stardewGameDir: undefined });
        return this.gameDir();
      }
      const picked = await dialog.showOpenDialog({ title: "Stardew Valley's folder (the one with Stardew Valley.exe)", defaultPath: (await this.gameDir()) ?? undefined, properties: ["openDirectory"] });
      const dir = picked.filePaths[0];
      if (picked.canceled || !dir) return this.gameDir();
      const found = await findStardewDir(dir);
      if (!found) throw new Error("That folder doesn't have Stardew Valley in it");
      this.deps.settings().update({ stardewGameDir: found });
      return found;
    });
  }
}
