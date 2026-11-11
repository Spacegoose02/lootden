// The built-in browser's toolbar and start page are the desktop app's own (packages/desktop/setup/
// browser.html, copied in at build time). This gives that page the window.lootdenBrowser it
// expects, answered by BrowserActivity instead of Electron.
(() => {
  if (window.lootdenBrowser || !window.LootDenBrowserNative) return;
  const native = window.LootDenBrowserNative;
  let seq = 0;
  const pending = new Map();
  const listeners = { state: [], offer: [], focusAddress: [] };
  window.__lootdenBrowser = {
    reply(id, ok, value) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(value);
      else p.reject(new Error(value || "Something went wrong"));
    },
    event(name, value) {
      for (const cb of listeners[name] || []) {
        try {
          cb(value);
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
  const api = {
    onState: (cb) => listeners.state.push(cb),
    onOffer: (cb) => listeners.offer.push(cb),
    onFocusAddress: (cb) => listeners.focusAddress.push(cb),
  };
  for (const name of [
    "state", "layout", "navigate", "back", "forward", "reload", "stop", "home", "newTab", "closeTab", "selectTab", "stepTab", "open",
    "bookmarks", "resetBookmarks", "toggleBookmark", "search", "launch", "close", "fullscreen", "focusPage", "focusShell",
    "pointer", "click", "scroll", "key", "sendDownload", "sendPage", "dismissOffer", "openDownloads",
  ]) api[name] = call(name);
  window.lootdenBrowser = api;
})();
