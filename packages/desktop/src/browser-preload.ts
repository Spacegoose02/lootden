import { contextBridge, ipcRenderer } from "electron";

// The built-in browser's toolbar and start page (setup/browser.html). Pages opened in the
// browser get no preload at all.
const call =
  (name: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(`gm:browser:${name}`, ...args);

contextBridge.exposeInMainWorld("lootdenBrowser", {
  state: call("state"),
  layout: call("layout"),
  navigate: call("navigate"),
  back: call("back"),
  forward: call("forward"),
  reload: call("reload"),
  stop: call("stop"),
  home: call("home"),
  newTab: call("newTab"),
  closeTab: call("closeTab"),
  selectTab: call("selectTab"),
  stepTab: call("stepTab"),
  open: call("open"),
  bookmarks: call("bookmarks"),
  resetBookmarks: call("resetBookmarks"),
  toggleBookmark: call("toggleBookmark"),
  search: call("search"),
  launch: call("launch"),
  close: call("close"),
  fullscreen: call("fullscreen"),
  focusPage: call("focusPage"),
  focusShell: call("focusShell"),
  pointer: call("pointer"),
  click: call("click"),
  scroll: call("scroll"),
  key: call("key"),
  onState: (cb: (s: unknown) => void) => ipcRenderer.on("gm:browser:state", (_e, s) => cb(s)),
  onFocusAddress: (cb: () => void) => ipcRenderer.on("gm:browser:focusAddress", () => cb()),
});
