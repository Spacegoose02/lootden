import { BrowserWindow, ipcMain, safeStorage, shell, type IpcMainInvokeEvent } from "electron";
import { XboxLive, XboxLiveError, type XboxConsole, type XboxDeviceCode, type XboxInstalledGame, type XboxSavedSignIn, type XHomeSession } from "@lootden/client";
import { isStreamFit, isXboxConsoleId, type StreamFit } from "@lootden/shared";
import type { SettingsStore } from "./settings.js";

/**
 * LootDen's own Xbox remote play: the Microsoft sign-in, the consoles and their games, and the
 * stream window that plays a console (setup/xstream.html). No Xbox web page and no other app:
 * the main process talks to Xbox Live and the xHome streaming service (see
 * @lootden/client's xboxlive.ts) and the window plays the stream with xbox-xcloud-player.
 */

export interface XboxDeps {
  settings: () => SettingsStore;
  mainWindow: () => BrowserWindow | null;
  page: string;
  preload: string;
  icon: string;
  /** Tells LootDen's pages something changed (the sign-in finished), as a progress event. */
  notify: (payload: object) => void;
  /** Throws unless the call came from LootDen's own pages. */
  fromServer: (e: IpcMainInvokeEvent) => void;
}

/** Where a sign-in in progress stands, for the Profile card. */
interface PendingSignIn {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export interface XboxStatus {
  signedIn: boolean;
  gamertag: string | null;
  pending: PendingSignIn | null;
  error: string | null;
  /** The console Play remotely uses when none is named, picked on the Profile card. */
  defaultConsole: string | null;
  fit: StreamFit;
  streaming: boolean;
}

export interface XboxPlayRequest {
  consoleId?: string | null;
  /** A game to start on the console first (its Microsoft Store id), when known. */
  productId?: string | null;
  title?: string | null;
}

export class XboxRemote {
  readonly live: XboxLive;
  private pending: (PendingSignIn & { deviceCode: string; timer?: ReturnType<typeof setTimeout> }) | null = null;
  private error: string | null = null;
  private consolesCache: { at: number; list: XboxConsole[] } | null = null;
  private win: BrowserWindow | null = null;
  private session: XHomeSession | null = null;
  private request: (XboxPlayRequest & { consoleId: string; consoleName: string }) | null = null;

  constructor(private readonly deps: XboxDeps) {
    this.live = new XboxLive(this.load(), (s) => this.store(s));
  }

  // ---- The saved sign-in, sealed with the OS keychain when it can be -------------------

  private load(): XboxSavedSignIn | null {
    const saved = this.deps.settings().get().xboxSignIn;
    if (!saved?.data) return null;
    try {
      const json = saved.sealed ? safeStorage.decryptString(Buffer.from(saved.data, "base64")) : saved.data;
      return JSON.parse(json) as XboxSavedSignIn;
    } catch {
      return null;
    }
  }

  private store(s: XboxSavedSignIn | null): void {
    if (!s) return void this.deps.settings().update({ xboxSignIn: undefined });
    const sealed = safeStorage.isEncryptionAvailable();
    const json = JSON.stringify(s);
    this.deps.settings().update({ xboxSignIn: { data: sealed ? safeStorage.encryptString(json).toString("base64") : json, sealed } });
  }

  private get fit(): StreamFit {
    const f = this.deps.settings().get().streamFit;
    return isStreamFit(f) ? f : "fit";
  }

  status(): XboxStatus {
    return {
      signedIn: this.live.signedIn,
      gamertag: this.live.gamertag,
      pending: this.pending ? { userCode: this.pending.userCode, verificationUri: this.pending.verificationUri, expiresAt: this.pending.expiresAt } : null,
      error: this.error,
      defaultConsole: this.deps.settings().get().xboxConsole ?? null,
      fit: this.fit,
      streaming: !!this.win && !this.win.isDestroyed(),
    };
  }

  // ---- Signing in with a code (microsoft.com/link), checked in the background ---------

  async startSignIn(): Promise<XboxStatus> {
    this.cancelSignIn();
    this.error = null;
    const code: XboxDeviceCode = await this.live.startSignIn();
    this.pending = { userCode: code.userCode, verificationUri: code.verificationUri, deviceCode: code.deviceCode, expiresAt: Date.now() + code.expiresIn * 1000 };
    this.poll(code.interval);
    return this.status();
  }

  private poll(intervalSeconds: number): void {
    const p = this.pending;
    if (!p) return;
    p.timer = setTimeout(async () => {
      if (this.pending !== p) return;
      try {
        await this.live.finishSignIn(p.deviceCode);
        this.pending = null;
        this.consolesCache = null;
        this.deps.notify({ type: "xbox", status: this.status() });
      } catch (err) {
        const e = err as XboxLiveError;
        if (e.code === "pending" && Date.now() < p.expiresAt) return this.poll(intervalSeconds);
        this.pending = null;
        this.error = e.message;
        this.deps.notify({ type: "xbox", status: this.status() });
      }
    }, Math.max(1, intervalSeconds) * 1000);
  }

  cancelSignIn(): void {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  signOut(): XboxStatus {
    this.cancelSignIn();
    this.live.signOut();
    this.consolesCache = null;
    this.error = null;
    return this.status();
  }

  // ---- Consoles and their games --------------------------------------------------------

  async consoles(refresh = false): Promise<XboxConsole[]> {
    if (!refresh && this.consolesCache && Date.now() - this.consolesCache.at < 60_000) return this.consolesCache.list;
    const list = await this.live.consoles();
    this.consolesCache = { at: Date.now(), list };
    return list;
  }

  installed(consoleId: string): Promise<XboxInstalledGame[]> {
    if (!isXboxConsoleId(consoleId)) throw new Error("That isn't an Xbox console id");
    return this.live.installedGames(consoleId);
  }

  async wake(consoleId: string): Promise<void> {
    if (!isXboxConsoleId(consoleId)) throw new Error("That isn't an Xbox console id");
    await this.live.wake(consoleId);
  }

  /** The console to stream: the one asked for, else the one picked on Profile, else the only (or first streamable) one. */
  private async pickConsole(asked?: string | null): Promise<XboxConsole> {
    const list = await this.consoles();
    if (!list.length) throw new Error("No Xbox consoles on this Microsoft account. Sign in on the console with the same account");
    const want = (asked && isXboxConsoleId(asked) ? asked : this.deps.settings().get().xboxConsole)?.toUpperCase();
    const found = want ? list.find((c) => c.id.toUpperCase() === want) : null;
    if (want && !found) throw new Error("That console isn't on the signed-in Microsoft account");
    const c = found ?? list.find((x) => x.streamingEnabled) ?? list[0]!;
    if (!c.streamingEnabled) throw new Error(`Remote play is off on ${c.name}. On the console: Settings, Devices & connections, Remote features, then tick Enable remote features`);
    return c;
  }

  // ---- The stream window ----------------------------------------------------------------

  /** Opens the stream window for a console (and a game on it), full screen. */
  async play(req: XboxPlayRequest): Promise<void> {
    if (!this.live.signedIn) throw new Error("Sign in with your Microsoft account first, under Profile, This computer, Xbox remote play");
    const c = await this.pickConsole(req.consoleId);
    if (this.win && !this.win.isDestroyed()) {
      // One stream at a time: a new Play replaces the old one.
      await new Promise<void>((done) => {
        this.win!.once("closed", () => done());
        this.win!.close();
      });
    }
    this.request = { ...req, consoleId: c.id, consoleName: c.name };
    const main = this.deps.mainWindow();
    const bounds = main && !main.isDestroyed() ? main.getBounds() : undefined;
    const win = new BrowserWindow({
      ...(bounds ?? { width: 1600, height: 900 }),
      fullscreen: true,
      backgroundColor: "#000000",
      title: "Xbox remote play",
      icon: this.deps.icon,
      autoHideMenuBar: true,
      webPreferences: { preload: this.deps.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.win = win;
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.on("closed", () => {
      if (this.win === win) this.win = null;
      void this.endSession();
      const m = this.deps.mainWindow();
      if (m && !m.isDestroyed()) {
        m.show();
        m.focus();
      }
    });
    if (main && !main.isDestroyed()) main.hide();
    await win.loadFile(this.deps.page);
  }

  private async endSession(): Promise<void> {
    const s = this.session;
    this.session = null;
    await s?.stop();
  }

  /** Starts the session the stream window asked for: wakes the console, starts the game, waits until it's ready. */
  private async startSession(): Promise<void> {
    const req = this.request;
    if (!req) throw new Error("No stream was asked for");
    await this.endSession();
    // Waking first lets a console in sleep mode be streamed; one already on just says so.
    await this.live.wake(req.consoleId).catch(() => {});
    if (req.productId) await this.live.launch(req.consoleId, req.productId).catch(() => {});
    const { width, height } = this.win && !this.win.isDestroyed() ? this.win.getBounds() : { width: 1920, height: 1080 };
    const session = await this.live.startStream(req.consoleId, { width, height });
    this.session = session;
    await session.ready((state) => {
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send("gm:xstream:state", state);
    });
  }

  private fromStream(e: IpcMainInvokeEvent): void {
    if (!this.win || this.win.isDestroyed() || e.sender !== this.win.webContents) throw new Error("Not allowed from this page");
  }

  private get activeSession(): XHomeSession {
    if (!this.session) throw new Error("The stream isn't running");
    return this.session;
  }

  registerIpc(): void {
    // From LootDen's own pages.
    const page = <A extends unknown[]>(name: string, fn: (...args: A) => unknown) =>
      ipcMain.handle(`gm:xbox:${name}`, (e, ...args) => {
        this.deps.fromServer(e);
        return fn(...(args as A));
      });
    page("status", () => this.status());
    page("signIn", () => this.startSignIn());
    page("cancelSignIn", () => (this.cancelSignIn(), this.status()));
    page("openSignInPage", () => this.pending && void shell.openExternal(this.pending.verificationUri.startsWith("https://") ? this.pending.verificationUri : "https://microsoft.com/link"));
    page("signOut", () => this.signOut());
    page("consoles", (refresh: unknown) => this.consoles(refresh === true));
    page("installed", (consoleId: unknown) => this.installed(String(consoleId)));
    page("wake", (consoleId: unknown) => this.wake(String(consoleId)));
    page("setDefault", (consoleId: unknown) => {
      this.deps.settings().update({ xboxConsole: typeof consoleId === "string" && isXboxConsoleId(consoleId) ? consoleId.toUpperCase() : undefined });
      return this.status();
    });
    page("setFit", (fit: unknown) => {
      if (isStreamFit(fit)) this.deps.settings().update({ streamFit: fit });
      return this.status();
    });
    page("play", (req: unknown) => {
      const r = (req ?? {}) as Record<string, unknown>;
      const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
      return this.play({ consoleId: str(r.consoleId, 32), productId: str(r.productId, 32)?.replace(/[^A-Z0-9]/gi, "") || null, title: str(r.title, 200) });
    });

    // From the stream window only.
    const stream = <A extends unknown[]>(name: string, fn: (...args: A) => unknown) =>
      ipcMain.handle(`gm:xstream:${name}`, (e, ...args) => {
        this.fromStream(e);
        return fn(...(args as A));
      });
    stream("info", () => ({ consoleName: this.request?.consoleName ?? "your Xbox", game: this.request?.title ?? null, fit: this.fit, rumble: true }));
    stream("start", () => this.startSession());
    stream("sdp", (offer: unknown, chat: unknown) => {
      if (typeof offer !== "string" || offer.length > 200_000) throw new Error("Not an SDP offer");
      return this.activeSession.sdp(offer, chat === true);
    });
    stream("ice", (candidates: unknown) => {
      if (!Array.isArray(candidates) || candidates.length > 100) throw new Error("Not a list of ICE candidates");
      const clean = candidates.map((c) => {
        const x = (c ?? {}) as Record<string, unknown>;
        return { candidate: String(x.candidate ?? "").slice(0, 1000), sdpMLineIndex: typeof x.sdpMLineIndex === "number" ? x.sdpMLineIndex : null, sdpMid: typeof x.sdpMid === "string" ? x.sdpMid.slice(0, 32) : null };
      });
      return this.activeSession.ice(clean);
    });
    stream("keepalive", () => this.activeSession.keepalive().then(() => undefined));
    stream("setFit", (fit: unknown) => {
      if (isStreamFit(fit)) this.deps.settings().update({ streamFit: fit });
    });
    stream("fullscreen", () => this.win?.setFullScreen(!this.win.isFullScreen()));
    stream("close", () => this.win?.close());
  }
}
