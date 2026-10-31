import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bookmark, BrowserPolicy, KeptAllowance, SearchEngine } from "@lootden/client";

export interface DesktopSettings {
  serverUrl: string;
  /** Personal API token for this computer, created after the first sign-in. */
  apiToken: string;
  /** Whose profile apiToken belongs to, and every profile's own token on this PC, so play time goes to whoever is signed in. */
  apiTokenUser?: number;
  profileTokens?: Record<string, string>;
  /** Today's play time allowance as the server last gave it, for limits while offline. */
  keptAllowance?: KeptAllowance;
  /** Whose saves are in each game's save folder now (game id to profile id), for save slots. */
  saveOwners?: Record<string, number>;
  /** Where games go by default. */
  installDir: string;
  /** Every folder games have been installed to, so they can be found again. */
  libraryDirs: string[];
  keepArchives: boolean;
  /** Start in fullscreen "couch" mode (handhelds, TVs). */
  fullscreen: boolean;
  /** Handheld mode: full screen, larger UI, opens in front at login. "auto" turns it on for small touchscreen PCs (ROG Ally, Steam Deck, Legion Go). */
  handheld: "auto" | "on" | "off";
  /** Emulators, their BIOS files and saves. Empty means the app's data folder. */
  toolsDir: string;
  /** Closing the window keeps the app in the system tray, tracking play time and installs. */
  closeToTray: boolean;
  /** Download new app versions from the server and install them when the app is idle. */
  autoUpdate: boolean;
  /** Install app updates that don't match a GitHub release's SHA256SUMS (your own builds, PCs without internet). Settings file only. */
  allowUnverifiedUpdates?: boolean;
  /** Start with the computer (in the tray). */
  openAtLogin: boolean;
  /** The "still running in the tray" hint was shown once. */
  trayHintShown: boolean;
  /** Play time recorded while the server couldn't be reached, sent when the app is back online. */
  pendingPlays: Array<{ gameId: string; seconds: number; playedAt: string }>;
  /** Other stores' games on this PC: launchers not to look in, and extra folders to look in (picked in Profile, This computer). */
  storeScan: { disabled: string[]; folders: string[] };
  /** The web UI's theme colours (#hex), so the offline page looks like the app. Missing until the app has been online. */
  offlineTheme?: Record<string, string>;
  /** The built-in browser's start page sites. Missing means the defaults. */
  browserBookmarks?: Bookmark[];
  browserSearch?: SearchEngine;
  /** The browser rules the server last gave for the person signed in here, for when it can't be reached. */
  browserPolicy?: BrowserPolicy;
  /** Links from LootDen's pages open in the built-in browser instead of the system one. "auto" does so in handheld mode. */
  browserLinks?: "auto" | "on" | "off";
}

export function defaultSettings(): DesktopSettings {
  const installDir = process.platform === "win32" ? "C:\\Games" : path.join(os.homedir(), "Games");
  return { serverUrl: "", apiToken: "", installDir, libraryDirs: [installDir], keepArchives: false, fullscreen: false, handheld: "auto", toolsDir: "", closeToTray: true, autoUpdate: true, openAtLogin: false, trayHintShown: false, pendingPlays: [], storeScan: { disabled: [], folders: [] } };
}

export class SettingsStore {
  private value: DesktopSettings;

  constructor(private readonly file: string) {
    try {
      this.value = { ...defaultSettings(), ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      this.value = defaultSettings();
    }
  }

  get(): DesktopSettings {
    const scan = this.value.storeScan ?? { disabled: [], folders: [] };
    return { ...this.value, libraryDirs: [...this.value.libraryDirs], pendingPlays: [...this.value.pendingPlays], storeScan: { disabled: [...(scan.disabled ?? [])], folders: [...(scan.folders ?? [])] } };
  }

  update(patch: Partial<DesktopSettings>): DesktopSettings {
    this.value = { ...this.value, ...patch };
    if (!this.value.libraryDirs.includes(this.value.installDir)) this.value.libraryDirs.push(this.value.installDir);
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    return this.get();
  }
}
