import { useEffect, useState } from "react";
import type { GameDetail, LocalStoreGame } from "@lootden/shared";

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

export type Progress =
  | { gameId: string; type: "start"; gameDir: string; totalBytes: number }
  | { gameId: string; type: "download"; file: string; index: number; count: number; received: number; total: number }
  | { gameId: string; type: "downloaded"; file: string; skipped: boolean }
  | { gameId: string; type: "extract"; archive: string }
  | { gameId: string; type: "removed"; files: string[] }
  | { gameId: string; type: "warning"; message: string }
  | { gameId: string; type: "done"; gameDir: string }
  | { gameId: string; type: "error" | "cancelled"; message: string }
  | { gameId: string; type: "playing" }
  | { gameId: string; type: "stopped"; seconds: number }
  | { gameId: string; type: "workshop"; itemId: string; line: string }
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
}

/** An installed game as this PC knows it: its manifest, the server's details last time it had them, and its cached cover. */
export interface LocalGameCopy {
  game: InstalledGame;
  detail: GameDetail | null;
  /** A data: URL. */
  cover: string | null;
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
  play(gameId: string): Promise<{ executable: string } | null>;
  uninstall(gameId: string): Promise<boolean>;
  openFolder(gameId: string): Promise<void>;
  /** A game installed on this PC with its last known details and cover, for when the server no longer has it. Newer apps only. */
  localGame?(gameId: string): Promise<LocalGameCopy | null>;
  /** Library add-ons: store games installed on this PC, and starting one through its launcher (apps from 0.14.0). */
  storeGames?(): Promise<LocalStoreGame[]>;
  launchStore?(url: string): Promise<void>;
  /** Steam Workshop items in an installed game's mods folder, and adding or removing one (newer apps only). */
  workshopItems?(gameId: string): Promise<InstalledWorkshopItem[]>;
  installWorkshopItem?(gameId: string, itemId: string, title: string): Promise<InstalledWorkshopItem>;
  removeWorkshopItem?(gameId: string, itemId: string): Promise<void>;
  /** The built-in web browser, over LootDen, on its start page or a web page (newer apps only). */
  openBrowser?(url?: string): Promise<void>;
  /** This PC's store scanner settings, and adding a folder to it through the folder picker (newer apps only). */
  storeScan?(patch?: { disabled?: string[]; folders?: string[] }): Promise<StoreScanSettings>;
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
  restoreSaves?(gameId: string, saveId: number): Promise<{ previous: string | null } | null>;
  /** Emulators: missing in apps older than emulation support. */
  emulators?(): Promise<{ toolsDir: string; emulators: EmulatorSetup[] }>;
  installEmulator?(id: string): Promise<{ version: string }>;
  addBios?(id: string): Promise<string[]>;
  biosFromServer?(): Promise<{ added: string[]; skipped: string[] }>;
  openTools?(): Promise<void>;
  changeServer(): Promise<void>;
  /** Switches to the app's offline library when the server really can't be reached (apps from 0.13.2). */
  goOffline?(): Promise<boolean>;
  toggleFullscreen(): Promise<boolean>;
  /** Tray, start-up and update options (missing in apps before 0.9.1). */
  appSettings?(patch?: Partial<Pick<AppSettings, "closeToTray" | "autoUpdate" | "openAtLogin" | "handheld" | "fullscreen" | "browserLinks">>): Promise<AppSettings>;
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

export interface InstalledWorkshopItem {
  id: string;
  title: string;
  installedAt: string;
  dir: string;
}
