// The offline library is the desktop app's own page (packages/desktop/setup/offline.html, copied
// in at build time). This gives it the window.lootdenOffline it expects, answered by MainActivity
// instead of Electron, and the window.lootden.onProgress it listens to for play sessions.
(() => {
  if (window.lootdenOffline || !window.LootDenOfflineNative) return;
  const native = window.LootDenOfflineNative;
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  window.__lootdenOffline = {
    reply(id, ok, value) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(value);
      else p.reject(new Error(value || "Something went wrong"));
    },
    event(message) {
      const e = message && message.event;
      if (!e) return;
      for (const cb of [...listeners]) {
        try {
          cb(e);
        } catch (err) {
          console.error(err);
        }
      }
    },
  };
  const call =
    (name) =>
    (...args) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        native.call(id, name, JSON.stringify(args.map((a) => (a === undefined ? null : a))));
      });
  const api = {};
  for (const name of ["library", "play", "launchStore", "openFolder", "retry", "changeServer", "settings", "chooseInstallDir", "setEmulator"]) api[name] = call(name);
  window.lootdenOffline = api;
  window.lootden = {
    android: true,
    onProgress(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  // The couch layout: bigger type and the controller hints.
  const mark = () => document.documentElement && (document.documentElement.dataset.handheld = "on");
  mark();
  document.addEventListener("DOMContentLoaded", mark);
})();
