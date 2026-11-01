import path from "node:path";
import { BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import {
  applyTruckLoadOrder,
  enableTruckTextSaves,
  findSevenZip,
  retireTruckModFiles,
  scanTruckMods,
  steamWorkshopSubscriptions,
  truckGameVersion,
  truckProfiles,
} from "@lootden/client";
import { classifyModPage, findDuplicateModFiles, isTruckGame, TRUCK_GAMES, type ActiveTruckMod, type ModLinkCheck, type ModPageVisit, type TruckGame } from "@lootden/shared";
import type { TruckMods } from "./truckmods.js";

/**
 * The mod list's work on this PC: checking mod pages in a hidden browser window (mod sites often
 * turn away plain requests, a real browser gets through), the mod folder's doubles, the Workshop
 * subscriptions, and the game profiles' load order.
 */

/** Its own browser storage, so checks don't touch the person's browsing (or trip its download handling). */
const CHECK_PARTITION = "persist:lootden-modcheck";
const BLOCKED_TITLE = /just a moment|attention required|checking your browser|verify you are human/i;

export interface TruckModListDeps {
  send: (payload: object) => void;
  fromServer: (e: IpcMainInvokeEvent) => void;
  openBrowser: (url: string) => Promise<void>;
  bundled7za: () => string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TruckModList {
  private downloads = new Set<number>();
  private configured = false;
  private cancel = false;

  constructor(
    private readonly deps: TruckModListDeps,
    private readonly mods: TruckMods,
  ) {}

  private session() {
    const ses = session.fromPartition(CHECK_PARTITION);
    if (!this.configured) {
      this.configured = true;
      // A link that downloads the file is alive; nothing is saved.
      ses.on("will-download", (_e, item, wc) => {
        if (wc) this.downloads.add(wc.id);
        item.cancel();
      });
      ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    }
    return ses;
  }

  /** Opens a page in a hidden window and reads what it shows. */
  async visit(url: string, timeoutMs = 35_000): Promise<ModPageVisit> {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { session: this.session(), sandbox: true, contextIsolation: true, nodeIntegration: false, images: false, backgroundThrottling: false },
    });
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    let httpStatus = 0;
    let finalUrl: string | null = null;
    wc.on("did-navigate", (_e, u, code) => {
      finalUrl = u;
      if (code) httpStatus = code;
    });
    wc.on("did-navigate-in-page", (_e, u, isMain) => {
      if (isMain) finalUrl = u;
    });
    const deadline = Date.now() + timeoutMs;
    let error: string | null = null;
    try {
      await Promise.race([wc.loadURL(url), sleep(timeoutMs).then(() => Promise.reject(new Error("timed out")))]).catch((err: Error) => {
        // A download aborts the page load; that's not a failure.
        if (!this.downloads.has(wc.id)) error = String(err.message || err).replace(/^.*\(-\d+\)\s*/, "").slice(0, 120);
      });
      if (this.downloads.has(wc.id)) return { url, finalUrl: finalUrl ?? url, httpStatus: httpStatus || 200, title: "", text: "", download: true };
      if (error && !finalUrl) return { url, finalUrl: null, httpStatus: 0, title: "", text: "", error };
      // Let a "checking your browser" page pass, and a page that draws itself finish.
      await sleep(1500);
      while (Date.now() < deadline && BLOCKED_TITLE.test(wc.getTitle())) await sleep(1000);
      const read = (await wc
        .executeJavaScript(`[document.title, document.body ? document.body.innerText.slice(0, 30000) : ""]`, true)
        .catch(() => [wc.getTitle(), ""])) as [string, string];
      return { url, finalUrl: finalUrl ?? wc.getURL() ?? url, httpStatus, title: read[0] ?? "", text: read[1] ?? "", error };
    } finally {
      this.downloads.delete(wc.id);
      if (!win.isDestroyed()) win.destroy();
    }
  }

  private progress(game: TruckGame, done: number, total: number, line: string, finished = false) {
    this.deps.send({ gameId: `truck-mods:${game}`, type: "truckModCheck", game, done, total, line: line.slice(0, 200), finished });
  }

  /** Checks each mod's page, two at a time; results come back in one go (the page saves them on the server). */
  async check(game: TruckGame, items: Array<{ id: number; url: string; name: string }>): Promise<Array<{ id: number; check: ModLinkCheck }>> {
    this.cancel = false;
    const out: Array<{ id: number; check: ModLinkCheck }> = [];
    const queue = items.filter((i) => /^https?:\/\//i.test(i.url)).slice(0, 500);
    let done = 0;
    const worker = async () => {
      for (let item = queue.shift(); item && !this.cancel; item = queue.shift()) {
        this.progress(game, done, items.length, `Checking ${item.name}…`);
        const visit = await this.visit(item.url).catch((err: Error) => ({ url: item.url, finalUrl: null, httpStatus: 0, title: "", text: "", error: err.message }) satisfies ModPageVisit);
        out.push({ id: item.id, check: classifyModPage(visit, item.name) });
        done++;
      }
    };
    await Promise.all([worker(), worker()]);
    this.progress(game, done, items.length, this.cancel ? `Stopped after ${done} pages` : `Checked ${done} pages`, true);
    return out;
  }

  registerIpc(): void {
    const game = (g: unknown): TruckGame => {
      if (!isTruckGame(g)) throw new Error("Not a truck game");
      return g;
    };
    const gameDir = (g: TruckGame) => path.dirname(this.mods.folder(g));

    /** The mod folder (with doubles), the game version, Steam's Workshop items and the profiles on this PC. */
    ipcMain.handle("gm:truckModList:scan", async (e, g: unknown) => {
      this.deps.fromServer(e);
      const tg = game(g);
      const dir = this.mods.folder(tg);
      const version = await truckGameVersion(dir);
      const system = await findSevenZip("").catch(() => null);
      const zip = system?.supportsRar ? system : this.deps.bundled7za() ? { path: this.deps.bundled7za(), supportsRar: false } : system;
      const files = await scanTruckMods(dir, zip, version);
      return {
        modFolder: dir,
        gameFolder: gameDir(tg),
        gameVersion: version,
        files,
        duplicates: findDuplicateModFiles(files),
        workshop: await steamWorkshopSubscriptions(TRUCK_GAMES[tg].steamAppId).catch(() => []),
        profiles: await truckProfiles(gameDir(tg)),
      };
    });

    ipcMain.handle("gm:truckModList:check", async (e, g: unknown, items: unknown) => {
      this.deps.fromServer(e);
      const list = (Array.isArray(items) ? items : [])
        .map((i) => ({ id: Number((i as { id: unknown }).id), url: String((i as { url: unknown }).url ?? ""), name: String((i as { name: unknown }).name ?? "") }))
        .filter((i) => Number.isInteger(i.id) && i.url);
      return this.check(game(g), list);
    });

    ipcMain.handle("gm:truckModList:stopCheck", async (e) => {
      this.deps.fromServer(e);
      this.cancel = true;
    });

    /** Opens the mod's page in LootDen's browser; the next mod downloaded there replaces files. */
    ipcMain.handle("gm:truckModList:update", async (e, g: unknown, url: unknown, files: unknown) => {
      this.deps.fromServer(e);
      const tg = game(g);
      const link = String(url ?? "");
      if (!/^https?:\/\//i.test(link)) throw new Error("This mod has no page to update from");
      this.mods.expectUpdate(tg, link, Array.isArray(files) ? files.map(String) : []);
      await this.deps.openBrowser(link);
    });

    ipcMain.handle("gm:truckModList:retire", async (e, g: unknown, files: unknown) => {
      this.deps.fromServer(e);
      return retireTruckModFiles(this.mods.folder(game(g)), Array.isArray(files) ? files.map(String) : []);
    });

    ipcMain.handle("gm:truckModList:applyLoadOrder", async (e, g: unknown, profileDir: unknown, mods: unknown) => {
      this.deps.fromServer(e);
      const list = (Array.isArray(mods) ? mods : []).map((m) => ({ package: String((m as ActiveTruckMod).package ?? ""), name: String((m as ActiveTruckMod).name ?? "") }));
      return applyTruckLoadOrder(gameDir(game(g)), String(profileDir ?? ""), list);
    });

    ipcMain.handle("gm:truckModList:textSaves", async (e, g: unknown) => {
      this.deps.fromServer(e);
      return enableTruckTextSaves(gameDir(game(g)));
    });
  }
}
