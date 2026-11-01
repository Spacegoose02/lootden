import { BaseWindow, dialog, ipcMain, session, shell, WebContentsView, type BrowserWindow, type IpcMainInvokeEvent, type DownloadItem, type Session, type WebContents } from "electron";
import {
  addressToUrl,
  cleanBookmarks,
  DEFAULT_BOOKMARKS,
  isBrowsable,
  isStoreLaunchUrl,
  KID_BOOKMARKS,
  KID_SEARCH,
  launcherShortcuts,
  safeSearchUrl,
  SEARCH_ENGINES,
  siteAllowed,
  siteName,
  type Bookmark,
  type BrowserPolicy,
  type SearchEngine,
} from "@lootden/client";
import type { SettingsStore } from "./settings.js";

/**
 * The built-in web browser: a window of its own over LootDen (which hides while it's open), so
 * on a handheld or in the Xbox full screen experience there's no need to reach for Edge. The
 * toolbar and start page are a local page (setup/browser.html); each tab is a WebContentsView
 * in a session of its own, sandboxed, with no preload and nothing shared with LootDen's pages.
 */

/** Sites keep their sign-ins (YouTube, Discord ...) between visits, apart from the server's session. */
export const BROWSER_PARTITION = "persist:lootden-browser";
/** Kid-safe browsing keeps its own sign-ins, so a grown-up's accounts aren't signed in for a kid. */
export const KIDS_PARTITION = "persist:lootden-browser-kids";

interface Tab {
  id: number;
  /** Null while the tab shows the start page. */
  view: WebContentsView | null;
  title: string;
  url: string;
  favicon: string;
  /** The site the browser rules kept this tab from opening, while the tab shows why. */
  blocked?: string;
  /** Where the controller's pointer is, in the page's pixels. */
  pointer: { x: number; y: number };
}

export interface BrowserDeps {
  settings: () => SettingsStore;
  mainWindow: () => BrowserWindow | null;
  handheld: () => boolean;
  customFrame: boolean;
  titlebarHeight: number;
  zoom: number;
  shellPage: string;
  /** Shown in a tab instead of a site the browser rules don't allow. */
  blockedPage: string;
  preload: string;
  /** What the signed-in person may open (see BrowserPolicy), asked of the server each time the browser opens. */
  policy: () => Promise<BrowserPolicy | null>;
  icon: string;
  /** Takes a download for itself (truck mods into the game's mod folder); false lets it go on as usual. */
  onDownload?: (item: DownloadItem, wc: WebContents | undefined, owner: BaseWindow | null) => boolean;
}

/** Permissions sites may have without asking; camera and microphone are asked for, the rest refused. */
const SITE_PERMISSIONS = new Set(["fullscreen", "pointerLock", "keyboardLock", "clipboard-sanitized-write"]);

/** Draws (or moves) the controller pointer in a page, in a world of its own the page's scripts can't reach. */
const pointerScript = (x: number, y: number) => `(() => {
  let c = document.getElementById("__lootden_pointer");
  if (!c) {
    c = document.createElement("div");
    c.id = "__lootden_pointer";
    c.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;border:3px solid #fff;background:rgba(46,242,255,.35);box-shadow:0 0 0 2px rgba(0,0,0,.6),0 0 14px #2ef2ff;transition:opacity .4s";
    document.documentElement.appendChild(c);
  }
  c.style.transform = "translate(${x}px, ${y}px)";
  c.style.opacity = "1";
  clearTimeout(window.__lootdenPointerTimer);
  window.__lootdenPointerTimer = setTimeout(() => (c.style.opacity = "0"), 4000);
})()`;
const POINTER_WORLD = 1077;

export class WebBrowser {
  private win: BaseWindow | null = null;
  private shell: WebContentsView | null = null;
  private tabs: Tab[] = [];
  private active = 0;
  private nextId = 1;
  /** Height of the toolbar in window pixels, as the page measured it. */
  private toolbar = 96;
  /** A video or game in a tab went full screen: it covers the whole window. */
  private htmlFullscreen = false;
  /** Whether the window was full screen before the page made it so, to put it back after. */
  private wasFullscreen = false;
  /** Sites allowed the camera or microphone this session. */
  private mediaAllowed = new Set<string>();
  private configured = new Set<string>();
  /** The signed-in person's browser rules; null lets everything through (an older server). */
  private policy: BrowserPolicy | null = null;

  constructor(private readonly deps: BrowserDeps) {}

  get isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  private get kids(): boolean {
    return this.policy?.mode === "kids";
  }

  private get partition(): string {
    return this.kids ? KIDS_PARTITION : BROWSER_PARTITION;
  }

  /** Opens the browser over LootDen, on a page or the start page, under the signed-in person's rules. */
  async open(url?: string): Promise<void> {
    const target = url && isBrowsable(url) ? url : "";
    const policy = await this.deps.policy().catch(() => null);
    if (this.isOpen) {
      if ((policy?.mode ?? "open") === (this.policy?.mode ?? "open")) {
        this.policy = policy;
        if (target) this.newTab(target);
        this.win!.show();
        this.win!.focus();
        return;
      }
      // Someone else signed in meanwhile, with other rules: start over under theirs.
      const closing = this.win!;
      await new Promise<void>((done) => {
        closing.once("closed", () => done());
        closing.close();
      });
    }
    if (this.isOpen) return;
    this.policy = policy;
    this.configureSession(this.partition);
    const main = this.deps.mainWindow();
    const fullscreen = !!main?.isFullScreen() || this.deps.handheld();
    const bounds = main && !main.isDestroyed() ? main.getBounds() : undefined;
    const win = new BaseWindow({
      ...(bounds ?? { width: 1400, height: 900 }),
      minWidth: 640,
      minHeight: 420,
      fullscreen,
      backgroundColor: "#0d0820",
      title: "LootDen browser",
      icon: this.deps.icon,
      ...(this.deps.customFrame ? { titleBarStyle: "hidden" as const, titleBarOverlay: { color: "#0d0820", symbolColor: "#f3eeff", height: this.deps.titlebarHeight } } : {}),
    });
    this.win = win;
    const theme = this.settings().offlineTheme;
    if (this.deps.customFrame && theme?.bg && theme.text) win.setTitleBarOverlay({ color: theme.bg, symbolColor: theme.text, height: this.deps.titlebarHeight });
    const shellView = new WebContentsView({ webPreferences: { preload: this.deps.preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    this.shell = shellView;
    win.contentView.addChildView(shellView);
    shellView.setBackgroundColor("#0d0820");
    shellView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    shellView.webContents.on("will-navigate", (e) => e.preventDefault());
    shellView.webContents.on("did-finish-load", () => {
      shellView.webContents.setZoomFactor(this.deps.handheld() ? this.deps.zoom : 1);
      this.push();
    });
    shellView.webContents.on("before-input-event", (e, input) => this.shortcut(e, input));
    void shellView.webContents.loadFile(this.deps.shellPage);

    this.tabs = [];
    this.newTab(target);
    win.on("resize", () => this.layout());
    win.on("enter-full-screen", () => this.push());
    win.on("leave-full-screen", () => this.push());
    win.on("closed", () => {
      for (const t of this.tabs) t.view?.webContents.close();
      this.tabs = [];
      this.win = null;
      this.shell = null;
      this.htmlFullscreen = false;
      const m = this.deps.mainWindow();
      if (m && !m.isDestroyed()) {
        m.show();
        m.focus();
      }
    });
    // LootDen hides behind it, so its own controller navigation doesn't act on the same presses.
    if (main && !main.isDestroyed()) main.hide();
    this.layout();
  }

  close(): void {
    if (this.isOpen) this.win!.close();
  }

  // ---- Tabs ---------------------------------------------------------------------------

  private get tab(): Tab | undefined {
    return this.tabs[this.active];
  }

  newTab(url = ""): void {
    const tab: Tab = { id: this.nextId++, view: null, title: "New tab", url: "", favicon: "", pointer: { x: 200, y: 200 } };
    this.tabs.push(tab);
    this.select(tab.id);
    if (url) this.load(tab, url);
  }

  closeTab(id: number): void {
    const at = this.tabs.findIndex((t) => t.id === id);
    if (at < 0) return;
    const [tab] = this.tabs.splice(at, 1);
    if (tab!.view) {
      this.win?.contentView.removeChildView(tab!.view);
      tab!.view.webContents.close();
    }
    if (!this.tabs.length) return this.close();
    this.active = Math.min(this.active > at ? this.active - 1 : this.active, this.tabs.length - 1);
    this.select(this.tabs[this.active]!.id);
  }

  select(id: number): void {
    const at = this.tabs.findIndex((t) => t.id === id);
    if (at < 0 || !this.win) return;
    for (const t of this.tabs) if (t.view && t.id !== id) this.win.contentView.removeChildView(t.view);
    this.active = at;
    this.htmlFullscreen = false;
    const view = this.tabs[at]!.view;
    if (view) this.win.contentView.addChildView(view, 0);
    this.layout();
    this.push();
  }

  /** Cycles tabs: LB and RB, Ctrl+Tab. */
  step(by: number): void {
    if (this.tabs.length < 2) return;
    this.select(this.tabs[(this.active + by + this.tabs.length) % this.tabs.length]!.id);
  }

  /** The address bar: a web address, a site name or a search. */
  navigate(text: string): void {
    const tab = this.tab;
    const url = addressToUrl(text, this.settings().browserSearch, this.kids ? KID_SEARCH : undefined);
    if (tab && url) this.load(tab, url);
  }

  /** The start page in the current tab (the page itself is closed). */
  home(): void {
    const tab = this.tab;
    if (!tab?.view) return;
    this.win?.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    Object.assign(tab, { view: null, title: "New tab", url: "", favicon: "" });
    this.layout();
    this.push();
  }

  private load(tab: Tab, url: string): void {
    if (!isBrowsable(url)) return;
    if (!tab.view) {
      tab.view = this.createView(tab);
      if (this.tab === tab) this.win?.contentView.addChildView(tab.view, 0);
      this.layout();
    }
    if (!siteAllowed(url, this.policy)) return this.showBlocked(tab, url);
    tab.blocked = undefined;
    tab.url = url;
    tab.title = siteName(url);
    void tab.view.webContents.loadURL(url).catch(() => {});
    if (this.tab === tab) tab.view.webContents.focus();
    this.push();
  }

  /** The tab says the site isn't allowed, instead of opening it. */
  private showBlocked(tab: Tab, url: string): void {
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    tab.blocked = siteName(url);
    tab.url = url;
    tab.title = `${tab.blocked} is blocked`;
    tab.favicon = "";
    void wc.loadFile(this.deps.blockedPage, { query: { site: tab.blocked, kids: this.kids ? "1" : "" } }).catch(() => {});
    this.push();
  }

  private createView(tab: Tab): WebContentsView {
    const view = new WebContentsView({ webPreferences: { partition: this.partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, safeDialogs: true } });
    view.setBackgroundColor("#ffffff");
    const wc = view.webContents;
    const update = () => {
      // The blocked page keeps the address that was asked for.
      if (wc.isDestroyed() || (tab.blocked && wc.getURL().startsWith("file:"))) return;
      tab.blocked = undefined;
      tab.url = wc.getURL();
      tab.title = wc.getTitle() || siteName(tab.url);
      this.push();
    };
    wc.on("page-title-updated", update);
    wc.on("did-navigate", update);
    wc.on("did-navigate-in-page", update);
    wc.on("did-start-loading", () => this.push());
    wc.on("did-stop-loading", update);
    wc.on("page-favicon-updated", (_e, icons) => {
      tab.favicon = icons.find((i) => /^https:\/\//.test(i)) ?? "";
      this.push();
    });
    // Links that open a new window become a new tab; launcher links ask first; nothing else opens.
    wc.setWindowOpenHandler(({ url }) => {
      if (isBrowsable(url)) this.newTab(url);
      else void this.external(url);
      return { action: "deny" };
    });
    const guard = (e: { preventDefault(): void }, url: string) => {
      if (isBrowsable(url) || url === "about:blank") return;
      e.preventDefault();
      void this.external(url);
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);
    wc.on("before-input-event", (e, input) => this.shortcut(e, input));
    wc.on("enter-html-full-screen", () => {
      this.htmlFullscreen = true;
      this.wasFullscreen = !!this.win?.isFullScreen();
      if (this.win && !this.wasFullscreen) this.win.setFullScreen(true);
      this.layout();
    });
    wc.on("leave-html-full-screen", () => {
      this.htmlFullscreen = false;
      if (this.win && !this.wasFullscreen && this.win.isFullScreen()) this.win.setFullScreen(false);
      this.layout();
    });
    wc.on("render-process-gone", () => {
      tab.title = "This page crashed. Reload to try again.";
      this.push();
    });
    return view;
  }

  /** A link out of the web: a store launcher (after asking) or mail. Anything else is ignored. */
  private async external(url: string): Promise<void> {
    // Kid-safe browsing stays inside the browser.
    if (this.kids) return;
    if (/^mailto:/i.test(url)) return void shell.openExternal(url);
    if (!isStoreLaunchUrl(url) || !this.win) return;
    const scheme = url.split(":")[0];
    const { response } = await dialog.showMessageBox(this.win, {
      type: "question",
      buttons: ["Open", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: "Open the launcher?",
      detail: `This page wants to open ${scheme}: links in another app.`,
    });
    if (response === 0) await shell.openExternal(url).catch(() => {});
  }

  /** Keyboard shortcuts work the same in the toolbar and on a page. */
  private shortcut(e: { preventDefault(): void }, input: Electron.Input): void {
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    const act = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (ctrl && key === "l") act(() => this.focusAddress());
    else if (ctrl && key === "t") act(() => (this.newTab(), this.focusAddress()));
    else if (ctrl && key === "w") act(() => this.tab && this.closeTab(this.tab.id));
    else if (ctrl && key === "tab") act(() => this.step(input.shift ? -1 : 1));
    else if (input.alt && key === "arrowleft") act(() => this.tab?.view?.webContents.navigationHistory.goBack());
    else if (input.alt && key === "arrowright") act(() => this.tab?.view?.webContents.navigationHistory.goForward());
    else if (key === "f5" || (ctrl && key === "r")) act(() => this.tab?.view?.webContents.reload());
    else if (key === "f11") act(() => this.win?.setFullScreen(!this.win.isFullScreen()));
  }

  private focusAddress(): void {
    this.shell?.webContents.focus();
    this.shell?.webContents.send("gm:browser:focusAddress");
  }

  // ---- Layout and state --------------------------------------------------------------

  private layout(): void {
    if (!this.win || !this.shell) return;
    const { width, height } = this.win.getContentBounds();
    const view = this.tab?.view;
    if (view && this.htmlFullscreen) {
      this.shell.setBounds({ x: 0, y: 0, width, height: 0 });
      view.setBounds({ x: 0, y: 0, width, height });
      return;
    }
    // The start page is the toolbar page itself, filling the window.
    const top = view ? Math.min(this.toolbar, height) : height;
    this.shell.setBounds({ x: 0, y: 0, width, height: top });
    view?.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }

  private settings() {
    return this.deps.settings().get();
  }

  private bookmarks(): Bookmark[] {
    if (this.kids) return KID_BOOKMARKS.filter((b) => siteAllowed(b.url, this.policy));
    const saved = this.settings().browserBookmarks;
    return saved ? cleanBookmarks(saved) : DEFAULT_BOOKMARKS;
  }

  state() {
    const wc = this.tab?.view?.webContents;
    return {
      tabs: this.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, favicon: t.favicon, start: !t.view, loading: !!t.view && t.view.webContents.isLoading(), blocked: !!t.blocked })),
      active: this.tab?.id ?? 0,
      canGoBack: !!wc?.navigationHistory.canGoBack(),
      canGoForward: !!wc?.navigationHistory.canGoForward(),
      bookmarks: this.bookmarks(),
      launchers: this.kids ? [] : launcherShortcuts(process.platform),
      search: this.kids ? "kiddle" : (this.settings().browserSearch ?? "google"),
      engines: this.kids ? [{ id: "kiddle", name: "Kiddle" }] : Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
      kids: this.kids,
      theme: this.settings().offlineTheme ?? null,
      frame: { custom: this.deps.customFrame, fullscreen: !!this.win?.isFullScreen(), height: this.deps.titlebarHeight, handheld: this.deps.handheld() },
    };
  }

  private push(): void {
    if (this.shell && !this.shell.webContents.isDestroyed()) this.shell.webContents.send("gm:browser:state", this.state());
  }

  // ---- The controller pointer ---------------------------------------------------------

  /** Moves the pointer by the stick, keeping it on the page. */
  pointer(dx: number, dy: number): void {
    const tab = this.tab;
    const wc = tab?.view?.webContents;
    if (!tab || !wc) return;
    const { width, height } = tab.view!.getBounds();
    tab.pointer.x = Math.round(Math.max(0, Math.min(width - 1, tab.pointer.x + dx)));
    tab.pointer.y = Math.round(Math.max(0, Math.min(height - 1, tab.pointer.y + dy)));
    wc.sendInputEvent({ type: "mouseMove", x: tab.pointer.x, y: tab.pointer.y });
    void wc.executeJavaScriptInIsolatedWorld(POINTER_WORLD, [{ code: pointerScript(tab.pointer.x, tab.pointer.y) }]).catch(() => {});
  }

  click(button: "left" | "right" = "left"): void {
    const tab = this.tab;
    const wc = tab?.view?.webContents;
    if (!tab || !wc) return;
    const { x, y } = tab.pointer;
    wc.focus();
    wc.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: 1 });
  }

  scroll(dx: number, dy: number): void {
    const tab = this.tab;
    const wc = tab?.view?.webContents;
    if (!tab || !wc) return;
    // Wheel deltas run the other way to page movement: negative scrolls down.
    wc.sendInputEvent({ type: "mouseWheel", x: tab.pointer.x, y: tab.pointer.y, deltaX: -dx, deltaY: -dy, canScroll: true });
  }

  /** The d-pad on a page: arrow keys, which also move around YouTube's and other TV-style pages. */
  key(key: "Up" | "Down" | "Left" | "Right" | "Enter" | "Escape" | "Space"): void {
    const wc = this.tab?.view?.webContents;
    if (!wc) return;
    wc.focus();
    wc.sendInputEvent({ type: "keyDown", keyCode: key });
    if (key === "Enter" || key === "Space") wc.sendInputEvent({ type: "char", keyCode: key === "Enter" ? "\r" : " " });
    wc.sendInputEvent({ type: "keyUp", keyCode: key });
  }

  // ---- Session and IPC ----------------------------------------------------------------

  private configureSession(partition: string): void {
    if (this.configured.has(partition)) return;
    this.configured.add(partition);
    const ses: Session = session.fromPartition(partition);
    // The browser rules, for every page and frame, redirects included: blocked sites don't load,
    // and kid-safe browsing gets the search engines' safe search.
    ses.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      const frame = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
      if (!frame || !this.policy) return callback({});
      // Frames inside a page (videos, games) only answer to the blocked list; whole pages to all the rules.
      const allowed = siteAllowed(details.url, details.resourceType === "subFrame" ? { ...this.policy, mode: "open" } : this.policy);
      if (!allowed) {
        callback({ cancel: true });
        const tab = details.resourceType === "mainFrame" ? this.tabs.find((t) => t.view?.webContents.id === details.webContentsId) : undefined;
        if (tab) setImmediate(() => this.showBlocked(tab, details.url));
        return;
      }
      const safe = this.kids ? safeSearchUrl(details.url) : null;
      callback(safe ? { redirectURL: safe } : {});
    });
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (SITE_PERMISSIONS.has(permission)) return callback(true);
      if (permission !== "media" || !this.win) return callback(false);
      let site = "";
      try {
        site = new URL(details.requestingUrl).origin;
      } catch {
        return callback(false);
      }
      if (this.mediaAllowed.has(site)) return callback(true);
      const what = (details as { mediaTypes?: string[] }).mediaTypes?.includes("video") ? "camera and microphone" : "microphone";
      void dialog
        .showMessageBox(this.win, { type: "question", buttons: ["Allow", "Block"], defaultId: 1, cancelId: 1, message: `Let ${siteName(site)} use your ${what}?`, detail: "Until LootDen closes." })
        .then(({ response }) => {
          if (response === 0) this.mediaAllowed.add(site);
          callback(response === 0 && !wc.isDestroyed());
        });
    });
    // Mods for the truck games go straight to the game (not on kid-safe browsing, where the server turns them away anyway).
    ses.on("will-download", (_e, item, wc) => {
      if (this.kids) return;
      try {
        this.deps.onDownload?.(item, wc, this.win);
      } catch {
        /* a normal download, then */
      }
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => SITE_PERMISSIONS.has(permission) || (permission === "media" && this.mediaAllowed.has(requestingOrigin)));
  }

  /** Calls from the toolbar page only. */
  private fromShell(e: IpcMainInvokeEvent): void {
    if (!this.shell || e.sender !== this.shell.webContents) throw new Error("Not allowed from this page");
  }

  registerIpc(): void {
    const on = <A extends unknown[]>(name: string, fn: (...args: A) => unknown) =>
      ipcMain.handle(`gm:browser:${name}`, (e, ...args) => {
        this.fromShell(e);
        return fn(...(args as A));
      });
    on("state", () => this.state());
    on("layout", (height: unknown) => {
      if (typeof height !== "number" || !Number.isFinite(height)) return;
      const zoom = this.shell?.webContents.getZoomFactor() ?? 1;
      this.toolbar = Math.max(40, Math.min(400, Math.ceil(height * zoom)));
      this.layout();
    });
    on("navigate", (text: unknown) => typeof text === "string" && this.navigate(text.slice(0, 4096)));
    on("back", () => this.tab?.view?.webContents.navigationHistory.goBack());
    on("forward", () => this.tab?.view?.webContents.navigationHistory.goForward());
    on("reload", () => this.tab?.view?.webContents.reload());
    on("stop", () => this.tab?.view?.webContents.stop());
    on("home", () => this.home());
    on("newTab", () => this.newTab());
    on("closeTab", (id: unknown) => typeof id === "number" && this.closeTab(id));
    on("selectTab", (id: unknown) => typeof id === "number" && this.select(id));
    on("stepTab", (by: unknown) => (by === 1 || by === -1) && this.step(by));
    on("open", (url: unknown) => typeof url === "string" && isBrowsable(url) && this.tab && this.load(this.tab, url));
    on("bookmarks", (list: unknown) => {
      if (this.kids) return;
      this.deps.settings().update({ browserBookmarks: cleanBookmarks(list) });
      this.push();
    });
    on("resetBookmarks", () => {
      if (this.kids) return;
      this.deps.settings().update({ browserBookmarks: undefined });
      this.push();
    });
    /** The star in the address bar: adds the page, or takes it off again. */
    on("toggleBookmark", () => {
      const tab = this.tab;
      if (this.kids || !tab?.view || !isBrowsable(tab.url) || tab.blocked) return;
      const list = this.bookmarks();
      const href = new URL(tab.url).toString();
      const next = list.some((b) => b.url === href) ? list.filter((b) => b.url !== href) : [...list, { title: tab.title || siteName(href), url: href }];
      this.deps.settings().update({ browserBookmarks: cleanBookmarks(next) });
      this.push();
    });
    on("search", (engine: unknown) => {
      if (typeof engine === "string" && engine in SEARCH_ENGINES) this.deps.settings().update({ browserSearch: engine as SearchEngine });
      this.push();
    });
    on("launch", async (id: unknown) => {
      if (this.kids) return;
      const l = launcherShortcuts(process.platform).find((x) => x.id === id);
      if (l) await shell.openExternal(l.url);
    });
    on("close", () => this.close());
    on("fullscreen", () => this.win?.setFullScreen(!this.win.isFullScreen()));
    on("focusPage", () => this.tab?.view?.webContents.focus());
    on("focusShell", () => this.shell?.webContents.focus());
    on("pointer", (dx: unknown, dy: unknown) => typeof dx === "number" && typeof dy === "number" && this.pointer(Math.max(-80, Math.min(80, dx)), Math.max(-80, Math.min(80, dy))));
    on("click", (button: unknown) => this.click(button === "right" ? "right" : "left"));
    on("scroll", (dx: unknown, dy: unknown) => typeof dx === "number" && typeof dy === "number" && this.scroll(Math.max(-400, Math.min(400, dx)), Math.max(-400, Math.min(400, dy))));
    on("key", (key: unknown) => {
      if (typeof key === "string" && ["Up", "Down", "Left", "Right", "Enter", "Escape", "Space"].includes(key)) this.key(key as "Up");
    });
  }
}
