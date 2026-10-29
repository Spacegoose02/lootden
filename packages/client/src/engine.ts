// Everything a front end (CLI, desktop app, Playnite bridge) needs from the client.
export { ApiError, GameServerClient } from "./api.js";
export { CONFIG_KEYS, configDir, configPath, defaults, loadConfig, saveConfigValue, type ClientConfig } from "./config.js";
export { listDrives, type Drive } from "./drives.js";
export { extractArchive, findSevenZip } from "./extractor.js";
export { adoptFolder, detectSetup, findCopies, listInstalled, saveManifest, uninstallGame, type GameRef, type InstalledGame } from "./installed.js";
export { installGame, isManifest, LEGACY_MANIFEST_NAME, MANIFEST_NAME, pickGame, type InstallEvent, type InstallOptions } from "./installer.js";
export { findExecutable, launchAndTrack, saveExecutable } from "./launcher.js";
export * from "./emulators.js";
export { backupSaves, expandSavePath, restoreSaves } from "./saves.js";
export { findSetup, prepareGame, runLocalSetup, uploadInstalledFolder, type PrepareStep } from "./prepare.js";
export { applyUpdate, BACKUP_FOLDER, undoUpdate, UpdateMismatchError, updateProblem, type AppliedUpdate, type ApplyUpdateOptions } from "./updates.js";
export { scanStoreGames, STORE_SCANNERS, type StoreScanner } from "./stores/index.js";
export { steamLibraryCover } from "./stores/steam.js";
export { downloadWorkshopItem, ensureSteamCmd, installWorkshopItem, listWorkshopItems, removeWorkshopItem, steamCmdResult, type InstalledWorkshopItem } from "./workshop.js";
export { isStoreLaunchUrl } from "@lootden/shared";
export { cleanPolicy, KID_SEARCH, KID_SITES, safeSearchUrl, siteAllowed, type BrowserPolicy } from "@lootden/shared";
export { addressToUrl, cleanBookmarks, DEFAULT_BOOKMARKS, KID_BOOKMARKS, isBrowsable, launcherShortcuts, MAX_BOOKMARKS, SEARCH_ENGINES, siteName, type Bookmark, type LauncherShortcut, type SearchEngine } from "./browser.js";
