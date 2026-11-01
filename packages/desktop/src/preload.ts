import { contextBridge, ipcRenderer } from "electron";

// The web UI checks for window.lootden to switch from "copy this command" to real install,
// play and uninstall buttons. It's also exposed as window.gameManager, its name before the
// rename, for server versions from before 0.7.
const bridge = {
  version: 1,
  info: () => ipcRenderer.invoke("gm:info"),
  drives: () => ipcRenderer.invoke("gm:drives"),
  chooseFolder: () => ipcRenderer.invoke("gm:chooseFolder"),
  setInstallDir: (dir: string) => ipcRenderer.invoke("gm:setInstallDir", dir),
  installed: () => ipcRenderer.invoke("gm:installed"),
  install: (gameId: string, dir?: string) => ipcRenderer.invoke("gm:install", gameId, dir),
  cancel: (gameId: string) => ipcRenderer.invoke("gm:cancel", gameId),
  play: (gameId: string, actionId?: string) => ipcRenderer.invoke("gm:play", gameId, actionId),
  playStore: (addon: string, externalId: string, url: string, actionId?: string) => ipcRenderer.invoke("gm:playStore", addon, externalId, url, actionId),
  launchOptions: (key: string) => ipcRenderer.invoke("gm:launchOptions", key),
  setLaunchOptions: (key: string, profile: unknown, title?: string) => ipcRenderer.invoke("gm:setLaunchOptions", key, profile, title),
  setLaunchScripts: (scripts: unknown) => ipcRenderer.invoke("gm:setLaunchScripts", scripts),
  pickProgram: (key: string) => ipcRenderer.invoke("gm:pickProgram", key),
  suspend: (gameId?: string) => ipcRenderer.invoke("gm:suspend", gameId),
  uninstall: (gameId: string) => ipcRenderer.invoke("gm:uninstall", gameId),
  backupSaves: (gameId: string) => ipcRenderer.invoke("gm:backupSaves", gameId),
  restoreSaves: (gameId: string, saveId: number) => ipcRenderer.invoke("gm:restoreSaves", gameId, saveId),
  prepare: (gameId: string) => ipcRenderer.invoke("gm:prepare", gameId),
  uploadFolder: (gameId: string) => ipcRenderer.invoke("gm:uploadFolder", gameId),
  locate: (gameId: string) => ipcRenderer.invoke("gm:locate", gameId),
  adopt: (gameId: string, dir: string) => ipcRenderer.invoke("gm:adopt", gameId, dir),
  runSetup: (gameId: string) => ipcRenderer.invoke("gm:runSetup", gameId),
  uploadInstalled: (gameId: string) => ipcRenderer.invoke("gm:uploadInstalled", gameId),
  applyUpdate: (updateId: string) => ipcRenderer.invoke("gm:applyUpdate", updateId),
  undoUpdate: (updateId: string) => ipcRenderer.invoke("gm:undoUpdate", updateId),
  emulators: () => ipcRenderer.invoke("gm:emulators"),
  installEmulator: (id: string) => ipcRenderer.invoke("gm:installEmulator", id),
  addBios: (id: string) => ipcRenderer.invoke("gm:addBios", id),
  biosFromServer: () => ipcRenderer.invoke("gm:biosFromServer"),
  openTools: () => ipcRenderer.invoke("gm:openTools"),
  openFolder: (gameId: string) => ipcRenderer.invoke("gm:openFolder", gameId),
  localGame: (gameId: string) => ipcRenderer.invoke("gm:localGame", gameId),
  storeGames: () => ipcRenderer.invoke("gm:storeGames"),
  localScreenshots: (q: { steamAppId?: string | null; title: string }) => ipcRenderer.invoke("gm:localScreenshots", q),
  shareLocalScreenshot: (token: string, gameId?: string | null, title?: string | null) => ipcRenderer.invoke("gm:shareLocalScreenshot", token, gameId, title),
  openLocalScreenshot: (token: string) => ipcRenderer.invoke("gm:openLocalScreenshot", token),
  workshopItems: (gameId: string) => ipcRenderer.invoke("gm:workshop:list", gameId),
  installWorkshopItem: (gameId: string, itemId: string, title: string) => ipcRenderer.invoke("gm:workshop:install", gameId, itemId, title),
  removeWorkshopItem: (gameId: string, itemId: string) => ipcRenderer.invoke("gm:workshop:remove", gameId, itemId),
  truckModsLocal: (game: string) => ipcRenderer.invoke("gm:truckMods:local", game),
  installTruckMod: (game: string, id: number) => ipcRenderer.invoke("gm:truckMods:install", game, id),
  removeTruckMod: (game: string, key: string) => ipcRenderer.invoke("gm:truckMods:remove", game, key),
  addTruckModFile: (game: string, share: boolean) => ipcRenderer.invoke("gm:truckMods:addFile", game, share),
  openTruckModFolder: (game: string) => ipcRenderer.invoke("gm:truckMods:openFolder", game),
  pickTruckModFolder: (game: string, reset?: boolean) => ipcRenderer.invoke("gm:truckMods:pickFolder", game, reset),
  truckModScan: (game: string) => ipcRenderer.invoke("gm:truckModList:scan", game),
  checkTruckModLinks: (game: string, items: unknown) => ipcRenderer.invoke("gm:truckModList:check", game, items),
  stopTruckModCheck: () => ipcRenderer.invoke("gm:truckModList:stopCheck"),
  updateTruckMod: (game: string, url: string, files: string[]) => ipcRenderer.invoke("gm:truckModList:update", game, url, files),
  retireTruckModFiles: (game: string, files: string[]) => ipcRenderer.invoke("gm:truckModList:retire", game, files),
  applyTruckLoadOrder: (game: string, profileDir: string, mods: unknown) => ipcRenderer.invoke("gm:truckModList:applyLoadOrder", game, profileDir, mods),
  enableTruckTextSaves: (game: string) => ipcRenderer.invoke("gm:truckModList:textSaves", game),
  launchStore: (url: string) => ipcRenderer.invoke("gm:launchStore", url),
  openBrowser: (url?: string) => ipcRenderer.invoke("gm:openBrowser", url),
  storeScan: (patch?: object) => ipcRenderer.invoke("gm:storeScan", patch),
  addStoreFolder: () => ipcRenderer.invoke("gm:addStoreFolder"),
  streaming: () => ipcRenderer.invoke("gm:streaming"),
  linkSunshine: (user: string, pass: string) => ipcRenderer.invoke("gm:linkSunshine", user, pass),
  syncSunshine: () => ipcRenderer.invoke("gm:syncSunshine"),
  unlinkSunshine: () => ipcRenderer.invoke("gm:unlinkSunshine"),
  streamGame: (host: string, title: string) => ipcRenderer.invoke("gm:streamGame", host, title),
  changeServer: () => ipcRenderer.invoke("gm:changeServer"),
  /** The server stopped answering: switch to the offline library if it really is gone. */
  goOffline: () => ipcRenderer.invoke("gm:goOffline"),
  toggleFullscreen: () => ipcRenderer.invoke("gm:toggleFullscreen"),
  appSettings: (patch?: object) => ipcRenderer.invoke("gm:appSettings", patch),
  appUpdate: (action?: "status" | "check" | "install") => ipcRenderer.invoke("gm:appUpdate", action),
  quit: () => ipcRenderer.invoke("gm:quit"),
  titleBarColors: (color: string, symbolColor: string) => ipcRenderer.invoke("gm:titleBarColors", color, symbolColor),
  offlineTheme: (colors: Record<string, string>) => ipcRenderer.invoke("gm:offlineTheme", colors),
  onProgress: (cb: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on("gm:progress", listener);
    return () => ipcRenderer.removeListener("gm:progress", listener);
  },
};
contextBridge.exposeInMainWorld("lootden", bridge);
contextBridge.exposeInMainWorld("gameManager", bridge);

// No system title bar: <html data-lootden-frame> tells the page to make its top bar the drag
// area and leave room for the window buttons ("fullscreen" while those are hidden).
interface Frame {
  custom: boolean;
  fullscreen: boolean;
  height: number;
  /** Handheld mode: the page uses its couch layout. Missing in older apps. */
  handheld?: boolean;
}
let frame: Frame | null = null;
const markFrame = () => {
  const root = document.documentElement;
  if (!root || !frame) return;
  if (!frame.custom) delete root.dataset.lootdenFrame;
  else root.dataset.lootdenFrame = frame.fullscreen ? "fullscreen" : "hidden";
  root.style.setProperty("--lootden-titlebar", `${frame.height}px`);
  if (frame.handheld) root.dataset.handheld = "on";
  else delete root.dataset.handheld;
};
const setFrame = (f: Frame) => {
  frame = f;
  markFrame();
};
void ipcRenderer.invoke("gm:frame").then(setFrame);
ipcRenderer.on("gm:frame", (_e, f: Frame) => setFrame(f));
document.addEventListener("DOMContentLoaded", markFrame);

// The local setup page only needs to save the server address.
contextBridge.exposeInMainWorld("lootdenSetup", {
  connect: (url: string) => ipcRenderer.invoke("gm:setServer", url),
});

// The local offline page: the games on this PC, playable while the server can't be reached.
contextBridge.exposeInMainWorld("lootdenOffline", {
  library: () => ipcRenderer.invoke("gm:offline:library"),
  play: (gameId: string) => ipcRenderer.invoke("gm:offline:play", gameId),
  openFolder: (gameId: string) => ipcRenderer.invoke("gm:offline:openFolder", gameId),
  launchStore: (url: string) => ipcRenderer.invoke("gm:offline:launchStore", url),
  retry: () => ipcRenderer.invoke("gm:offline:retry"),
  changeServer: () => ipcRenderer.invoke("gm:changeServer"),
});
