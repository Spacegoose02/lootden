import { browserRomFile, platformFor, sharedSavePath, type GameDetail, type ServerBiosFile, EMULATORS } from "@lootden/shared";

/** EmulatorJS data folder. Point GM_EMULATORJS_DATA at a self-hosted copy to play without the CDN. */
export const emulatorJsData = () => process.env.GM_EMULATORJS_DATA || "https://cdn.emulatorjs.org/stable/data/";

const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** Whether a game can be played in the browser, and with which file. */
export function browserPlayable(game: GameDetail): { index: number; path: string } | null {
  return browserRomFile(game.files, platformFor(game.platform));
}

/**
 * A standalone page that runs EmulatorJS for one game. The web app shows it in a frame.
 * The page shares the in-game save with the desktop app: it starts from the player's newest
 * save backup and uploads the save whenever it changes, in the same layout the desktop
 * emulators use, so progress carries over in both directions.
 */
export function playPage(game: GameDetail, bios: ServerBiosFile[]): string {
  const platform = platformFor(game.platform);
  const rom = browserPlayable(game);
  if (!rom || !platform.browserCore) throw new Error("This game can't be played in the browser");
  const fileName = rom.path.split("/").pop()!;
  const emulator = EMULATORS.find((e) => e.id === platform.emulator);
  const needs = emulator?.bios.filter((b) => !b.platform || b.platform === platform.id) ?? [];
  const biosFile = bios.find((f) => needs.some((n) => new RegExp(n.match, "i").test(f.name)));
  const config = {
    gameId: game.id,
    savePath: sharedSavePath(platform, fileName),
    data: emulatorJsData(),
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${game.title.replace(/[<&]/g, " ")}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#game{width:100%;height:100%}#sync{position:fixed;right:8px;bottom:8px;font:12px system-ui;color:#ccc;background:#0008;padding:2px 8px;border-radius:6px;pointer-events:none}</style>
</head>
<body>
<div id="game"></div>
<div id="sync"></div>
<script>
window.EJS_player = "#game";
window.EJS_core = ${js(platform.browserCore)};
window.EJS_gameName = ${js(game.title)};
window.EJS_gameUrl = ${js(`/api/games/${game.id}/files/${rom.index}/${encodeURIComponent(fileName)}`)};
window.EJS_pathtodata = ${js(config.data)};
window.EJS_startOnLoaded = true;
window.EJS_color = ${js(platform.color)};
${biosFile ? `window.EJS_biosUrl = ${js(`/api/emulation/bios/${encodeURIComponent(biosFile.name)}`)};` : ""}
window.LOOTDEN = ${js(config)};
</script>
<script>${SYNC_SCRIPT}</script>
<script src="${config.data.replace(/"/g, "")}loader.js"></script>
</body>
</html>`;
}

/**
 * Save sync for the browser. Plain script (no build step): a tiny zip reader and writer,
 * then hooks into EmulatorJS's file system for the battery save or memory card.
 */
const SYNC_SCRIPT = String.raw`
(function () {
  var cfg = window.LOOTDEN;
  var status = document.getElementById("sync");
  var say = function (t) { status.textContent = t; if (t) setTimeout(function () { if (status.textContent === t) status.textContent = ""; }, 4000); };
  var KEY = "lootden-save-" + cfg.gameId;
  if (!cfg.savePath) return;

  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(d) { var c = 0xffffffff; for (var i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

  // A one-file zip, stored without compression (saves are small).
  function zipOne(name, data) {
    var n = new TextEncoder().encode(name), crc = crc32(data), size = data.length;
    var local = new DataView(new ArrayBuffer(30)), central = new DataView(new ArrayBuffer(46)), end = new DataView(new ArrayBuffer(22));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint32(14, crc, true); local.setUint32(18, size, true); local.setUint32(22, size, true); local.setUint16(26, n.length, true);
    central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint32(16, crc, true); central.setUint32(20, size, true); central.setUint32(24, size, true); central.setUint16(28, n.length, true);
    var cdOffset = 30 + n.length + size;
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true); end.setUint32(12, 46 + n.length, true); end.setUint32(16, cdOffset, true);
    return new Blob([local.buffer, n, data, central.buffer, n, end.buffer]);
  }

  // Reads one file out of a zip (stored or deflated, as 7-Zip writes them).
  async function unzipOne(buf, want) {
    var v = new DataView(buf), eocd = -1;
    for (var i = buf.byteLength - 22; i >= 0; i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    var count = v.getUint16(eocd + 10, true), p = v.getUint32(eocd + 16, true);
    for (var e = 0; e < count; e++) {
      var method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
      var name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nlen)).replace(/\\/g, "/");
      p += 46 + nlen + xlen + clen;
      if (name.toLowerCase() !== want.toLowerCase()) continue;
      var start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
      var raw = new Uint8Array(buf, start, csize);
      if (method === 0) return raw.slice();
      if (method !== 8) return null;
      var out = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(out).arrayBuffer());
    }
    return null;
  }

  function gm() { return window.EJS_emulator && window.EJS_emulator.gameManager; }
  function savePathInEmulator() { var g = gm(); return g && g.getSaveFilePath ? g.getSaveFilePath() : null; }
  function readSave() {
    var g = gm(), p = savePathInEmulator();
    if (!g || !p) return null;
    try { if (g.saveSaveFiles) g.saveSaveFiles(); return g.FS.analyzePath(p).exists ? g.FS.readFile(p) : null; } catch (e) { return null; }
  }
  var lastCrc = null;

  // Start from the newest backup unless this browser made it or already applied it.
  async function restore() {
    try {
      var list = await (await fetch("/api/games/" + cfg.gameId + "/saves", { credentials: "same-origin" })).json();
      // Recomps keep their own saves; only the emulator's carry over.
      var latest = list && list.filter(function (b) { return !b.runner; })[0];
      if (!latest || String(latest.id) === localStorage.getItem(KEY)) return;
      var buf = await (await fetch("/api/games/" + cfg.gameId + "/saves/" + latest.id, { credentials: "same-origin" })).arrayBuffer();
      var data = await unzipOne(buf, cfg.savePath);
      var g = gm(), p = savePathInEmulator();
      if (!data || !g || !p) return;
      var dir = p.slice(0, p.lastIndexOf("/"));
      try { g.FS.mkdirTree ? g.FS.mkdirTree(dir) : g.FS.mkdir(dir); } catch (e) {}
      g.FS.writeFile(p, data);
      if (g.loadSaveFiles) g.loadSaveFiles();
      lastCrc = crc32(data);
      localStorage.setItem(KEY, String(latest.id));
      say("Loaded your save from " + (latest.device || "another device"));
    } catch (e) { say("Couldn't load your save: " + e.message); }
  }

  async function upload(keepalive) {
    var data = readSave();
    if (!data || !data.length) return;
    var c = crc32(data);
    if (c === lastCrc) return;
    lastCrc = c;
    try {
      var res = await fetch("/api/games/" + cfg.gameId + "/saves?device=Browser", { method: "POST", credentials: "same-origin", keepalive: !!keepalive, headers: { "Content-Type": "application/octet-stream" }, body: zipOne(cfg.savePath, data) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var b = await res.json();
      localStorage.setItem(KEY, String(b.id));
      say("Saved to your profile");
    } catch (e) { lastCrc = null; say("Save upload failed: " + e.message); }
  }

  window.EJS_onGameStart = function () {
    restore().then(function () { if (lastCrc === null) { var d = readSave(); if (d) lastCrc = crc32(d); } });
    setInterval(function () { upload(false); }, 30000);
  };
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") upload(true); });
  window.addEventListener("pagehide", function () { upload(true); });
  window.addEventListener("message", function (e) { if (e.origin === location.origin && e.data === "lootden:save") upload(false); });
})();
`;
