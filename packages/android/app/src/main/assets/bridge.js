// The LootDen web page's bridge to the Android app, injected before the page's own scripts on the
// server's origin only. It speaks the same window.lootden interface as the desktop app's preload
// (packages/desktop/src/preload.ts), so the web UI needs no Android-only paths for the shared parts.
(() => {
  if (window.lootden || !window.LootDenNative) return;
  const native = window.LootDenNative;
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  native.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.event) {
      for (const cb of [...listeners]) {
        try {
          cb(m.event);
        } catch (err) {
          console.error(err);
        }
      }
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error || "Something went wrong"));
  };
  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      native.postMessage(JSON.stringify({ id, method, args: args.map((a) => (a === undefined ? null : a)) }));
    });
  const METHODS = [
    "info", "drives", "chooseFolder", "setInstallDir", "installed", "install", "cancel", "play", "uninstall", "openFolder",
    "changeServer", "toggleFullscreen", "appSettings", "appUpdate", "quit", "streaming", "streamGame",
    "androidEmulators", "setAndroidEmulator", "openStore", "openBrowser", "offlineTheme", "playInBrowser",
    "deviceApps", "setDeviceAppKind", "launchApp", "appDetails", "uninstallApp", "storeGames", "launchStore",
    "biosFromServer",
  ];
  const bridge = {
    version: 1,
    android: true,
    onProgress(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  for (const m of METHODS) bridge[m] = (...args) => call(m, ...args);
  window.lootden = bridge;
  // The couch layout: bigger type and focus rings that read from arm's length.
  const mark = () => document.documentElement && (document.documentElement.dataset.handheld = "on");
  mark();
  document.addEventListener("DOMContentLoaded", mark);
  // Lets the app send events (download progress, play sessions) to this page.
  native.postMessage(JSON.stringify({ id: 0, method: "hello", args: [] }));
})();
