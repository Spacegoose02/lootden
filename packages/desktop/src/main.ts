import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, safeStorage, screen, session, shell, Tray, type IpcMainInvokeEvent } from "electron";
import {
  isBrowsable,
  addBiosFile,
  adoptFolder,
  findCopies,
  isManifest,
  runLocalSetup,
  saveManifest,
  biosFromServer,
  emulatorInfo,
  emulatorOverview,
  installEmulator,
  playEmulated,
  backupSaves,
  expandSavePath,
  offlineAllowance,
  switchSaveSlot,
  watchPlayTime,
  findExecutable,
  findSevenZip,
  GameServerClient,
  installGame,
  launchAndTrack,
  listDrives,
  listProcesses,
  pcReport,
  processesIn,
  runningStoreGames,
  streamWithMoonlight,
  syncSunshine,
  firstExisting,
  streamingPaths,
  listInstalled,
  listWorkshopItems,
  downloadWorkshopItem,
  ensureSteamCmd,
  installWorkshopItem,
  removeWorkshopItem,
  prepareGame,
  restoreSaves,
  uploadInstalledFolder,
  type PrepareStep,
  saveExecutable,
  scanStoreGames,
  steamLibraryCover,
  cleanPolicy,
  type BrowserPolicy,
  STORE_SCANNERS,
  isStoreLaunchUrl,
  robloxPlaceOf,
  robloxPlayId,
  trackRoblox,
  setRobloxFullscreen,
  uninstallGame,
  applyUpdate,
  undoUpdate,
  UpdateMismatchError,
  type InstallEvent,
} from "@lootden/client";
import { PRESENCE_INTERVAL_SECONDS, type Allowance, type LocalStoreGame, type PcCommand, type PlaySource, type RunningGame } from "@lootden/shared";
import { isExternalLink, isFile, onOrigin, permissionAllowed } from "./links.js";
import { SettingsStore, type DesktopSettings } from "./settings.js";
import { WebBrowser } from "./browser.js";
import { TruckMods } from "./truckmods.js";
import { downloadUpdate, installKind, launchUpdate, pickUpdate, verifyUpdate, type AvailableUpdate } from "./updater.js";

/** Emulators live in the app's data folder unless the user moved them. */
const toolsDir = () => settings.get().toolsDir || path.join(app.getPath("userData"), "Emulators");

// lootden:// is the current scheme; gamemanager:// still works for links and plugins from before the rename.
const PROTOCOLS = ["lootden", "gamemanager"];
const isDeepLink = (a: string) => PROTOCOLS.some((p) => a.startsWith(`${p}://`));
let win: BrowserWindow | null = null;
let settings: SettingsStore;
const running = new Map<string, AbortController>();
let pendingDeepLink: string | null = process.argv.find(isDeepLink) ?? null;
let tray: Tray | null = null;
/** Set once the app is really quitting, so closing the window stops hiding it. */
let quitting = false;
/** Games running now, so the app doesn't update itself in the middle of one. */
const playing = new Set<string>();
/** Started at login: stay in the tray until opened. */
const startHidden = process.argv.includes("--hidden");
/** The "LootDen (full screen)" shortcut, jump list task or a launcher like Steam asked for full screen. */
const launchFullscreen = process.argv.includes("--fullscreen");
/** The "Web browser" jump list task. */
const launchBrowser = process.argv.includes("--browser");
let browser: WebBrowser;
/** ATS and ETS2 mods: browser downloads into the game's mod folder, shared through the server. */
let truckMods: TruckMods;

// Keep settings from before the rename: the app's data folder used to be "Game Manager".
const legacyUserData = path.join(app.getPath("appData"), "Game Manager");
if (existsSync(legacyUserData)) app.setPath("userData", legacyUserData);

if (!app.requestSingleInstanceLock()) app.quit();
for (const p of PROTOCOLS) app.setAsDefaultProtocolClient(p);

/** The bundled page that asks for the server's address. */
const SETUP_PAGE = path.join(__dirname, "..", "setup", "index.html");

const origin = () => {
  try {
    return new URL(settings.get().serverUrl).origin;
  } catch {
    return "";
  }
};

/** IPC is only honoured from the configured server's pages (or the local setup page for setup calls). */
function fromServer(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? "";
  if (!origin() || !url.startsWith(origin() + "/")) throw new Error("Not allowed from this page");
}

const OFFLINE_PAGE = path.join(__dirname, "..", "setup", "offline.html");
/** The built-in browser's toolbar and start page. */
const BROWSER_PAGE = path.join(__dirname, "..", "setup", "browser.html");

/** Links out of LootDen's pages: the built-in browser on a handheld (or when chosen), otherwise the system's. */
function openLink(url: string): void {
  const choice = settings.get().browserLinks ?? "auto";
  const inApp = choice === "on" || (choice === "auto" && handheldActive(settings.get()));
  if (inApp && isBrowsable(url)) void browser.open(url);
  else if (isExternalLink(url)) void shell.openExternal(url);
}
/** The theme colours the offline page uses (see offlineTheme in the web UI's theme.ts). */
const OFFLINE_THEME_KEYS = ["bg", "bg2", "panel", "border", "text", "muted", "accent", "accent2", "accentText"] as const;

/** Whether the call comes from the app's own page, not just any file:// page (one on a network share, say). */
const isAppPage = (e: IpcMainInvokeEvent, page: string) => isFile(e.senderFrame?.url ?? "", page);

/** The offline page, loaded from the app's files. */
function fromLocal(e: IpcMainInvokeEvent): void {
  if (!isAppPage(e, OFFLINE_PAGE)) throw new Error("Not allowed from this page");
}

/** Whether a LootDen server answers at the address, within a few seconds. */
async function serverUp(at = origin()): Promise<boolean> {
  if (!at) return false;
  const health = await net
    .fetch(`${at}/api/health`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.json() as Promise<{ status?: string }>)
    .catch(() => null);
  return health?.status === "ok";
}

/** The server can't be reached: show the games on this PC, which play without it. */
function showOffline(): void {
  const theme = settings.get().offlineTheme;
  if (customFrame) win?.setTitleBarOverlay({ color: theme?.bg ?? "#0d0820", symbolColor: theme?.text ?? "#f3eeff", height: TITLEBAR_HEIGHT });
  void win?.loadFile(OFFLINE_PAGE).catch(() => {});
}

/** Back online: open the server's pages and send the play time recorded while offline. */
async function goOnline(): Promise<void> {
  await win?.loadURL(origin());
  void flushPendingPlays();
}

/** 7za shipped with the app: in resources/ when packaged, in vendor/ when run from source. */
function bundled7za(): string {
  const platform = process.platform === "win32" ? "win" : "linux";
  const file = process.platform === "win32" ? "7za.exe" : "7za";
  const packaged = path.join(process.resourcesPath ?? "", "7zip", platform, file);
  return app.isPackaged ? packaged : path.join(__dirname, "..", "vendor", "7zip", platform, file);
}

/** A full 7-Zip install (handles RAR) wins over the bundled 7za (zip and 7z only). */
async function sevenZipPath(): Promise<string> {
  const system = await findSevenZip("").catch(() => null);
  if (system?.supportsRar) return system.path;
  return existsSync(bundled7za()) ? bundled7za() : (system?.path ?? "");
}

/** Runs an installer with a UAC prompt and waits for it (and anything it starts) to close. */
function runElevated(file: string, args: string[]): Promise<void> {
  const q = (x: string) => `'${x.replace(/'/g, "''")}'`;
  // Inno wants /DIR="C:\a b"; NSIS wants /D=C:\a b unquoted (and last).
  const quoteArg = (a: string) => (a.includes(" ") && !a.startsWith("/D=") ? a.replace(/^([^=]+=)(.*)$/, '$1"$2"') : a);
  const argList = args.length ? ` -ArgumentList ${q(args.map(quoteArg).join(" "))}` : "";
  const script = `Start-Process -FilePath ${q(file)} -WorkingDirectory ${q(path.dirname(file))}${argList} -Verb RunAs -Wait`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(/canceled by the user/i.test(err) ? "The installer was cancelled" : err.trim() || `Installer exited with ${code}`))));
  });
}

async function sevenZip() {
  const p = await sevenZipPath();
  if (!p) throw new Error("7-Zip is needed for save backups");
  return { path: p, supportsRar: false };
}

/** Uploads the game's saves if it has a save location and the folder exists; null otherwise. */
async function syncSaves(api: GameServerClient, gameId: string, installDir: string) {
  // A game removed from the server has nowhere to back up to.
  const detail = await api.getGame(gameId).catch(() => null);
  if (!detail?.savePath) return null;
  const dir = await expandSavePath(detail.savePath, installDir);
  if (!existsSync(dir)) return { error: `No saves found at ${dir}` };
  const backup = await backupSaves(api, await sevenZip(), gameId, dir, os.hostname());
  return { backupId: backup.id, size: backup.size };
}

/** The session cookie whose person was last checked against the token, so it's asked once per sign-in. */
let checkedSession = "";

/** Who a token or session belongs to; null when the server can't say. */
async function whoIs(headers: Record<string, string>): Promise<number | null> {
  const res = await net.fetch(`${origin()}/api/me`, { headers, signal: AbortSignal.timeout(5000) }).catch(() => null);
  const body = res?.ok ? ((await res.json().catch(() => null)) as { user?: { id: number } | null } | null) : null;
  return body?.user?.id ?? null;
}

/**
 * The device token for whoever is signed in to LootDen's window. Each profile gets its own the
 * first time it's needed, so play time, limits and saves follow the person, not the first one
 * who signed in on this PC. Without a session (offline, signed out) the last token is used.
 */
async function client(): Promise<GameServerClient> {
  const s = settings.get();
  const [cookie] = await session.defaultSession.cookies.get({ url: s.serverUrl, name: "gm_session" }).catch(() => []);
  const use = (token: string) => new GameServerClient({ serverUrl: s.serverUrl, apiToken: token });
  if (s.apiToken && (!cookie || cookie.value === checkedSession)) return use(s.apiToken);
  if (!cookie) throw new Error("Sign in first");
  const person = await whoIs({ Cookie: `gm_session=${cookie.value}` });
  if (person === null) {
    if (s.apiToken) return use(s.apiToken);
    throw new Error("Sign in first");
  }
  // Tokens from before profile tokens: find out whose it is once.
  const tokenUser = s.apiToken ? (s.apiTokenUser ?? (await whoIs({ Authorization: `Bearer ${s.apiToken}` }))) : null;
  const tokens: Record<string, string> = { ...(s.profileTokens ?? {}), ...(s.apiToken && tokenUser !== null ? { [tokenUser]: s.apiToken } : {}) };
  checkedSession = cookie.value;
  let token = tokens[person];
  if (!token) {
    const res = await net.fetch(`${origin()}/api/me/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `gm_session=${cookie.value}` },
      body: JSON.stringify({ name: `Desktop app (${os.hostname()})` }),
    });
    if (!res.ok) throw new Error(`Could not register this computer (${res.status})`);
    token = ((await res.json()) as { token: string }).token;
    tokens[person] = token;
  }
  if (token !== s.apiToken || s.apiTokenUser !== person) settings.update({ apiToken: token, apiTokenUser: person, profileTokens: tokens, keptAllowance: undefined });
  return use(token);
}

/**
 * The web browser's rules for whoever is signed in to LootDen's window (else this computer's
 * token). The last answer is kept, so a kid profile stays kid-safe while the server is away.
 */
async function browserPolicy(): Promise<BrowserPolicy | null> {
  const s = settings.get();
  const kept = s.browserPolicy ? cleanPolicy(s.browserPolicy) : null;
  if (!origin()) return kept;
  const [cookie] = await session.defaultSession.cookies.get({ url: s.serverUrl, name: "gm_session" }).catch(() => []);
  const headers: Record<string, string> = cookie ? { Cookie: `gm_session=${cookie.value}` } : s.apiToken ? { Authorization: `Bearer ${s.apiToken}` } : {};
  if (!Object.keys(headers).length) return kept;
  const res = await net.fetch(`${origin()}/api/me/browser`, { headers, signal: AbortSignal.timeout(4000) }).catch(() => null);
  // A server from before browser rules has none to give.
  if (res?.status === 404) {
    if (kept) settings.update({ browserPolicy: undefined });
    return null;
  }
  if (!res?.ok) return kept;
  const policy = cleanPolicy(await res.json().catch(() => null));
  if (JSON.stringify(policy) !== JSON.stringify(s.browserPolicy)) settings.update({ browserPolicy: policy });
  return policy;
}

/**
 * A client even when the server can't be reached to register this computer: calls through
 * it fail, which the offline paths expect.
 */
const clientOrOffline = () => client().catch(() => new GameServerClient({ serverUrl: settings.get().serverUrl, apiToken: "" }));

/** The profile whose token is in use on this PC: who is playing (undefined before profile tokens). */
const currentPlayer = () => settings.get().apiTokenUser;

/** A client with this profile's own token, so play time reaches the person who played. */
function clientFor(userId: number | undefined): GameServerClient | null {
  const s = settings.get();
  const token = userId === undefined ? s.apiToken : (s.profileTokens?.[userId] ?? (s.apiTokenUser === userId ? s.apiToken : undefined));
  return token ? new GameServerClient({ serverUrl: s.serverUrl, apiToken: token }) : null;
}

/**
 * Play time goes to the server; while it's out of reach it waits in the settings, with who
 * played, until the app is back online.
 */
async function recordPlay(api: GameServerClient, gameId: string, seconds: number, userId: number | undefined): Promise<boolean> {
  if (await api.reportActivity({ gameId, device: os.hostname(), event: "played", seconds, endedAt: new Date().toISOString() })) return true;
  settings.update({ pendingPlays: [...settings.get().pendingPlays, { gameId, seconds, playedAt: new Date().toISOString(), userId }] });
  return false;
}

/** The server's answer about today's play time for whoever plays on this PC. */
type TodayInfo = Allowance & { userId?: number; separateSaves?: boolean };

/**
 * Today's play time allowance, kept for when the server can't be reached. Null when the server
 * has no limits to give (an older server, or the service token).
 */
async function todaysAllowance(api: GameServerClient): Promise<TodayInfo | null> {
  try {
    const a = await api.allowance();
    settings.update({ keptAllowance: { allowance: a, limits: a.limits, at: new Date().toISOString() } });
    return a;
  } catch (err) {
    // Only a server from before limits (404) means there are none; anything else (offline, a
    // token that stopped working) goes by the last answer, so limits can't be dodged that way.
    if ((err as { status?: number }).status === 404) return null;
    const s = settings.get();
    if (!s.keptAllowance) return null;
    const kept = s.keptAllowance.allowance as TodayInfo;
    // Only this person's sessions count against their time.
    const mine = s.pendingPlays.filter((p) => p.userId === undefined || p.userId === s.apiTokenUser);
    return { ...offlineAllowance(s.keptAllowance, mine), userId: s.apiTokenUser ?? kept.userId, separateSaves: kept.separateSaves };
  }
}

/**
 * Other stores' games start in their own launchers, out of LootDen's sight: at least nobody
 * starts one when today's play time is used up or it's bedtime.
 */
async function checkPlayTime(url: string): Promise<void> {
  // Store pages, installs and Workshop items aren't playing.
  if (/^steam:\/\/(url|install|store|open)\//i.test(url) || /[?&]action=install\b/i.test(url)) return;
  const today = await todaysAllowance(await clientOrOffline());
  if (today && !today.canPlay) throw new Error(today.reason ?? "No play time left today");
}

/** Play time heads-ups: in the app, and as a Windows notification because the game is in front. */
function playNotice(gameId: string, title: string, body: string): void {
  win?.webContents.send("gm:progress", { gameId, type: "limit", title, message: body });
  if (Notification.isSupported()) new Notification({ title, body, urgency: "critical" }).show();
}

/** Watches a game against today's play time; returns the function that stops watching. */
function guardPlay(api: GameServerClient, gameId: string, title: string, today: TodayInfo | null, stop?: AbortController): () => void {
  if (!today?.limited) return () => {};
  return watchPlayTime({
    allowance: today,
    refresh: () => todaysAllowance(api),
    onWarn: (m) => playNotice(gameId, `${m} minute${m === 1 ? "" : "s"} of play time left`, `Time to find a save point in ${title}.`),
    onTimeUp: (grace) =>
      playNotice(gameId, "Time's up!", grace && stop ? `Save your game now: LootDen closes ${title} in ${grace} seconds.` : `That's today's play time. Save and take a break!`),
    onStop: () => stop?.abort(),
  });
}

/**
 * Save slots: on a PC several profiles share, put whoever played last's saves aside and bring
 * this person's back before the game starts. Needs the server (it says who's playing).
 */
async function useSaveSlot(api: GameServerClient, gameId: string, installDir: string, today: TodayInfo | null): Promise<void> {
  if (!today?.separateSaves || today.userId === undefined) return;
  // Offline, the details kept for the offline page say where the saves are.
  const detail = (await api.getGame(gameId).catch(() => cachedDetails(gameId))) as { savePath?: string | null } | null;
  if (!detail?.savePath) return;
  const dir = await expandSavePath(detail.savePath, installDir);
  const owners = settings.get().saveOwners ?? {};
  const result = await switchSaveSlot({
    saveDir: dir,
    slotsDir: path.join(app.getPath("userData"), "SaveSlots"),
    gameId,
    userId: today.userId,
    owner: owners[gameId] ?? null,
    restoreFromServer: async () => {
      const newest = (await api.listSaves(gameId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!newest) return false;
      await restoreSaves(api, await sevenZip(), gameId, newest.id, dir);
      return true;
    },
  });
  settings.update({ saveOwners: { ...settings.get().saveOwners, [gameId]: today.userId } });
  if (result === "swapped" || result === "restored") send({ gameId, type: "prepare", message: "Your saves are back in place", done: true });
}

let flushing = false;
async function flushPendingPlays(): Promise<void> {
  if (flushing || !settings.get().pendingPlays.length) return;
  flushing = true;
  try {
    const current = await client();
    for (const p of settings.get().pendingPlays) {
      // Each session goes to whoever played it, not whoever is signed in now.
      const api = clientFor(p.userId) ?? current;
      if (!(await api.reportActivity({ gameId: p.gameId, device: os.hostname(), event: "played", seconds: p.seconds, endedAt: p.playedAt }))) return;
      settings.update({ pendingPlays: settings.get().pendingPlays.filter((x) => x.playedAt !== p.playedAt || x.gameId !== p.gameId) });
    }
  } catch {
    // Still offline, or not signed in yet: try again on the next page load.
  } finally {
    flushing = false;
  }
}

// ---- Now Playing and parents' controls ------------------------------------------

/** Games started from LootDen that run now, with how to close them. */
const nowRunning = new Map<string, { game: RunningGame; stop?: AbortController }>();
/** Other launchers' games seen running, and when each was first seen. */
const storeSince = new Map<string, string>();
let storeGamesCache: { at: number; games: LocalStoreGame[] } | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let beating = false;
/** Installs a game from the server; set once the IPC handlers exist. */
let installRemote: ((gameId: string) => Promise<unknown>) | null = null;
/** Starts an installed game (lootden://play links, which Sunshine uses); set once the IPC handlers exist. */
let playRemote: ((gameId: string) => Promise<unknown>) | null = null;
/** Commands already carried out, so a repeat delivery does nothing twice. */
const handledCommands = new Set<string>();

/** A game LootDen started is running: it goes on the family's Now Playing board. */
function markRunning(gameId: string, title: string, source: PlaySource, stop?: AbortController): void {
  nowRunning.set(gameId, { game: { gameId, title, source, startedAt: new Date().toISOString() }, stop });
  lastPlayingNow = [...nowRunning.values()].map((r) => r.game);
  updateScreenshotKey(true);
  scheduleHeartbeat(1000);
}

async function storeGamesForPresence(): Promise<LocalStoreGame[]> {
  if (storeGamesCache && Date.now() - storeGamesCache.at < 10 * 60_000) return storeGamesCache.games;
  const { disabled, folders } = settings.get().storeScan;
  const games = await scanStoreGames(STORE_SCANNERS, process.platform, { disabled, folders }).catch(() => [] as LocalStoreGame[]);
  storeGamesCache = { at: Date.now(), games };
  return games;
}

/** Closes everything running from these folders (games from other launchers). */
async function closeFolders(dirs: string[]): Promise<void> {
  for (const pid of processesIn(await listProcesses(), dirs)) {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
}

/** A parent's message or "close the game", sent from the Now Playing board. */
function runCommand(cmd: PcCommand): void {
  if (handledCommands.has(cmd.id)) return;
  handledCommands.add(cmd.id);
  if (cmd.kind === "message") {
    playNotice("", `Message from ${cmd.from}`, cmd.text);
    return;
  }
  if (cmd.kind === "install") {
    playNotice(cmd.gameId, `${cmd.from} sent you ${cmd.title}`, "It's downloading now and will be ready to play here.");
    void installRemote?.(cmd.gameId).then(
      () => playNotice(cmd.gameId, `${cmd.title} is ready`, `${cmd.from} sent it to this PC. Have fun!`),
      (err: Error) => {
        if (!/Already install/.test(err.message)) playNotice(cmd.gameId, `Couldn't install ${cmd.title}`, err.message);
      },
    );
    return;
  }
  const mine = nowRunning.get(cmd.gameId);
  const title = mine?.game.title ?? cmd.gameId;
  playNotice(cmd.gameId, `${cmd.from} is closing ${title}`, `${cmd.text ? `${cmd.text} ` : ""}Save your game now: it closes in 60 seconds.`);
  setTimeout(() => {
    if (mine?.stop) return mine.stop.abort();
    const m = /^store:([^:]+):(.+)$/.exec(cmd.gameId);
    const store = m && storeGamesCache?.games.find((g) => g.addon === m[1] && g.externalId === m[2]);
    if (store) void closeFolders([store.installDir]).catch(() => {});
  }, 60_000);
}

/** Tells the server what runs on this PC, about every half minute, and carries out parents' commands. */
async function heartbeat(): Promise<void> {
  if (beating || !settings.get().apiToken) return;
  beating = true;
  try {
    const mine = new Set(nowRunning.keys());
    const stores = await storeGamesForPresence();
    const procs = stores.length ? await listProcesses().catch(() => []) : [];
    const playingNow = [...[...nowRunning.values()].map((r) => r.game), ...runningStoreGames(procs, stores, storeSince, mine)];
    lastPlayingNow = playingNow;
    updateScreenshotKey(playingNow.length > 0);
    const api = clientFor(currentPlayer()) ?? (await client());
    const answer = await api.presence({ device: os.hostname(), playing: playingNow, pc: { ...(await pcReport(app.getVersion())), streamGames: settings.get().sunshine?.streamGames ?? [] } });
    for (const cmd of answer.commands) runCommand(cmd);
  } catch {
    // Offline, signed out or an older server: try again next time.
  } finally {
    beating = false;
    scheduleHeartbeat(PRESENCE_INTERVAL_SECONDS * 1000);
  }
}

function scheduleHeartbeat(ms: number): void {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => void heartbeat(), ms);
  heartbeatTimer.unref?.();
}

// ---- Screenshot wall ------------------------------------------------------------

/** Shares the screen to the family wall. Only taken while a game runs, so it never steals the keys from other programs. */
const SCREENSHOT_KEY = "Ctrl+Shift+S";
let shotKeyOn = false;

/** The screenshot key works while a game runs (LootDen's or another launcher's). */
function updateScreenshotKey(gamesRunning: boolean): void {
  if (gamesRunning === shotKeyOn || !app.isReady()) return;
  if (gamesRunning) shotKeyOn = globalShortcut.register(SCREENSHOT_KEY.replace("Ctrl", "CommandOrControl"), () => void shareScreenshot());
  else {
    globalShortcut.unregister(SCREENSHOT_KEY.replace("Ctrl", "CommandOrControl"));
    shotKeyOn = false;
  }
}

let lastPlayingNow: RunningGame[] = [];
let shooting = false;

/** Takes the screen the mouse is on and puts it on the family screenshot wall, with the game running. */
async function shareScreenshot(): Promise<void> {
  if (shooting) return;
  shooting = true;
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
    const source = sources.find((x) => x.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error("Couldn't capture the screen");
    const jpeg = source.thumbnail.toJPEG(88);
    const game = lastPlayingNow[0];
    const q = new URLSearchParams({ width: String(source.thumbnail.getSize().width), height: String(source.thumbnail.getSize().height) });
    if (game && (game.source === "lootden" || game.source === "emulated")) q.set("gameId", game.gameId);
    if (game) q.set("title", game.title);
    const api = clientFor(currentPlayer()) ?? (await client());
    const res = await net.fetch(`${origin()}/api/screenshots?${q}`, { method: "POST", headers: api.headers({ "content-type": "image/jpeg" }), body: new Uint8Array(jpeg) });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The server answered ${res.status}`);
    if (Notification.isSupported()) new Notification({ title: "📸 Shared with the family", body: game ? `Your ${game.title} screenshot is on the wall.` : "Your screenshot is on the wall.", silent: true }).show();
  } catch (err) {
    if (Notification.isSupported()) new Notification({ title: "Couldn't share the screenshot", body: (err as Error).message }).show();
  } finally {
    shooting = false;
  }
}

// ---- Game streaming (Sunshine and Moonlight) ------------------------------------

const sunshineAuth = (): { user: string; pass: string } | null => {
  const s = settings.get().sunshine;
  if (!s) return null;
  try {
    return { user: s.user, pass: s.sealed ? safeStorage.decryptString(Buffer.from(s.pass, "base64")) : s.pass };
  } catch {
    return null;
  }
};

/** The LootDen games on this PC that are ready to play (not still installers), for Sunshine. */
async function playableGames(): Promise<Array<{ gameId: string; title: string }>> {
  const games = await listInstalled(await searchDirs());
  return games.filter((g) => !g.needsSetup || g.installedDir).map((g) => ({ gameId: g.gameId, title: g.title }));
}

/** Adds this PC's LootDen games to Sunshine (the ones it doesn't have yet). */
async function sunshineSyncNow(): Promise<string[]> {
  const auth = sunshineAuth();
  if (!auth) throw new Error("Link Sunshine first");
  const games = await playableGames();
  const added = await syncSunshine(games, process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath, auth);
  settings.update({ sunshine: { ...settings.get().sunshine!, streamGames: games.map((g) => g.gameId) } });
  scheduleHeartbeat(1000);
  return added;
}

async function streamingStatus() {
  const p = streamingPaths();
  return {
    hostname: os.hostname(),
    sunshine: !!(await firstExisting(p.sunshine)),
    moonlight: !!(await firstExisting(p.moonlight)),
    linked: !!settings.get().sunshine,
    streamGames: settings.get().sunshine?.streamGames.length ?? 0,
  };
}

// ---- Covers for the offline page ------------------------------------------------

const coversDir = () => path.join(app.getPath("userData"), "Covers");
const COVER_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

/** Keeps a copy of each installed game's cover, refreshed weekly, so the offline page has artwork. */
async function cacheCovers(gameIds: string[]): Promise<void> {
  const api = await client().catch(() => null);
  if (!api) return;
  await mkdir(coversDir(), { recursive: true });
  const have = await readdir(coversDir()).catch(() => [] as string[]);
  for (const id of gameIds) {
    const file = have.find((f) => f.startsWith(`${id}.`));
    const age = file ? Date.now() - (await stat(path.join(coversDir(), file))).mtimeMs : Infinity;
    if (age < 7 * 86400_000) continue;
    const res = await net.fetch(`${origin()}/api/games/${encodeURIComponent(id)}/cover`, { headers: api.headers() }).catch(() => null);
    const ext = COVER_TYPES[(res?.headers.get("content-type") ?? "").split(";")[0]!.trim()];
    if (!res?.ok || !ext) continue;
    if (file) await rm(path.join(coversDir(), file), { force: true });
    await writeFile(path.join(coversDir(), `${id}.${ext}`), new Uint8Array(await res.arrayBuffer()));
  }
}

/** A store game's name in the Covers folder, or null when it wouldn't make a safe file name. */
const storeCoverId = (addon: string, externalId: string) => {
  const id = `store-${addon}-${externalId}`.replace(/[^\w.-]/g, "_");
  return cacheable(id) ? id : null;
};

/**
 * Keeps a copy of each store game's cover as LootDen shows it (the person's own art, or the
 * match from IGDB, RAWG or Steam), refreshed weekly, so the offline page has artwork for
 * Steam, Epic, GOG and the rest too.
 */
async function cacheStoreCovers(games: Array<{ addon: string; externalId: string; title: string }>): Promise<void> {
  const api = await client().catch(() => null);
  if (!api) return;
  await mkdir(coversDir(), { recursive: true });
  const have = await readdir(coversDir()).catch(() => [] as string[]);
  for (const g of games) {
    const id = storeCoverId(g.addon, g.externalId);
    if (!id) continue;
    const file = have.find((f) => f.startsWith(`${id}.`));
    const age = file ? Date.now() - (await stat(path.join(coversDir(), file))).mtimeMs : Infinity;
    if (age < 7 * 86400_000) continue;
    const at = `${origin()}/api/store-games/${encodeURIComponent(g.addon)}/${encodeURIComponent(g.externalId)}/cover?title=${encodeURIComponent(g.title)}`;
    let res: Response | null = await fetch(at, { headers: api.headers(), redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(() => null);
    // Most covers are a redirect to the image's own address, fetched without LootDen's token.
    const to = res && res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (to) {
      const url = new URL(to, origin());
      res = /^https?:$/.test(url.protocol) ? await net.fetch(url.toString(), { signal: AbortSignal.timeout(15_000) }).catch(() => null) : null;
    }
    const ext = COVER_TYPES[(res?.headers.get("content-type") ?? "").split(";")[0]!.trim()];
    if (!res?.ok || !ext) continue;
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > 8 * 1024 * 1024) continue;
    if (file) await rm(path.join(coversDir(), file), { force: true });
    await writeFile(path.join(coversDir(), `${id}.${ext}`), data);
  }
}

/** A store game's cover for the offline page: the copy kept from the server, else Steam's own artwork cache. */
async function storeCover(g: { addon: string; externalId: string }, files: string[]): Promise<string | null> {
  const id = storeCoverId(g.addon, g.externalId);
  const kept = id ? await cachedCover(id, files) : null;
  if (kept || g.addon !== "steam") return kept;
  const local = await steamLibraryCover(g.externalId).catch(() => null);
  const data = local ? await readFile(local).catch(() => null) : null;
  return data ? `data:image/jpeg;base64,${data.toString("base64")}` : null;
}

/** Ids that are safe as a file name in the cache folders. */
const cacheable = (id: string) => /^[\w.-]{1,100}$/.test(id) && !id.startsWith(".");
const infoDir = () => path.join(app.getPath("userData"), "GameInfo");

/**
 * Keeps each installed game's page from the server (summary, genres, year...), refreshed
 * weekly, so a game later removed from the server still has its details on this PC. A game
 * the server no longer has keeps the last copy.
 */
async function cacheDetails(gameIds: string[]): Promise<void> {
  const api = await client().catch(() => null);
  if (!api) return;
  await mkdir(infoDir(), { recursive: true });
  for (const id of gameIds.filter(cacheable)) {
    const file = path.join(infoDir(), `${id}.json`);
    const age = await stat(file).then((s) => Date.now() - s.mtimeMs, () => Infinity);
    if (age < 7 * 86400_000) continue;
    const detail = await api.getGame(id).catch(() => null);
    if (detail) await writeFile(file, JSON.stringify(detail));
  }
}

async function cachedDetails(gameId: string): Promise<unknown> {
  if (!cacheable(gameId)) return null;
  return readFile(path.join(infoDir(), `${gameId}.json`), "utf8").then((t) => JSON.parse(t), () => null);
}

async function cachedCover(gameId: string, files: string[]): Promise<string | null> {
  const file = files.find((f) => f.startsWith(`${gameId}.`));
  if (!file) return null;
  const type = Object.entries(COVER_TYPES).find(([, ext]) => file.endsWith(`.${ext}`))?.[0];
  const data = await readFile(path.join(coversDir(), file)).catch(() => null);
  return data && type ? `data:${type};base64,${data.toString("base64")}` : null;
}

/** Every folder installs might be in: the ones used so far, plus a Games folder on each drive. */
async function searchDirs(): Promise<string[]> {
  const drives = await listDrives().catch(() => []);
  const guesses = drives.map((d) => path.join(d.path, "Games")).filter((d) => existsSync(d));
  return [...new Set([...settings.get().libraryDirs, ...guesses])];
}

/** The game on the server, in the shape findCopies needs. */
async function gameRef(gameId: string) {
  const g = await (await client()).getGame(gameId);
  return { id: g.id, title: g.title, source: g.source, platform: g.platform };
}

/** Asks where the installer put the game, suggesting the folder we asked it to use. */
async function askInstalledFolder(suggested: string, action: string): Promise<string | null> {
  const { response } = await dialog.showMessageBox(win!, {
    type: "question",
    buttons: [action, "Choose another folder", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    message: "Is the game installed?",
    detail: `We asked the installer to use:\n${suggested}\n\nIf you picked a different folder in the installer, choose it instead. Start the game once first if it needs to finish setting up.`,
  });
  if (response === 2) return null;
  if (response === 0) return suggested;
  const r = await dialog.showOpenDialog(win!, { title: "Folder the game was installed to", properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0]!;
}

async function findInstalled(gameId: string) {
  const game = (await listInstalled(await searchDirs())).find((g) => g.gameId === gameId);
  if (!game) throw new Error("That game is not installed on this computer");
  return game;
}

/** A path relative to dir when it's inside it, otherwise absolute (games installed elsewhere). */
function relTo(dir: string, file: string): string {
  const rel = path.relative(dir, file);
  return rel.startsWith("..") || path.isAbsolute(rel) ? path.resolve(file) : rel;
}

function send(payload: object): void {
  const p = payload as { gameId?: string; type?: string };
  if (p.gameId && p.type === "playing") playing.add(p.gameId);
  if (p.gameId && (p.type === "stopped" || p.type === "error")) {
    playing.delete(p.gameId);
    if (nowRunning.delete(p.gameId)) scheduleHeartbeat(1000);
  }
  if (p.type === "playing" || p.type === "stopped") refreshTray();
  win?.webContents.send("gm:progress", payload);
}

// ---- Tray, closing and quitting ---------------------------------------------------

const icon = () => nativeImage.createFromPath(path.join(__dirname, "..", "build", "icon.png"));

function showWindow(route?: string): void {
  browser?.close();
  if (!win) return void createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (route && origin()) void win.loadURL(`${origin()}${route}`);
}

/** Quits for real; installs a downloaded app update on the way out. */
async function quitApp(): Promise<void> {
  if (running.size) {
    const ask = {
      type: "warning" as const,
      buttons: ["Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Quit LootDen?",
      detail: `${running.size === 1 ? "An install is" : `${running.size} installs are`} still running and will stop.`,
    };
    const { response } = await (win?.isVisible() ? dialog.showMessageBox(win, ask) : dialog.showMessageBox(ask));
    if (response !== 0) return;
  }
  quitting = true;
  if (update.state === "ready" && update.file) await launchUpdate(installKind(), update.file).catch(() => {});
  app.quit();
}

function refreshTray(): void {
  if (!tray) return;
  const games = playing.size ? ` · playing ${playing.size === 1 ? "a game" : `${playing.size} games`}` : "";
  tray.setToolTip(`LootDen ${app.getVersion()}${games}`);
  const u = update;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open LootDen", click: () => showWindow() },
      { label: "Installed games", click: () => showWindow("/library?tab=installed") },
      { label: "Web browser", click: () => void browser.open() },
      { label: `Share a screenshot (${SCREENSHOT_KEY})`, click: () => void shareScreenshot() },
      { type: "separator" },
      u.state === "ready"
        ? { label: `Restart to update to ${u.version}`, click: () => void installNow() }
        : u.state === "downloading"
          ? { label: `Downloading update ${u.version}…`, enabled: false }
          : { label: "Check for app updates", click: () => void checkForUpdate(true) },
      { type: "separator" },
      { label: "Quit LootDen", click: () => void quitApp() },
    ]),
  );
}

function createTray(): void {
  if (tray) return;
  try {
    tray = new Tray(icon().resize({ width: 16, height: 16 }));
  } catch {
    tray = null; // No tray on this desktop: closing quits instead.
    return;
  }
  tray.on("click", () => showWindow());
  tray.on("double-click", () => showWindow());
  refreshTray();
}

/**
 * The file Windows should start. The portable build runs from a copy it unpacks into the
 * temp folder, which is gone after a restart, so its login item names the portable .exe itself.
 */
const appExe = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
/** The Run key value. Fixed, so the uninstaller can remove it and older entries can be found. */
const LOGIN_ITEM_NAME = "LootDen";
/** A handheld, or full screen chosen, opens LootDen in front at login, like a console's home screen; elsewhere it starts in the tray. */
const loginArgs = (s: DesktopSettings) => (handheldActive(s) || s.fullscreen ? ["--fullscreen"] : ["--hidden"]);

/** `enabled` only when the user changed it here; otherwise keep a choice made in Windows Settings or Task Manager. */
function applyLoginItem(s: DesktopSettings, enabled?: boolean): void {
  if (process.platform === "darwin") return app.setLoginItemSettings({ openAtLogin: s.openAtLogin, args: loginArgs(s) });
  if (process.platform !== "win32") return;
  const items = app.getLoginItemSettings().launchItems ?? [];
  // Entries from older versions: named after the app id, or pointing at a portable copy's temp folder.
  for (const item of items) {
    if (item.scope === "user" && item.name !== LOGIN_ITEM_NAME && /\\lootden\.exe$/i.test(item.path))
      app.setLoginItemSettings({ openAtLogin: false, name: item.name, path: item.path, args: item.args });
  }
  const current = items.find((i) => i.name === LOGIN_ITEM_NAME);
  app.setLoginItemSettings({
    openAtLogin: s.openAtLogin,
    name: LOGIN_ITEM_NAME,
    path: appExe(),
    args: loginArgs(s),
    enabled: enabled ?? current?.enabled ?? true,
  });
}

/** Whether Windows will really start LootDen: false when it was turned off in Settings > Apps > Startup. */
function loginItemEnabled(): boolean {
  if (process.platform !== "win32") return true;
  const item = (app.getLoginItemSettings().launchItems ?? []).find((i) => i.name === LOGIN_ITEM_NAME);
  return item?.enabled ?? true;
}

/** Right-click LootDen on the taskbar or in Start: "Open full screen". */
function setJumpList(): void {
  if (process.platform !== "win32") return;
  app.setUserTasks([
    { program: appExe(), arguments: "--fullscreen", iconPath: appExe(), iconIndex: 0, title: "Open full screen", description: "Open LootDen full screen, for a handheld or TV" },
    { program: appExe(), arguments: "--browser", iconPath: appExe(), iconIndex: 0, title: "Web browser", description: "Open LootDen's web browser" },
  ]);
}

// ---- Handheld mode ------------------------------------------------------------------

/** A small touchscreen PC: ROG Ally and Ally X (1280x720 at 150%), Steam Deck and Legion Go (1280x800), MSI Claw. */
function looksHandheld(): boolean {
  const d = screen.getPrimaryDisplay();
  const long = Math.max(d.size.width, d.size.height);
  const short = Math.min(d.size.width, d.size.height);
  return d.touchSupport === "available" && long <= 1440 && short <= 900;
}

const handheldActive = (s: DesktopSettings) => s.handheld === "on" || (s.handheld === "auto" && looksHandheld());
/** Everything a little larger, so text and buttons read at arm's length on a 7-8" screen. */
const HANDHELD_ZOOM = 1.2;

function applyHandheld(): void {
  if (!win) return;
  const on = handheldActive(settings.get());
  win.webContents.setZoomFactor(on ? HANDHELD_ZOOM : 1);
  if (on && !win.isFullScreen()) win.setFullScreen(true);
  sendFrame();
}

// ---- App updates from the server --------------------------------------------------

interface UpdateState {
  state: "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error" | "unsupported";
  version?: string;
  received?: number;
  total?: number;
  error?: string;
  checkedAt?: string;
  /** The downloaded installer or app file, once state is "ready". */
  file?: string;
}
let update: UpdateState = { state: installKind() === "other" ? "unsupported" : "idle" };

function setUpdate(next: UpdateState): void {
  update = next;
  const { file: _f, ...shown } = next;
  win?.webContents.send("gm:progress", { gameId: "lootden-app", type: "appUpdate", current: app.getVersion(), ...shown });
  refreshTray();
}

const busy = () => running.size > 0 || playing.size > 0;

/**
 * Looks on the server's Get the app page for a newer build of this app. When automatic updates
 * are on it downloads it, and installs it straight away if the window is closed and nothing
 * is installing or playing; otherwise it waits for Restart to update (or the next quit).
 */
async function checkForUpdate(manual = false): Promise<UpdateState> {
  const kind = installKind();
  if (kind === "other") return update;
  if (update.state === "downloading" || update.state === "checking") return update;
  if (update.state === "ready" && !manual) return update;
  if (!settings.get().serverUrl) return update;
  setUpdate({ ...update, state: "checking", error: undefined });
  let found: AvailableUpdate | null;
  try {
    const api = await client();
    found = pickUpdate(await api.json<Array<{ name: string; size: number }>>("/api/clients"), app.getVersion(), kind);
  } catch (err) {
    setUpdate({ state: "error", error: (err as Error).message, checkedAt: new Date().toISOString() });
    return update;
  }
  const checkedAt = new Date().toISOString();
  if (!found) {
    setUpdate({ state: "none", checkedAt });
    return update;
  }
  if (update.state === "ready" && update.version === found.version) return update;
  setUpdate({ state: "available", version: found.version, total: found.size, checkedAt });
  if (manual || settings.get().autoUpdate) void fetchUpdate(found);
  return update;
}

async function fetchUpdate(found: AvailableUpdate): Promise<void> {
  const target = path.join(app.getPath("temp"), "lootden-update", found.file);
  try {
    setUpdate({ ...update, state: "downloading", version: found.version, received: 0, total: found.size });
    let last = 0;
    await client(); // makes sure this computer has a token
    await downloadUpdate((u, i) => net.fetch(u, i), `${origin()}/api/clients/${encodeURIComponent(found.file)}`, settings.get().apiToken, target, (received, total) => {
      if (Date.now() - last < 500) return;
      last = Date.now();
      setUpdate({ ...update, state: "downloading", received, total: total || found.size });
    });
    if (!settings.get().allowUnverifiedUpdates) await verifyUpdate((u, i) => net.fetch(u, i), found, target);
    setUpdate({ ...update, state: "ready", version: found.version, file: target, received: found.size });
    if (!win?.isVisible() && !busy() && settings.get().autoUpdate) await installNow();
    else if (Notification.isSupported() && !win?.isVisible()) new Notification({ title: "LootDen update ready", body: `Version ${found.version} installs when you quit, or choose Restart to update.` }).show();
  } catch (err) {
    setUpdate({ state: "error", version: found.version, error: (err as Error).message });
  }
}

async function installNow(): Promise<void> {
  if (update.state !== "ready" || !update.file) return;
  if (busy()) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Update now", "Later"],
      defaultId: 1,
      cancelId: 1,
      message: "Update LootDen now?",
      detail: "A game or install is running. Updating closes the app, which stops installs and play time tracking for the running game.",
    });
    if (response !== 0) return;
  }
  quitting = true;
  try {
    await launchUpdate(installKind(), update.file);
  } catch (err) {
    quitting = false;
    setUpdate({ ...update, state: "error", error: (err as Error).message });
    return;
  }
  app.quit();
}

function registerIpc(): void {
  ipcMain.handle("gm:setServer", async (e, url: string) => {
    // Only the bundled setup page: any other file:// page (say, one on a network share) could repoint the app.
    if (!isFile(e.senderFrame?.url ?? "", SETUP_PAGE)) throw new Error("Not allowed from this page");
    const parsed = new URL(/^https?:\/\//.test(url) ? url : `http://${url}`);
    const health = await net.fetch(`${parsed.origin}/api/health`).then((r) => r.json() as Promise<{ status?: string }>).catch(() => null);
    if (health?.status !== "ok") throw new Error(`No LootDen server answered at ${parsed.origin}`);
    settings.update({ serverUrl: parsed.origin, apiToken: "", apiTokenUser: undefined, profileTokens: {}, keptAllowance: undefined, saveOwners: {} });
    await win?.loadURL(parsed.origin);
    return true;
  });

  ipcMain.handle("gm:info", (e) => {
    fromServer(e);
    const s = settings.get();
    return { platform: process.platform, version: app.getVersion(), installDir: s.installDir, libraryDirs: s.libraryDirs, hostname: os.hostname(), installing: [...running.keys()] };
  });
  ipcMain.handle("gm:drives", (e) => {
    fromServer(e);
    return listDrives();
  });
  ipcMain.handle("gm:chooseFolder", async (e) => {
    fromServer(e);
    const r = await dialog.showOpenDialog(win!, { title: "Install games to", properties: ["openDirectory", "createDirectory"], defaultPath: settings.get().installDir });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("gm:setInstallDir", (e, dir: string) => {
    fromServer(e);
    return settings.update({ installDir: dir }).installDir;
  });
  ipcMain.handle("gm:installed", async (e) => {
    fromServer(e);
    const games = await listInstalled(await searchDirs());
    void cacheCovers(games.map((g) => g.gameId)).catch(() => {});
    void cacheDetails(games.map((g) => g.gameId)).catch(() => {});
    return games;
  });

  /**
   * One game installed on this PC, with its last known details and cover, for its page when
   * the server no longer has it (or can't be reached). Null when it isn't installed here.
   */
  ipcMain.handle("gm:localGame", async (e, gameId: string) => {
    fromServer(e);
    const game = (await listInstalled(await searchDirs())).find((g) => g.gameId === gameId);
    if (!game) return null;
    return { game, detail: await cachedDetails(gameId), cover: await cachedCover(gameId, await readdir(coversDir()).catch(() => [] as string[])) };
  });

  /**
   * Copies of a game already on this computer: an install of it (relinked when the server
   * gave it a new id), or folders named after it with no manifest, to use instead of downloading.
   */
  ipcMain.handle("gm:locate", async (e, gameId: string) => {
    fromServer(e);
    return findCopies(await searchDirs(), await gameRef(gameId));
  });

  ipcMain.handle("gm:adopt", async (e, gameId: string, dir: string) => {
    fromServer(e);
    const ref = await gameRef(gameId);
    // Only folders locate offered, never an arbitrary path from the page.
    const { loose } = await findCopies(await searchDirs(), ref);
    if (!loose.includes(dir)) throw new Error(`${dir} isn't a copy of ${ref.title} this app found`);
    const game = await adoptFolder(dir, ref);
    const root = path.dirname(dir);
    const s = settings.get();
    if (!s.libraryDirs.includes(root)) settings.update({ libraryDirs: [...s.libraryDirs, root] });
    return game;
  });

  ipcMain.handle("gm:install", async (e, gameId: string, dir?: string) => {
    fromServer(e);
    return installFromServer(gameId, dir);
  });
  installRemote = (gameId) => installFromServer(gameId);
  playRemote = (gameId) => play(gameId);

  /** Downloads and installs a game from the server (the Install button, or Send to PC from another device). */
  async function installFromServer(gameId: string, dir?: string) {
    if (running.has(gameId)) throw new Error("Already installing");
    // Never download a second copy of something already on this computer.
    const existing = await findCopies(await searchDirs(), await gameRef(gameId));
    if (existing.installed) throw new Error(`Already installed in ${existing.installed.dir}`);
    const s = settings.get();
    const installDir = dir || s.installDir;
    if (dir) settings.update({ libraryDirs: [...new Set([...s.libraryDirs, dir])] });
    const controller = new AbortController();
    running.set(gameId, controller);
    let last = 0;
    try {
      const gameDir = await installGame(await client(), gameId, {
        installDir,
        keepArchives: s.keepArchives,
        sevenZipPath: await sevenZipPath(),
        device: os.hostname(),
        signal: controller.signal,
        onEvent: (ev: InstallEvent) => {
          if (ev.type === "download") {
            const now = Date.now();
            if (now - last < 250 && ev.received < ev.total) return;
            last = now;
          }
          send({ gameId, ...(ev.type === "start" ? { type: "start", gameDir: ev.gameDir, totalBytes: ev.game.sizeBytes } : ev) });
        },
      });
      void cacheDetails([gameId]).catch(() => {});
      // A streaming PC gets the new game in Sunshine too.
      if (settings.get().sunshine) void sunshineSyncNow().catch(() => {});
      return { gameDir };
    } catch (err) {
      send({ gameId, type: controller.signal.aborted ? "cancelled" : "error", message: (err as Error).message });
      throw err;
    } finally {
      running.delete(gameId);
    }
  }

  ipcMain.handle("gm:cancel", (e, gameId: string) => {
    fromServer(e);
    running.get(gameId)?.abort();
  });

  ipcMain.handle("gm:play", async (e, gameId: string) => {
    fromServer(e);
    return play(gameId);
  });

  /** Games between Play and running: a second press while the first is still starting. */
  const launching = new Set<string>();

  /** Starts an installed game, once: a second Play while it starts or runs does nothing new. */
  async function play(gameId: string) {
    if (playing.has(gameId) || launching.has(gameId)) throw new Error("That game is already running");
    launching.add(gameId);
    try {
      return await startGame(gameId);
    } finally {
      launching.delete(gameId);
    }
  }

  /** Starts an installed game. Works offline: play time waits until the server is back. */
  async function startGame(gameId: string) {
    const game = await findInstalled(gameId);
    if (game.platform && game.platform !== "pc") return playEmulatedGame(gameId, game.dir, game.platform);
    if (game.needsSetup && !game.installedDir) throw new Error(`${game.title} is still ${game.needsSetup === "disc" ? "a disc image" : "an installer"}. Use Run installer first.`);
    const home = game.installedDir ?? game.dir;
    let exe = game.executable ?? (await findExecutable(home, game.title).then((x) => x && relTo(game.dir, path.join(home, x))));
    if (!exe) {
      const r = await dialog.showOpenDialog(win!, { title: `Which file starts ${game.title}?`, defaultPath: home, properties: ["openFile"] });
      if (r.canceled) return null;
      exe = relTo(game.dir, r.filePaths[0]!);
    }
    if (exe !== game.executable) await saveExecutable(game.dir, exe);
    // Play time limits and bedtime, then this person's own saves.
    const live = await clientOrOffline();
    const player = currentPlayer();
    const today = await todaysAllowance(live);
    if (today && !today.canPlay) throw new Error(today.reason ?? "No play time left today");
    await useSaveSlot(live, gameId, game.dir, today).catch((err: Error) => send({ gameId, type: "warning", message: `Couldn't switch saves: ${err.message}` }));
    const stop = new AbortController();
    const unwatch = guardPlay(live, gameId, game.title, today, today?.hardStop ? stop : undefined);
    markRunning(gameId, game.title, "lootden", stop);
    send({ gameId, type: "playing" });
    void launchAndTrack(game.dir, exe, process.platform, stop.signal, { watchDirs: [home] }).then(
      async (seconds) => {
        unwatch();
        send({ gameId, type: "stopped", seconds });
        const api = clientFor(player) ?? (await clientOrOffline());
        // Offline: no save backup this time; the next session online backs the folder up.
        if (!(await recordPlay(api, gameId, seconds, player))) return;
        // Save sync: back up after every session when the game has a save location.
        const saved = await syncSaves(api, gameId, game.dir).catch((err: Error) => ({ error: err.message }));
        if (saved) send({ gameId, type: "saves", ...saved });
      },
      (err: Error) => {
        unwatch();
        send({ gameId, type: "error", message: err.message });
      },
    );
    return { executable: exe };
  }

  /** Emulated games: restore newer saves, run the emulator, back up what changed. */
  async function playEmulatedGame(gameId: string, dir: string, platform: string) {
    const api = await clientOrOffline();
    const player = currentPlayer();
    const today = await todaysAllowance(api);
    if (today && !today.canPlay) throw new Error(today.reason ?? "No play time left today");
    // Emulators can't be closed from here, so limits only warn.
    let unwatch = () => {};
    let started: (v: { executable: string }) => void = () => {};
    const ready = new Promise<{ executable: string }>((resolve) => (started = resolve));
    const session = playEmulated(api, gameId, dir, platform, {
      toolsDir: toolsDir(),
      sevenZip: await sevenZip(),
      device: os.hostname(),
      onEvent: (ev) => send({ gameId, type: "prepare", message: ev.message }),
      onStarted: (plan) => {
        unwatch = guardPlay(api, gameId, path.basename(plan.rom), today);
        markRunning(gameId, path.basename(plan.rom, path.extname(plan.rom)), "emulated");
        send({ gameId, type: "playing" });
        started({ executable: `${plan.emulator.name}: ${path.basename(plan.rom)}` });
      },
    });
    session.then(
      async (r) => {
        unwatch();
        send({ gameId, type: "stopped", seconds: r.seconds });
        await recordPlay(api, gameId, r.seconds, player);
        if (r.backup) send({ gameId, type: "saves", backupId: r.backup.id, size: r.backup.size });
      },
      (err: Error) => {
        unwatch();
        send({ gameId, type: "error", message: err.message });
      },
    );
    // Errors before the emulator starts (missing BIOS, no emulator yet) go straight back to the page.
    return Promise.race([ready, session.then(() => ({ executable: "" }))]);
  }

  // ---- Emulators ------------------------------------------------------------------

  ipcMain.handle("gm:emulators", async (e) => {
    fromServer(e);
    return { toolsDir: toolsDir(), emulators: await emulatorOverview(toolsDir()) };
  });

  ipcMain.handle("gm:installEmulator", async (e, id: string) => {
    fromServer(e);
    const key = `emu:${id}`;
    if (running.has(key)) throw new Error("Already downloading");
    const controller = new AbortController();
    running.set(key, controller);
    let last = 0;
    try {
      return await installEmulator(id, {
        toolsDir: toolsDir(),
        sevenZip: await sevenZip(),
        signal: controller.signal,
        onEvent: (ev) => {
          const now = Date.now();
          if (ev.total && now - last < 300) return;
          last = now;
          send({ gameId: key, type: "prepare", message: ev.total ? `${ev.message} (${Math.floor(((ev.received ?? 0) / ev.total) * 100)}%)` : ev.message });
        },
      });
    } finally {
      running.delete(key);
    }
  });

  ipcMain.handle("gm:addBios", async (e, id: string) => {
    fromServer(e);
    const info = emulatorInfo(id);
    if (!info) throw new Error("Unknown emulator");
    const r = await dialog.showOpenDialog(win!, {
      title: `BIOS or firmware for ${info.name}`,
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "BIOS and firmware", extensions: ["bin", "rom0", "pup", "qcow2", "BIN", "PUP"] }, { name: "All files", extensions: ["*"] }],
    });
    if (r.canceled) return [];
    const added: string[] = [];
    for (const f of r.filePaths) added.push((await addBiosFile(toolsDir(), info, f)).label);
    return added;
  });

  ipcMain.handle("gm:biosFromServer", async (e) => {
    fromServer(e);
    return biosFromServer(await client(), toolsDir());
  });

  ipcMain.handle("gm:openTools", async (e) => {
    fromServer(e);
    await shell.openPath(toolsDir());
  });

  ipcMain.handle("gm:backupSaves", async (e, gameId: string) => {
    fromServer(e);
    const game = await findInstalled(gameId);
    const r = await syncSaves(await client(), gameId, game.dir);
    if (!r) throw new Error("No save location is set for this game yet");
    return r;
  });

  ipcMain.handle("gm:restoreSaves", async (e, gameId: string, saveId: number) => {
    fromServer(e);
    const game = await findInstalled(gameId);
    const api = await client();
    const detail = await api.getGame(gameId);
    if (!detail.savePath) throw new Error("No save location is set for this game yet");
    const dir = await expandSavePath(detail.savePath, game.dir);
    const { response } = await dialog.showMessageBox(win!, {
      type: "question",
      buttons: ["Restore", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: `Replace the saves in ${dir}?`,
      detail: "Your current saves are kept beside it in a .gm-backup folder.",
    });
    if (response !== 0) return null;
    return restoreSaves(api, await sevenZip(), gameId, saveId, dir);
  });

  // ---- Disc and installer games: install once here, upload the installed folder -------

  const prepareStep = (gameId: string) => {
    let last = 0;
    return (st: PrepareStep) => {
      const message =
        st.step === "download"
          ? st.event.type === "download"
            ? `Downloading ${st.event.file} (${Math.floor((st.event.received / Math.max(st.event.total, 1)) * 100)}%)`
            : st.event.type === "extract"
              ? `Unpacking ${st.event.archive}`
              : null
          : st.step === "unpack-disc"
            ? `Unpacking ${st.file}`
            : st.step === "install"
              ? "Running the installer. Finish it, then come back here."
              : st.step === "zip"
                ? "Zipping the installed game"
                : st.step === "upload"
                  ? `Uploading ${(st.bytes / 1024 ** 3).toFixed(1)} GB to the server${st.sent ? ` (${Math.floor((st.sent / Math.max(st.bytes, 1)) * 100)}%)` : ""}`
                  : "Done";
      if (!message) return;
      const now = Date.now();
      if ((st.step === "download" || (st.step === "upload" && st.sent && st.sent < st.bytes)) && now - last < 500) return;
      last = now;
      send({ gameId, type: "prepare", message });
    };
  };

  /** Full 7-Zip (reads ISOs) when installed, else the bundled 7za. */
  const prepSevenZip = async () => (await findSevenZip("").catch(() => null)) ?? (await sevenZip());

  ipcMain.handle("gm:prepare", async (e, gameId: string) => {
    fromServer(e);
    if (process.platform !== "win32") throw new Error("Running installers needs the Windows app. On Linux, install it with Wine yourself, then use Upload an installed folder.");
    if (running.has(gameId)) throw new Error("Already working on this game");
    const controller = new AbortController();
    running.set(gameId, controller);
    const workDir = path.join(settings.get().installDir, `.prepare-${gameId}`);
    try {
      const game = await prepareGame(await client(), gameId, {
        workDir,
        sevenZip: await prepSevenZip(),
        onStep: prepareStep(gameId),
        runInstaller: (setup, target, args) => runElevated(setup, args),
        confirmInstalled: (suggested) => askInstalledFolder(suggested, "Upload this folder"),
      });
      send({ gameId, type: "prepare", message: game ? "Uploaded. Everyone now gets the installed version." : "Cancelled", done: true, newId: game?.id });
      return game;
    } catch (err) {
      send({ gameId, type: "prepare", message: (err as Error).message, done: true, error: true });
      throw err;
    } finally {
      running.delete(gameId);
    }
  });

  ipcMain.handle("gm:uploadFolder", async (e, gameId: string) => {
    fromServer(e);
    const r = await dialog.showOpenDialog(win!, { title: "Folder with the installed game", properties: ["openDirectory"] });
    if (r.canceled) return null;
    const workDir = path.join(settings.get().installDir, `.prepare-${gameId}`);
    try {
      const game = await uploadInstalledFolder(await client(), gameId, r.filePaths[0]!, { workDir, sevenZip: await prepSevenZip(), onStep: prepareStep(gameId) });
      send({ gameId, type: "prepare", message: "Uploaded. Everyone now gets the installed version.", done: true, newId: game.id });
      return game;
    } catch (err) {
      send({ gameId, type: "prepare", message: (err as Error).message, done: true, error: true });
      throw err;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  /**
   * A downloaded installer: run it once on this PC, installing into a folder inside the game's
   * folder, then remember where the game went so Play starts it.
   */
  ipcMain.handle("gm:runSetup", async (e, gameId: string) => {
    fromServer(e);
    if (process.platform !== "win32") throw new Error("Running installers needs the Windows app. On Linux, run it with Wine yourself from Open folder.");
    if (running.has(gameId)) throw new Error("Already working on this game");
    const game = await findInstalled(gameId);
    running.set(gameId, new AbortController());
    const step = (message: string, extra: object = {}) => send({ gameId, type: "prepare", message, ...extra });
    try {
      const target = path.join(game.dir, "Installed");
      await runLocalSetup(game.dir, target, { sevenZip: await prepSevenZip(), runInstaller: (setup, _target, args) => runElevated(setup, args), onStep: step });
      const folder = await askInstalledFolder(target, "Use this folder");
      if (!folder || !existsSync(folder) || !(await readdir(folder)).length) {
        step(folder ? `${folder} is empty; the installer didn't finish` : "Cancelled", { done: true, error: !!folder });
        return null;
      }
      let exe = await findExecutable(folder, game.title).then((x) => x && relTo(game.dir, path.join(folder, x)));
      if (!exe) {
        const r = await dialog.showOpenDialog(win!, { title: `Which file starts ${game.title}?`, defaultPath: folder, properties: ["openFile"] });
        if (!r.canceled) exe = relTo(game.dir, r.filePaths[0]!);
      }
      await saveManifest(game.dir, { installedDir: folder, executable: exe ?? undefined, exeStamp: null, setupAt: new Date().toISOString() });
      // The setup files aren't needed to play; offer the space back when the game went inside the folder.
      const rel = path.relative(game.dir, folder);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        const top = rel.split(path.sep)[0]!;
        const leftovers = (await readdir(game.dir)).filter((n) => n !== top && !isManifest(n));
        const { response } = await dialog.showMessageBox(win!, {
          type: "question",
          buttons: ["Delete installer files", "Keep them"],
          defaultId: 0,
          cancelId: 1,
          message: "Delete the installer files?",
          detail: `${game.title} is installed in ${folder}. The ${leftovers.length} installer files beside it aren't needed to play.`,
        });
        if (response === 0) for (const n of leftovers) await rm(path.join(game.dir, n), { recursive: true, force: true });
      }
      step(`Installed in ${folder}. Press Play to start it.`, { done: true });
      return { installedDir: folder, executable: exe };
    } catch (err) {
      step((err as Error).message, { done: true, error: true });
      throw err;
    } finally {
      running.delete(gameId);
    }
  });

  /**
   * Applies an update or DLC from the server to its installed game. Files are copied over the
   * game with a backup (undo restores it); a setup program is run against the game's folder.
   * When the versions don't line up, the player decides whether to go ahead.
   */
  ipcMain.handle("gm:applyUpdate", async (e, updateId: string) => {
    fromServer(e);
    if (running.has(updateId)) throw new Error("Already applying this update");
    const api = await client();
    const update = await api.getGame(updateId);
    if (!update.baseGameId) throw new Error(`${update.title}'s game isn't on the server, so there's nothing to apply it to`);
    const game = await findInstalled(update.baseGameId).catch(() => {
      throw new Error(`Install ${update.baseGame?.title ?? "the game"} first`);
    });
    const controller = new AbortController();
    running.set(updateId, controller);
    const step = (message: string, extra: object = {}) => send({ gameId: updateId, type: "prepare", message, ...extra });
    let last = 0;
    const sevenZip = await sevenZipPath();
    const options = (force: boolean) => ({
      workDir: path.join(path.dirname(game.dir), `.update-${updateId}`),
      sevenZipPath: sevenZip,
      force,
      signal: controller.signal,
      runInstaller: async (setup: string, target: string, args: string[]) => {
        if (process.platform !== "win32") throw new Error("This update is a setup program, which needs the Windows app. On Linux, run it with Wine yourself.");
        step(`Running ${path.basename(setup)}. Point it at ${target} if it asks where the game is.`);
        await runElevated(setup, args);
      },
      onEvent: (ev: InstallEvent | { type: "apply"; mode: string; target: string }) => {
        if (ev.type === "apply") return step(ev.mode === "files" ? `Copying the update into ${ev.target}` : "Running the update's setup program");
        if (ev.type === "download") {
          const now = Date.now();
          if (now - last < 250 && ev.received < ev.total) return;
          last = now;
        }
        send({ gameId: updateId, ...(ev.type === "start" ? { type: "start", gameDir: ev.gameDir, totalBytes: ev.game.sizeBytes } : ev) });
      },
    });
    try {
      let applied;
      try {
        applied = await applyUpdate(api, updateId, game, options(false));
      } catch (err) {
        if (!(err instanceof UpdateMismatchError)) throw err;
        const { response } = await dialog.showMessageBox(win!, {
          type: "warning",
          buttons: ["Apply anyway", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          message: `Apply ${update.title} to ${game.title}?`,
          detail: `${err.message}. Applying an update made for another version can break the game; files it replaces are backed up so you can undo it.`,
        });
        if (response !== 0) {
          step("Cancelled", { done: true });
          return null;
        }
        applied = await applyUpdate(api, updateId, game, options(true));
      }
      step(
        applied.mode === "files"
          ? `Applied: ${applied.replaced} files replaced (backed up), ${applied.added} added${applied.version ? `. ${game.title} is now v${applied.version}` : ""}.`
          : `Done${applied.version ? `. ${game.title} is now recorded as v${applied.version}` : ""}.`,
        { done: true },
      );
      return applied;
    } catch (err) {
      step(controller.signal.aborted ? "Cancelled" : (err as Error).message, { done: true, error: !controller.signal.aborted });
      throw err;
    } finally {
      running.delete(updateId);
    }
  });

  ipcMain.handle("gm:undoUpdate", async (e, updateId: string) => {
    fromServer(e);
    const game = (await listInstalled(await searchDirs())).find((g) => g.updates?.some((u) => u.id === updateId));
    if (!game) throw new Error("That update isn't applied on this computer");
    const record = game.updates!.find((u) => u.id === updateId)!;
    const { response } = await dialog.showMessageBox(win!, {
      type: "question",
      buttons: ["Undo update", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: `Undo ${record.title}?`,
      detail: `The ${record.replaced} files it replaced in ${game.title} are put back and the ${record.added} it added are removed.`,
    });
    if (response !== 0) return null;
    return undoUpdate(game, updateId);
  });

  /** Admin: zip the game the installer put on this PC and upload it in place of the installer. */
  ipcMain.handle("gm:uploadInstalled", async (e, gameId: string) => {
    fromServer(e);
    const local = await findInstalled(gameId);
    if (!local.installedDir) throw new Error("Run the installer first");
    if (running.has(gameId)) throw new Error("Already working on this game");
    running.set(gameId, new AbortController());
    const workDir = path.join(path.dirname(local.dir), `.prepare-${gameId}`);
    try {
      const game = await uploadInstalledFolder(await client(), gameId, local.installedDir, { workDir, sevenZip: await prepSevenZip(), onStep: prepareStep(gameId) });
      // The server game has a new id now; keep this PC's copy linked to it.
      await saveManifest(local.dir, { gameId: game.id, title: game.title, source: game.source, needsSetup: null });
      send({ gameId, type: "prepare", message: "Uploaded. Everyone now gets the installed version.", done: true, newId: game.id });
      return game;
    } catch (err) {
      send({ gameId, type: "prepare", message: (err as Error).message, done: true, error: true });
      throw err;
    } finally {
      running.delete(gameId);
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  ipcMain.handle("gm:uninstall", async (e, gameId: string) => {
    fromServer(e);
    const game = await findInstalled(gameId);
    const { response } = await dialog.showMessageBox(win!, {
      type: "warning",
      buttons: ["Delete", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Delete ${game.title}?`,
      detail:
        `This removes ${game.dir} and everything in it, including saves stored there.` +
        (game.installedDir && path.relative(game.dir, game.installedDir).startsWith("..") ? `\n\nThe game the installer put in ${game.installedDir} stays; remove it with Windows' Apps settings.` : ""),
    });
    if (response !== 0) return false;
    await uninstallGame(game.dir);
    // Offline, or a game the server no longer has: the files are gone either way.
    await (await clientOrOffline()).reportActivity({ gameId, device: os.hostname(), event: "uninstalled" }).catch(() => false);
    return true;
  });

  // ---- Library add-ons: games from other stores ------------------------------------

  /** Store games installed on this PC, found by each add-on's scanner. */
  /**
   * Steam Workshop items for an installed game: the ones LootDen put in its mods folder, and
   * downloading one with SteamCMD (fetched from Valve on first use) to copy in. The app id and
   * mods folder come from the server, never the page.
   */
  const workshopFor = async (gameId: string) => {
    const game = await findInstalled(gameId);
    const w = await (await client()).json<{ appId: string | null; modsPath: string }>(`/api/games/${encodeURIComponent(gameId)}/workshop`);
    return { gameDir: game.installedDir ?? game.dir, w };
  };
  ipcMain.handle("gm:workshop:list", async (e, gameId: string) => {
    fromServer(e);
    const game = (await listInstalled(await searchDirs())).find((g) => g.gameId === gameId);
    if (!game) return [];
    const w = await (await client()).json<{ appId: string | null; modsPath: string }>(`/api/games/${encodeURIComponent(gameId)}/workshop`).catch(() => null);
    return w?.modsPath ? listWorkshopItems(game.installedDir ?? game.dir, w.modsPath) : [];
  });
  ipcMain.handle("gm:workshop:install", async (e, gameId: string, itemId: string, title: string) => {
    fromServer(e);
    const { gameDir, w } = await workshopFor(gameId);
    if (!w.appId) throw new Error("This game has no Steam app id set");
    if (!w.modsPath) throw new Error("Set this game's mods folder first");
    const progress = (line: string) => send({ gameId, type: "workshop", itemId, line: line.slice(0, 200) });
    const steamcmd = await ensureSteamCmd(path.join(toolsDir(), "steamcmd"), { sevenZip: await sevenZip().catch(() => null), fetchImpl: (u, i) => net.fetch(String(u), i) });
    const work = path.join(app.getPath("userData"), "workshop");
    const content = await downloadWorkshopItem(steamcmd, work, w.appId, itemId, progress);
    const item = await installWorkshopItem(content, gameDir, w.modsPath, { id: itemId, title: String(title || itemId) });
    await rm(content, { recursive: true, force: true }).catch(() => {});
    return item;
  });
  ipcMain.handle("gm:workshop:remove", async (e, gameId: string, itemId: string) => {
    fromServer(e);
    const { gameDir, w } = await workshopFor(gameId);
    await removeWorkshopItem(gameDir, w.modsPath, itemId);
  });
  ipcMain.handle("gm:storeGames", async (e) => {
    fromServer(e);
    const { disabled, folders } = settings.get().storeScan;
    const games = await scanStoreGames(STORE_SCANNERS, process.platform, { disabled, folders });
    void cacheStoreCovers(games).catch(() => {});
    return games;
  });
  /**
   * This PC's scanner settings: which launchers to look in, and folders picked to look in too.
   * The page can switch launchers and drop folders; a new folder only comes from the folder picker.
   */
  const storeScanView = () => {
    const s = settings.get().storeScan;
    return { stores: STORE_SCANNERS.filter((x) => x.platforms.includes(process.platform)).map((x) => ({ id: x.addon, name: x.name, enabled: !s.disabled.includes(x.addon) })), folders: s.folders };
  };
  ipcMain.handle("gm:storeScan", (e, patch?: { disabled?: unknown; folders?: unknown }) => {
    fromServer(e);
    if (patch) {
      const cur = settings.get().storeScan;
      const known = new Set(STORE_SCANNERS.map((x) => x.addon));
      const disabled = Array.isArray(patch.disabled) ? patch.disabled.filter((d): d is string => typeof d === "string" && known.has(d)) : cur.disabled;
      const folders = Array.isArray(patch.folders) ? cur.folders.filter((f) => (patch.folders as unknown[]).includes(f)) : cur.folders;
      settings.update({ storeScan: { disabled: [...new Set(disabled)], folders } });
    }
    return storeScanView();
  });
  ipcMain.handle("gm:addStoreFolder", async (e) => {
    fromServer(e);
    const r = await dialog.showOpenDialog(win!, { title: "Look for store games in", properties: ["openDirectory"] });
    const dir = r.canceled ? null : r.filePaths[0];
    if (dir) {
      const cur = settings.get().storeScan;
      if (!cur.folders.includes(dir)) settings.update({ storeScan: { ...cur, folders: [...cur.folders, dir] } });
    }
    return storeScanView();
  });
  ipcMain.handle("gm:streaming", async (e) => {
    fromServer(e);
    return streamingStatus();
  });
  /** Saves Sunshine's web login (checked first) and adds this PC's games to it. */
  ipcMain.handle("gm:linkSunshine", async (e, user: string, pass: string) => {
    fromServer(e);
    if (typeof user !== "string" || typeof pass !== "string" || !user.trim() || !pass) throw new Error("Type Sunshine's username and password");
    const sealed = safeStorage.isEncryptionAvailable();
    const prev = settings.get().sunshine;
    settings.update({ sunshine: { user: user.trim(), pass: sealed ? safeStorage.encryptString(pass).toString("base64") : pass, sealed, streamGames: prev?.streamGames ?? [] } });
    try {
      return { ...(await streamingStatus()), added: await sunshineSyncNow() };
    } catch (err) {
      settings.update({ sunshine: prev });
      throw err;
    }
  });
  ipcMain.handle("gm:syncSunshine", async (e) => {
    fromServer(e);
    const added = await sunshineSyncNow();
    return { ...(await streamingStatus()), added };
  });
  ipcMain.handle("gm:unlinkSunshine", async (e) => {
    fromServer(e);
    settings.update({ sunshine: undefined });
    scheduleHeartbeat(1000);
    return streamingStatus();
  });
  /** Streams a game from another PC with Moonlight. */
  ipcMain.handle("gm:streamGame", async (e, host: string, title: string) => {
    fromServer(e);
    if (typeof host !== "string" || typeof title !== "string") throw new Error("Pick a PC to stream from");
    await streamWithMoonlight(host, title);
  });

  /** Starts (or installs) a store game through its launcher. Only store launcher links open. */
  ipcMain.handle("gm:launchStore", async (e, url: string) => {
    fromServer(e);
    if (typeof url !== "string" || !isStoreLaunchUrl(url)) throw new Error("That isn't a store launcher link");
    const place = robloxPlaceOf(url);
    if (place) return playRoblox(url, place);
    await checkPlayTime(url);
    await shell.openExternal(url);
  });

  /**
   * A Roblox game an admin picked: unlike other stores, the Roblox player is one program that
   * runs one game, so LootDen can count its play time and close it when the time is up.
   */
  async function playRoblox(url: string, place: string) {
    const gameId = robloxPlayId(place);
    if (playing.has(gameId) || launching.has(gameId)) throw new Error("Roblox is already starting that game");
    const live = await clientOrOffline();
    const player = currentPlayer();
    const today = await todaysAllowance(live);
    if (today && !today.canPlay) throw new Error(today.reason ?? "No play time left today");
    // A Den Duty time-out can lock Roblox alone.
    if (today?.robloxLock) throw new Error(today.robloxLock);
    // Straight into full screen, like a game started from the couch should.
    await setRobloxFullscreen().catch(() => {});
    await shell.openExternal(url);
    launching.add(gameId);
    const stop = new AbortController();
    let unwatch = () => {};
    void trackRoblox({
      stop: stop.signal,
      onStarted: () => {
        launching.delete(gameId);
        unwatch = guardPlay(live, gameId, "Roblox", today, today?.hardStop ? stop : undefined);
        markRunning(gameId, "Roblox", "roblox", stop);
        send({ gameId, type: "playing" });
      },
    }).then(
      async (seconds) => {
        launching.delete(gameId);
        unwatch();
        if (!playing.has(gameId)) return;
        send({ gameId, type: "stopped", seconds });
        await recordPlay(clientFor(player) ?? (await clientOrOffline()), gameId, seconds, player);
      },
      () => {
        launching.delete(gameId);
        unwatch();
        playing.delete(gameId);
        if (nowRunning.delete(gameId)) scheduleHeartbeat(1000);
      },
    );
  }

  /** The built-in web browser, on its start page or a web page. */
  ipcMain.handle("gm:openBrowser", (e, url?: string) => {
    fromServer(e);
    return browser.open(typeof url === "string" && isBrowsable(url) ? url : undefined);
  });

  ipcMain.handle("gm:openFolder", async (e, gameId: string) => {
    fromServer(e);
    await shell.openPath((await findInstalled(gameId)).dir);
  });

  ipcMain.handle("gm:appSettings", (e, patch?: Partial<Pick<DesktopSettings, "closeToTray" | "autoUpdate" | "openAtLogin" | "handheld" | "fullscreen" | "browserLinks">>) => {
    fromServer(e);
    if (patch) {
      const clean: Partial<DesktopSettings> = {};
      for (const k of ["closeToTray", "autoUpdate", "openAtLogin", "fullscreen"] as const) if (typeof patch[k] === "boolean") clean[k] = patch[k];
      if (patch.handheld && ["auto", "on", "off"].includes(patch.handheld)) clean.handheld = patch.handheld;
      if (patch.browserLinks && ["auto", "on", "off"].includes(patch.browserLinks)) clean.browserLinks = patch.browserLinks;
      const s = settings.update(clean);
      // Ticking the box here also turns the entry back on if it was switched off in Windows.
      if ("openAtLogin" in clean) applyLoginItem(s, s.openAtLogin);
      else if (clean.handheld || "fullscreen" in clean) applyLoginItem(s);
      if ("fullscreen" in clean && win && win.isFullScreen() !== (s.fullscreen || handheldActive(s))) win.setFullScreen(s.fullscreen || handheldActive(s));
      if (clean.handheld) {
        // Turning it off leaves full screen too, unless full screen was chosen on its own.
        if (!handheldActive(s) && win?.isFullScreen() && !s.fullscreen) win.setFullScreen(false);
        applyHandheld();
      }
      if (clean.autoUpdate) void checkForUpdate();
    }
    const s = settings.get();
    return {
      closeToTray: s.closeToTray,
      autoUpdate: s.autoUpdate,
      openAtLogin: s.openAtLogin,
      loginItemEnabled: loginItemEnabled(),
      fullscreen: s.fullscreen,
      handheld: s.handheld,
      handheldActive: handheldActive(s),
      looksHandheld: looksHandheld(),
      browserLinks: s.browserLinks ?? "auto",
      trayAvailable: !!tray,
      loginItemSupported: process.platform === "win32" || process.platform === "darwin",
    };
  });

  ipcMain.handle("gm:appUpdate", async (e, action: "status" | "check" | "install" = "status") => {
    fromServer(e);
    if (action === "check") await checkForUpdate(true);
    if (action === "install") await installNow();
    const { file: _f, ...shown } = update;
    return { current: app.getVersion(), kind: installKind(), ...shown };
  });

  ipcMain.handle("gm:quit", async (e) => {
    fromServer(e);
    await quitApp();
  });

  ipcMain.handle("gm:changeServer", async (e) => {
    if (!isAppPage(e, OFFLINE_PAGE)) fromServer(e);
    settings.update({ serverUrl: "", apiToken: "", apiTokenUser: undefined, profileTokens: {}, keptAllowance: undefined, saveOwners: {} });
    if (customFrame) win?.setTitleBarOverlay({ color: "#0d0820", symbolColor: "#f3eeff", height: TITLEBAR_HEIGHT });
    await win?.loadFile(SETUP_PAGE);
  });

  // ---- Offline: the server can't be reached --------------------------------------

  /** The server's pages ask for this when their requests stop getting through. */
  ipcMain.handle("gm:goOffline", async (e) => {
    fromServer(e);
    if (await serverUp()) return false;
    showOffline();
    return true;
  });
  ipcMain.handle("gm:offline:library", async (e) => {
    fromLocal(e);
    const covers = await readdir(coversDir()).catch(() => [] as string[]);
    const games = await listInstalled(await searchDirs());
    // Steam, Epic, GOG and the other launchers' games play offline too, through the launcher.
    const { disabled, folders } = settings.get().storeScan;
    const stores = await scanStoreGames(STORE_SCANNERS, process.platform, { disabled, folders }).catch(() => []);
    return {
      server: origin(),
      pendingPlays: settings.get().pendingPlays.length,
      theme: settings.get().offlineTheme ?? null,
      stores: await Promise.all(
        stores
          .filter((g) => g.launchUrl && isStoreLaunchUrl(g.launchUrl))
          .map(async (g) => ({ addon: g.addon, store: g.store ?? g.addon, externalId: g.externalId, title: g.title, launchUrl: g.launchUrl!, cover: await storeCover(g, covers) })),
      ),
      games: await Promise.all(
        games.map(async (g) => ({
          gameId: g.gameId,
          title: g.title,
          platform: g.platform,
          version: g.version ?? null,
          installedAt: g.installedAt,
          needsSetup: g.needsSetup && !g.installedDir ? g.needsSetup : null,
          cover: await cachedCover(g.gameId, covers),
        })),
      ),
    };
  });
  ipcMain.handle("gm:offline:play", async (e, gameId: string) => {
    fromLocal(e);
    return play(gameId);
  });
  /** A store game from the offline page, through its launcher. Only store launcher links open. */
  ipcMain.handle("gm:offline:launchStore", async (e, url: string) => {
    fromLocal(e);
    if (typeof url !== "string" || !isStoreLaunchUrl(url)) throw new Error("That isn't a store launcher link");
    await checkPlayTime(url);
    await shell.openExternal(url);
  });
  ipcMain.handle("gm:offline:openFolder", async (e, gameId: string) => {
    fromLocal(e);
    await shell.openPath((await findInstalled(gameId)).dir);
  });
  ipcMain.handle("gm:offline:retry", async (e) => {
    fromLocal(e);
    if (!(await serverUp())) return false;
    await goOnline();
    return true;
  });

  // The page draws the title bar; it asks how, and passes its theme's colours for the buttons.
  ipcMain.handle("gm:frame", () => frameState());
  // The theme's colours, kept for the offline page. Only known keys and #hex values are stored.
  ipcMain.handle("gm:offlineTheme", (e, colors: Record<string, unknown>) => {
    fromServer(e);
    const clean: Record<string, string> = {};
    for (const key of OFFLINE_THEME_KEYS) {
      const v = colors?.[key];
      if (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v)) clean[key] = v;
    }
    if (!clean.bg || !clean.text) return;
    if (JSON.stringify(clean) !== JSON.stringify(settings.get().offlineTheme)) settings.update({ offlineTheme: clean });
  });
  ipcMain.handle("gm:titleBarColors", (e, color: string, symbolColor: string) => {
    fromServer(e);
    if (!customFrame || !win) return;
    const css = /^#[0-9a-f]{3,8}$/i;
    if (css.test(color) && css.test(symbolColor)) win.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
  });

  ipcMain.handle("gm:toggleFullscreen", (e) => {
    fromServer(e);
    const full = !win?.isFullScreen();
    win?.setFullScreen(full);
    applyLoginItem(settings.update({ fullscreen: full }));
    return full;
  });
}

/**
 * lootden://install/<id> from a browser opens the game page with the install panel.
 * lootden://play/<id> starts an installed game (Sunshine's apps use it for streaming).
 * lootden://auth?code=... finishes a single sign-on the app started in the browser.
 */
async function openDeepLink(link: string): Promise<void> {
  // lootden://play/<id>: Sunshine (game streaming) starts games this way. No window needed.
  const playLink = link.match(/^lootden:\/\/play\/([\w-]+)/);
  if (playLink) {
    void playRemote?.(playLink[1]!).catch((err: Error) => playNotice(playLink[1]!, "Couldn't start the game", err.message));
    return;
  }
  const install = link.match(/^(?:lootden|gamemanager):\/\/install\/([\w-]+)/);
  const auth = link.match(/^(?:lootden|gamemanager):\/\/auth\/?\?code=([\w-]+)/);
  if (!(install || auth) || !win || !origin()) return;
  browser.close();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (install) await win.loadURL(`${origin()}/games/${install[1]}?install=1`);
  else if (auth && signInNonce) {
    const nonce = signInNonce;
    signInNonce = null;
    await win.loadURL(`${origin()}/api/auth/oidc/app?code=${auth[1]}&app=${nonce}`);
  }
}

/** Proves to the server that a sign-in handed back from the browser is the one this app started. */
let signInNonce: string | null = null;

/**
 * Google and other providers refuse to sign in inside an app window, so single sign-on runs
 * in the system browser and comes back through lootden://auth. Servers from before 0.12.2
 * can't hand back, so the sign-in stays in the window for them.
 */
async function startSignIn(url: string): Promise<void> {
  let handoff = false;
  try {
    const res = await net.fetch(`${origin()}/api/auth/providers`);
    handoff = !!((await res.json()) as { oidc?: { appHandoff?: boolean } }).oidc?.appHandoff;
  } catch {
    // Unreachable or old server: fall back to the window.
  }
  if (!handoff) return void win?.loadURL(url);
  signInNonce = randomBytes(32).toString("base64url");
  const target = new URL(url);
  target.searchParams.set("app", signInNonce);
  await shell.openExternal(target.toString());
}

// Windows and Linux: no system title bar. The page's top bar is the drag area, and the
// system draws minimize, maximize and close over its right end in the theme's colours, so
// snapping and double-click to maximize keep working. macOS keeps its own title bar.
const customFrame = process.platform !== "darwin";
const TITLEBAR_HEIGHT = 40;
const frameState = () => ({ custom: customFrame, fullscreen: !!win?.isFullScreen(), height: TITLEBAR_HEIGHT, handheld: handheldActive(settings.get()) });
const sendFrame = () => win?.webContents.send("gm:frame", frameState());

/** The window is on another site than the server, which only a sign-in redirect leads to. */
function onSignInPages(): boolean {
  const current = win?.webContents.getURL() ?? "";
  return !!origin() && /^https?:\/\//.test(current) && !current.startsWith(origin() + "/");
}

async function createWindow(): Promise<void> {
  const s = settings.get();
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: "#0d0820",
    fullscreen: s.fullscreen || handheldActive(s) || launchFullscreen,
    show: launchFullscreen || !(startHidden && tray && !handheldActive(s)),
    autoHideMenuBar: true,
    title: "LootDen",
    ...(customFrame ? { titleBarStyle: "hidden" as const, titleBarOverlay: { color: "#0d0820", symbolColor: "#f3eeff", height: TITLEBAR_HEIGHT } } : {}),
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  Menu.setApplicationMenu(null);
  // Links to other sites (news, screenshots) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: "deny" };
  });
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback, details) => callback(permissionAllowed(permission, details.requestingUrl, origin())));
  win.webContents.on("will-navigate", (event, url) => {
    if (origin() && url.startsWith(`${origin()}/api/auth/oidc/login`)) {
      event.preventDefault();
      void startSignIn(url);
      return;
    }
    if (isFile(url, SETUP_PAGE) || onOrigin(url, origin())) return;
    // Single sign-on: the server redirects the window to the identity provider, which may
    // hand on to another (TinyAuth to Google). Those pages keep their cookies in this
    // window, so they stay here until the provider sends the window back to the server.
    if (onSignInPages() && /^https?:\/\//.test(url)) return;
    event.preventDefault();
    openLink(url);
  });
  // Closing hides the window to the tray: the app keeps tracking play time and installs.
  win.on("close", (event) => {
    if (quitting || !tray || !settings.get().closeToTray) return;
    event.preventDefault();
    win?.hide();
    if (!settings.get().trayHintShown) {
      settings.update({ trayHintShown: true });
      if (Notification.isSupported())
        new Notification({ title: "LootDen is still running", body: "It keeps tracking play time and installs from the tray. Right-click the tray icon to quit, or change this in your profile." }).show();
    }
    // Closed with an update waiting: a good moment to install it.
    if (update.state === "ready" && !busy() && settings.get().autoUpdate) void installNow();
  });
  win.on("closed", () => (win = null));
  // Zoom is kept per page load, and the server's address can change.
  win.webContents.on("did-finish-load", () => win?.webContents.setZoomFactor(handheldActive(settings.get()) ? HANDHELD_ZOOM : 1));
  win.on("enter-full-screen", sendFrame);
  win.on("leave-full-screen", sendFrame);
  win.webContents.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown" && input.key === "F11") win?.setFullScreen(!win.isFullScreen());
    // The provider's pages have no LootDen title bar; Escape backs out of a sign-in.
    if (input.type === "keyDown" && input.key === "Escape" && onSignInPages()) void win?.loadURL(origin());
  });
  // The server's pages failing to load (it's off, or this PC is away from home) shows the
  // offline library instead of an error page. Aborted loads (-3) are just navigations replaced by others.
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && onOrigin(url, origin())) showOffline();
  });
  win.webContents.on("did-finish-load", () => {
    if (onOrigin(win?.webContents.getURL() ?? "", origin())) void flushPendingPlays();
  });
  if (!s.serverUrl) await win.loadFile(SETUP_PAGE);
  // A reverse proxy answers with its own error page when the server behind it is down, so ask the server itself first.
  else if (!(await serverUp())) showOffline();
  else await win.loadURL(s.serverUrl).catch(() => {});
  if (pendingDeepLink) {
    await openDeepLink(pendingDeepLink);
    pendingDeepLink = null;
  }
}

app.on("second-instance", (_e, argv) => {
  const link = argv.find(isDeepLink);
  if (link) {
    browser.close();
    win?.show();
    void openDeepLink(link);
  } else if (!argv.includes("--browser")) showWindow();
  if (argv.includes("--fullscreen") && win && !win.isFullScreen()) win.setFullScreen(true);
  if (argv.includes("--browser")) void browser.open();
});
app.on("before-quit", () => (quitting = true));
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("open-url", (e, url) => {
  e.preventDefault();
  void openDeepLink(url);
});
app.on("window-all-closed", () => {
  if (quitting || !tray || !settings.get().closeToTray) app.quit();
});

// Google refuses sign-in from browsers that name themselves Electron, so the app presents as
// the Chrome it is built on. Nothing on the server depends on the app's user agent.
app.userAgentFallback = app.userAgentFallback.replace(/ (?:Electron|LootDen|@lootden\/desktop)\/\S+/gi, "");

void app.whenReady().then(async () => {
  settings = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
  registerIpc();
  truckMods = new TruckMods({ settings: () => settings, client, send, fromServer }, () => (existsSync(bundled7za()) ? bundled7za() : ""));
  truckMods.registerIpc();
  browser = new WebBrowser({
    settings: () => settings,
    mainWindow: () => win,
    handheld: () => handheldActive(settings.get()),
    customFrame,
    titlebarHeight: TITLEBAR_HEIGHT,
    zoom: HANDHELD_ZOOM,
    shellPage: BROWSER_PAGE,
    blockedPage: path.join(__dirname, "..", "setup", "blocked.html"),
    policy: browserPolicy,
    preload: path.join(__dirname, "browser-preload.cjs"),
    icon: path.join(__dirname, "..", "build", "icon.png"),
    onDownload: (item, wc, owner) => truckMods.handleDownload(item, wc, owner),
  });
  browser.registerIpc();
  createTray();
  applyLoginItem(settings.get());
  setJumpList();
  await createWindow();
  if (launchBrowser) void browser.open();
  // The copy replaced by the last update.
  const self = process.env.PORTABLE_EXECUTABLE_FILE ?? process.env.APPIMAGE;
  if (self) void rm(`${self}.old`, { force: true }).catch(() => {});
  void rm(path.join(app.getPath("temp"), "lootden-update"), { recursive: true, force: true }).catch(() => {});
  // Look for app updates shortly after start, then every few hours.
  setTimeout(() => void checkForUpdate(), 30_000);
  setInterval(() => void checkForUpdate(), 4 * 3600_000);
  // Now Playing: tell the server what runs here, and pick up parents' messages.
  scheduleHeartbeat(10_000);
});
