import { useEffect, useState } from "react";
import type { ActiveTruckMod, DuplicateModGroup, GameDetail, GlobalLaunchScripts, InstalledTruckMod, LaunchProfile, LocalStoreGame, ModLinkCheck, TruckGame, TruckModFile, TruckProfile } from "@lootden/shared";

export interface Drive {
  path: string;
  label: string;
  freeBytes: number;
  totalBytes: number;
}

export interface InstalledGame {
  gameId: string;
  title: string;
  dir: string;
  installedAt: string;
  executable?: string;
  /** Missing in apps older than emulation support. */
  platform?: string;
  /** The download is still a disc image or installer (missing in older apps). */
  needsSetup?: "disc" | "installer" | null;
  /** Where the installer put the game, once it has been run. */
  installedDir?: string;
  /** The installed version, and the updates and DLC applied to this copy (missing in older apps). */
  version?: string | null;
  updates?: AppliedUpdate[];
  /** The version stamped on the game's executable, when it has one (missing in older apps). */
  exeVersion?: string | null;
}

export interface AppliedUpdate {
  id: string;
  title: string;
  kind: "update" | "dlc";
  previousVersion: string | null;
  version: string | null;
  mode: "files" | "installer";
  appliedAt: string;
  replaced: number;
  added: number;
}

export interface EmulatorSetup {
  id: string;
  installed: { version: string; exe: string; installedAt: string; cores?: string[] } | null;
  bios: Array<{ id: string; present: string | null }>;
}

/** One of a recomp's settings, as its recomplauncher.json describes it, and what it's on. */
export interface RecompSettingView {
  id: string;
  label: string;
  help: string;
  choices: string[];
  current: number;
  disabled: boolean;
}

export interface RecompInstalledMod {
  full: string;
  name: string;
  version: string;
  files: string[];
  dep: boolean;
}

/** A recomp's mods on Thunderstore, and the ones on this PC. */
export interface RecompModsView {
  community: string;
  available: Array<{ full: string; name: string; owner: string; description: string; icon: string; version: string; page: string; downloads: number; rating: number }>;
  installed: RecompInstalledMod[];
  others: string[];
}

export interface RecompSetup {
  id: string;
  installed: { version: string; installedAt: string } | null;
}

export type Progress =
  | { gameId: string; type: "start"; gameDir: string; totalBytes: number }
  | { gameId: string; type: "download"; file: string; index: number; count: number; received: number; total: number }
  | { gameId: string; type: "downloaded"; file: string; skipped: boolean }
  | { gameId: string; type: "extract"; archive: string }
  | { gameId: string; type: "removed"; files: string[] }
  | { gameId: string; type: "warning"; message: string }
  | { gameId: string; type: "done"; gameDir: string }
  | { gameId: string; type: "error" | "cancelled"; message: string }
  | { gameId: string; type: "playing"; action?: string }
  /** The game was paused or picked up again (suspend). */
  | { gameId: string; type: "suspended" | "resumed" }
  | { gameId: string; type: "stopped"; seconds: number }
  | { gameId: string; type: "workshop"; itemId: string; line: string }
  /** ATS/ETS2 mods being added (gameId is "truck-mods:<game>"). */
  | { gameId: string; type: "truckMods"; game: TruckGame; line: string; done: boolean; error: boolean }
  /** The mod list's page checks (gameId is "truck-mods:<game>"). */
  | { gameId: string; type: "truckModCheck"; game: TruckGame; done: number; total: number; line: string; finished: boolean }
  | { gameId: string; type: "saves"; backupId?: number; size?: number; error?: string }
  | { gameId: string; type: "prepare"; message: string; done?: boolean; error?: boolean; newId?: string }
  /** Play time heads-ups and time's up (shown by FunLayer, not on the game's page). */
  | { gameId: string; type: "limit"; title: string; message: string }
  | ({ gameId: "lootden-app"; type: "appUpdate" } & AppUpdate);

/** The desktop app's own updates, from the server's Get the app page. */
export interface AppUpdate {
  current: string;
  kind?: "installer" | "portable" | "appimage" | "other";
  state: "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error" | "unsupported";
  version?: string;
  received?: number;
  total?: number;
  error?: string;
  checkedAt?: string;
}

export interface AppSettings {
  closeToTray: boolean;
  autoUpdate: boolean;
  openAtLogin: boolean;
  /** False when Windows was told not to start it (Settings > Apps > Startup). Missing in older apps. */
  loginItemEnabled?: boolean;
  /** Always open full screen. Missing in older apps. */
  fullscreen?: boolean;
  /** Handheld mode; missing in older apps. */
  handheld?: "auto" | "on" | "off";
  /** Links open in the built-in browser: "auto" does so in handheld mode (apps with the browser only). */
  browserLinks?: "auto" | "on" | "off";
  handheldActive?: boolean;
  looksHandheld?: boolean;
  trayAvailable: boolean;
  loginItemSupported: boolean;
  /** Launch splash, the suspend key and Discord status (newer apps only). */
  splash?: "off" | "handheld" | "on";
  suspendKey?: boolean;
  /** Back up other stores' games' saves after playing (newer apps only). */
  storeSaves?: boolean;
  discordEnabled?: boolean;
  discordClientId?: string;
}

export type AppSettingsPatch = Partial<Pick<AppSettings, "closeToTray" | "autoUpdate" | "openAtLogin" | "handheld" | "fullscreen" | "browserLinks" | "splash" | "suspendKey" | "storeSaves" | "discordEnabled" | "discordClientId">>;

export interface StoreSavesState {
  /** The game's name in Ludusavi's list, when found. */
  name: string | null;
  locations: string[];
  /** How many of those places have files on this PC now. */
  found: number;
  installed: boolean;
  /** Backed up after each session started from LootDen. */
  auto: boolean;
}

/** A game's launch options on this PC, with every game's steps and the folder relative paths start in. */
export interface LaunchOptionsState {
  profile: LaunchProfile | null;
  global: GlobalLaunchScripts;
  /** Null when the game isn't installed here. */
  dir: string | null;
  suspendKey: boolean;
  platform: string;
}

/** An installed game as this PC knows it: its manifest, the server's details last time it had them, and its cached cover. */
export interface LocalGameCopy {
  game: InstalledGame;
  detail: GameDetail | null;
  /** A data: URL. */
  cover: string | null;
}

/** A screenshot found on this PC: a token stands in for its path. */
export interface LocalShot {
  token: string;
  from: "steam" | "captures";
  takenAt: string;
  bytes: number;
  /** A small data: URL, null when the picture couldn't be read. */
  thumb: string | null;
  name: string;
}

/** Bridge the desktop app injects (packages/desktop/src/preload.ts). Absent in a normal browser. */
export interface DesktopBridge {
  version: number;
  info(): Promise<{ platform: string; version: string; installDir: string; libraryDirs: string[]; hostname: string; installing: string[] }>;
  drives(): Promise<Drive[]>;
  chooseFolder(): Promise<string | null>;
  setInstallDir(dir: string): Promise<string>;
  installed(): Promise<InstalledGame[]>;
  install(gameId: string, dir?: string): Promise<{ gameDir: string }>;
  cancel(gameId: string): Promise<void>;
  /** actionId picks one of the game's launch options; "" is the game's own way (apps from 0.25 take it). */
  play(gameId: string, actionId?: string): Promise<{ executable: string } | null>;
  /** Launch options on this PC: extra ways to start a game and steps before and after it (apps from 0.25). */
  launchOptions?(key: string): Promise<LaunchOptionsState>;
  setLaunchOptions?(key: string, profile: LaunchProfile | null, title?: string): Promise<LaunchProfile | null>;
  setLaunchScripts?(scripts: GlobalLaunchScripts): Promise<GlobalLaunchScripts>;
  pickProgram?(key: string): Promise<string | null>;
  /** Another store's game started with its launch options (steps before and after, Now Playing). */
  playStore?(addon: string, externalId: string, url: string, actionId?: string): Promise<void>;
  /** Pauses or resumes a running game (the newest when none is named). */
  suspend?(gameId?: string): Promise<{ gameId: string; suspended: boolean } | null>;
  uninstall(gameId: string): Promise<boolean>;
  openFolder(gameId: string): Promise<void>;
  /** A game installed on this PC with its last known details and cover, for when the server no longer has it. Newer apps only. */
  localGame?(gameId: string): Promise<LocalGameCopy | null>;
  /** Library add-ons: store games installed on this PC, and starting one through its launcher (apps from 0.14.0). */
  storeGames?(): Promise<LocalStoreGame[]>;
  /** A game's screenshots already on this PC (Steam's and Xbox Game Bar's), sharing one to the family wall, and opening one (newer apps only). */
  localScreenshots?(q: { steamAppId?: string | null; title: string }): Promise<LocalShot[]>;
  shareLocalScreenshot?(token: string, gameId?: string | null, title?: string | null): Promise<void>;
  openLocalScreenshot?(token: string): Promise<void>;
  launchStore?(url: string): Promise<void>;
  /** Steam Workshop items in an installed game's mods folder, and adding or removing one (newer apps only). */
  workshopItems?(gameId: string): Promise<InstalledWorkshopItem[]>;
  installWorkshopItem?(gameId: string, itemId: string, title: string): Promise<InstalledWorkshopItem>;
  removeWorkshopItem?(gameId: string, itemId: string): Promise<void>;
  /** ATS and ETS2 mods on this PC (newer apps only): the mod folder, what's in it, and adding or removing mods. */
  truckModsLocal?(game: TruckGame): Promise<TruckModsLocal>;
  installTruckMod?(game: TruckGame, id: number): Promise<InstalledTruckMod>;
  removeTruckMod?(game: TruckGame, key: string): Promise<void>;
  addTruckModFile?(game: TruckGame, share: boolean): Promise<InstalledTruckMod | null>;
  openTruckModFolder?(game: TruckGame): Promise<void>;
  pickTruckModFolder?(game: TruckGame, reset?: boolean): Promise<string>;
  /** The truck mod list's work on this PC: folder scan, page checks, updates, load order (newer apps only). */
  truckModScan?(game: TruckGame): Promise<TruckModScan>;
  checkTruckModLinks?(game: TruckGame, items: Array<{ id: number; url: string; name: string }>): Promise<Array<{ id: number; check: ModLinkCheck }>>;
  stopTruckModCheck?(): Promise<void>;
  updateTruckMod?(game: TruckGame, url: string, files: string[]): Promise<void>;
  retireTruckModFiles?(game: TruckGame, files: string[]): Promise<string[]>;
  applyTruckLoadOrder?(game: TruckGame, profileDir: string, mods: ActiveTruckMod[]): Promise<{ backup: string; profile: TruckProfile }>;
  enableTruckTextSaves?(game: TruckGame): Promise<boolean>;
  /** The built-in web browser, over LootDen, on its start page or a web page (newer apps only). */
  openBrowser?(url?: string): Promise<void>;
  /** This PC's store scanner settings, and adding a folder to it through the folder picker (newer apps only). */
  storeScan?(patch?: { disabled?: string[]; folders?: string[] }): Promise<StoreScanSettings>;
  /** Game streaming on this PC: Sunshine (host) and Moonlight (player). Apps from before 0.24 lack these. */
  streaming?(): Promise<StreamingStatus>;
  linkSunshine?(user: string, pass: string): Promise<StreamingStatus & { added: string[] }>;
  syncSunshine?(): Promise<StreamingStatus & { added: string[] }>;
  unlinkSunshine?(): Promise<StreamingStatus>;
  streamGame?(host: string, title: string): Promise<void>;
  addStoreFolder?(): Promise<StoreScanSettings>;
  /** Disc/installer games: install once on this PC and upload the result. Missing in older apps. */
  prepare?(gameId: string): Promise<GameDetailLike | null>;
  uploadFolder?(gameId: string): Promise<GameDetailLike | null>;
  /** Copies already on this PC, so nothing is downloaded twice. Missing in older apps. */
  locate?(gameId: string): Promise<{ installed: InstalledGame | null; relinked: boolean; loose: string[] }>;
  adopt?(gameId: string, dir: string): Promise<InstalledGame>;
  /** Downloaded installers: run the setup on this PC, and (admins) upload the installed game. */
  runSetup?(gameId: string): Promise<{ installedDir: string; executable?: string } | null>;
  uploadInstalled?(gameId: string): Promise<GameDetailLike | null>;
  /** Updates and DLC: apply one to its installed game (with a backup), or undo the latest. Missing in older apps. */
  applyUpdate?(updateId: string): Promise<AppliedUpdate | null>;
  undoUpdate?(updateId: string): Promise<AppliedUpdate | null>;
  /** Missing in desktop apps older than save sync. */
  backupSaves?(gameId: string): Promise<{ backupId: number; size: number } | { error: string }>;
  /** Another store's game's saves on this PC, through Ludusavi's list (newer apps only). */
  storeSaves?(addon: string, externalId: string, title: string): Promise<StoreSavesState>;
  backupStoreSaves?(addon: string, externalId: string, title: string): Promise<{ backupId: number; size: number; files: number }>;
  restoreStoreSaves?(addon: string, externalId: string, title: string, saveId: number): Promise<{ restored: number; previous: string } | null>;
  restoreSaves?(gameId: string, saveId: number): Promise<{ previous: string | null } | null>;
  /** Emulators: missing in apps older than emulation support. */
  emulators?(): Promise<{ toolsDir: string; emulators: EmulatorSetup[] }>;
  installEmulator?(id: string): Promise<{ version: string }>;
  addBios?(id: string): Promise<string[]>;
  biosFromServer?(): Promise<{ added: string[]; skipped: string[] }>;
  openTools?(): Promise<void>;
  /** Recomps (native PC versions of console games): missing in older apps. */
  recomps?(): Promise<{ toolsDir: string; recomps: RecompSetup[] }>;
  installRecomp?(id: string): Promise<{ version: string; updated: boolean }>;
  removeRecomp?(id: string): Promise<{ keptSaves: boolean }>;
  recompUpdates?(): Promise<Array<{ id: string; installed: string; latest: string }>>;
  recompSettings?(id: string): Promise<RecompSettingView[]>;
  recompMods?(id: string): Promise<RecompModsView | null>;
  installRecompMod?(id: string, full: string): Promise<RecompInstalledMod[]>;
  removeRecompMod?(id: string, full: string): Promise<RecompInstalledMod[]>;
  setRecompSetting?(id: string, settingId: string, choice: number): Promise<RecompSettingView[]>;
  changeServer(): Promise<void>;
  /** Switches to the app's offline library when the server really can't be reached (apps from 0.13.2). */
  goOffline?(): Promise<boolean>;
  toggleFullscreen(): Promise<boolean>;
  /** Tray, start-up and update options (missing in apps before 0.9.1). */
  appSettings?(patch?: AppSettingsPatch): Promise<AppSettings>;
  appUpdate?(action?: "status" | "check" | "install"): Promise<AppUpdate>;
  /** Quits the app for real (closing the window only hides it to the tray). */
  quit?(): Promise<void>;
  /** Colours of the window buttons drawn over the top bar (apps from 0.11.2; older ones keep the system title bar). */
  titleBarColors?(color: string, symbolColor: string): Promise<void>;
  /** Keeps the theme's colours for the offline page (newer apps only). */
  offlineTheme?(colors: Record<string, string>): Promise<void>;
  onProgress(cb: (p: Progress) => void): () => void;
}

type GameDetailLike = { id: string };

// Desktop apps from before the rename to LootDen expose the bridge as window.gameManager.
const w = window as unknown as { lootden?: DesktopBridge; gameManager?: DesktopBridge };
export const desktop: DesktopBridge | undefined = w.lootden ?? w.gameManager;

/** Electron prefixes errors from the main process; keep just the message. */
export const bridgeError = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Live install/play state for one game in the desktop app. */
export function useDesktopGame(gameId: string) {
  const [installed, setInstalled] = useState<InstalledGame | null>(null);
  const [loose, setLoose] = useState<string[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);

  /** Also finds this game installed under an old id or title, and copies made by hand. */
  const refresh = async () => {
    if (!desktop) return;
    if (desktop.locate) {
      const found = await desktop.locate(gameId).catch(() => null);
      if (found) {
        setInstalled(found.installed);
        setLoose(found.loose);
        return;
      }
    }
    setInstalled((await desktop.installed()).find((g) => g.gameId === gameId) ?? null);
  };

  useEffect(() => {
    if (!desktop) return;
    void refresh();
    return desktop.onProgress((p) => {
      if (p.gameId !== gameId || p.type === "limit") return;
      setProgress(p);
      if (p.type === "done" || p.type === "stopped" || (p.type === "prepare" && p.done)) void refresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  return { installed, loose, progress, refresh, setProgress };
}

/** Which launchers the desktop app looks in for store games, and the folders picked on this PC. */
export interface StoreScanSettings {
  stores: Array<{ id: string; name: string; enabled: boolean }>;
  folders: string[];
}

/** What the desktop app finds for a truck game on this PC, for the mod list and load order. */
export interface TruckModScan {
  modFolder: string;
  gameFolder: string;
  gameVersion: string | null;
  files: TruckModFile[];
  duplicates: DuplicateModGroup[];
  /** Workshop items Steam has downloaded for the game (the subscriptions). */
  workshop: Array<{ id: string; updatedAt: string | null; sizeBytes: number }>;
  profiles: TruckProfile[];
}

/** A truck game's mod folder on this PC, as the desktop app sees it. */
export interface TruckModsLocal {
  folder: string;
  /** The folder was picked on this PC (not the usual one in Documents). */
  custom: boolean;
  /** From the game's game.log.txt; null until the game has run once. */
  gameVersion: string | null;
  installed: InstalledTruckMod[];
  files: TruckModFile[];
}

export interface InstalledWorkshopItem {
  id: string;
  title: string;
  installedAt: string;
  dir: string;
}

/** Game streaming on this PC. */
export interface StreamingStatus {
  hostname: string;
  sunshine: boolean;
  moonlight: boolean;
  /** Sunshine's login is saved, so LootDen keeps its games in Sunshine. */
  linked: boolean;
  streamGames: number;
}
