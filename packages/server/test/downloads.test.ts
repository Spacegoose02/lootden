import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { mapPath } from "../src/connectors/manager.js";
import { findServerSevenZip } from "../src/connectors/tidy.js";
import { magnetHash, torrentInfoHash } from "../src/connectors/torrent.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
let downloads: string;
before(async () => {
  root = await makeLibrary();
  downloads = await mkdtemp(path.join(os.tmpdir(), "gm-dl-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(downloads, { recursive: true, force: true });
});

/** Fake qBittorrent, SABnzbd and Prowlarr behind one fetch. */
let qbDropsEverything = false;
const MAGNET_B = "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=Cool+Game";
const TORRENT = new TextEncoder().encode("d8:announce3:url4:infod6:lengthi10e4:name4:Cool12:piece lengthi16384e6:pieces0:ee");
function fakeServices() {
  const torrents: Array<Record<string, unknown>> = [];
  const sabQueue: Array<Record<string, unknown>> = [];
  const sabHistory: Array<Record<string, unknown>> = [];
  const added: string[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const form: { get(k: string): unknown } =
      init.body instanceof FormData ? init.body : init.body instanceof URLSearchParams ? init.body : new URLSearchParams(typeof init.body === "string" ? init.body : "");
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.host === "qbit:8080") {
      if (url.pathname === "/api/v2/auth/login") {
        return form.get("password") === "adminpass" ? new Response("Ok.", { headers: { "set-cookie": "SID=abc; HttpOnly; path=/" } }) : new Response("Fails.");
      }
      if ((init.headers as Record<string, string>)?.Cookie !== "SID=abc") return new Response("Forbidden", { status: 403 });
      if (url.pathname === "/api/v2/app/version") return new Response("v5.1.0");
      if (url.pathname === "/api/v2/torrents/createCategory") return new Response("");
      if (url.pathname === "/api/v2/torrents/add") {
        const urls = form.get("urls") as string | null;
        const file = form.get("torrents") as Blob | null;
        added.push(`qbit:${urls ?? `file:${(file as File | null)?.name}`}|${form.get("category")}|${form.get("tags")}`);
        // Like the real thing: "Ok." for any link, but an http(s) link it can't fetch is dropped quietly.
        const hash = urls?.match(/btih:([a-f0-9]{40})/)?.[1] ?? (file ? torrentInfoHash(new Uint8Array(await file.arrayBuffer())) : null);
        if (hash && !qbDropsEverything) {
          torrents.push({ hash, name: "Cool Game", size: 100, progress: 0.4, dlspeed: 5000, eta: 60, state: "downloading", category: form.get("category"), tags: form.get("tags"), content_path: "/data/torrents/games/Cool Game" });
        }
        return new Response("Ok.");
      }
      if (url.pathname === "/api/v2/torrents/info") {
        const hashes = url.searchParams.get("hashes");
        return json(hashes ? torrents.filter((t) => hashes.split("|").includes(String(t.hash))) : torrents);
      }
      if (url.pathname === "/api/v2/torrents/stop") {
        torrents[0]!.state = "stoppedDL";
        return new Response("");
      }
      return new Response("not found", { status: 404 });
    }
    if (url.host === "sab:8080") {
      if (url.searchParams.get("apikey") !== "sabkey") return json({ error: "API Key Incorrect" });
      const mode = url.searchParams.get("mode");
      if (mode === "version") return json({ version: "4.4.0" });
      if (mode === "addurl") {
        added.push(`sab:${url.searchParams.get("name")}|${url.searchParams.get("cat")}`);
        sabQueue.push({ nzo_id: "SABnzbd_nzo_1", filename: "Usenet Game", mb: "200", mbleft: "100", percentage: "50", status: "Downloading", timeleft: "0:01:40", cat: "games" });
        return json({ status: true, nzo_ids: ["SABnzbd_nzo_1"] });
      }
      if (mode === "queue") return json({ queue: { slots: sabQueue, kbpersec: "1024" } });
      if (mode === "history") return json({ history: { slots: sabHistory } });
    }
    // Prowlarr's own download links: a redirect to a magnet, a .torrent file, or a login page.
    if (url.host === "prowlarr:9696" && url.pathname === "/2/download") {
      const kind = url.searchParams.get("kind");
      if (kind === "magnet") return new Response(null, { status: 302, headers: { location: MAGNET_B } });
      if (kind === "file") return new Response(TORRENT, { headers: { "content-disposition": 'attachment; filename="Cool Game.torrent"' } });
      return new Response("<!DOCTYPE html><html>Please log in</html>", { headers: { "content-type": "text/html" } });
    }
    if (url.host === "prowlarr:9696") {
      if ((init.headers as Record<string, string>)?.["X-Api-Key"] !== "pkey") return json({}, 401);
      if (url.pathname === "/api/v1/system/status") return json({ version: "1.30.0" });
      if (url.pathname === "/api/v1/search") {
        assert.deepEqual(url.searchParams.getAll("categories"), ["4000"]);
        return json([
          { guid: "a", title: "Cool Game-GOG", size: 100, indexer: "Some Tracker", protocol: "torrent", magnetUrl: "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", seeders: 3 },
          { guid: "b", title: "Cool Game NZB", size: 120, indexer: "Some Indexer", protocol: "usenet", downloadUrl: "http://prowlarr:9696/1/download?apikey=x" },
          { guid: "c", title: "Popular Copy", size: 100, indexer: "Other", protocol: "torrent", magnetUrl: "magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd", seeders: 99 },
        ]);
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, torrents, sabQueue, sabHistory, added };
}

const SETTINGS = {
  qbittorrent: { url: "http://qbit:8080/", username: "admin", password: "adminpass", category: "games", savePath: "" },
  sabnzbd: { url: "http://sab:8080", apiKey: "sabkey", category: "games" },
  prowlarr: { url: "http://prowlarr:9696", apiKey: "pkey", categories: [4000] },
  import: { mode: "copy", pathMappings: [] as Array<{ from: string; to: string }> },
};

describe("download connectors", () => {
  it("maps client paths into this container", () => {
    const m = [
      { from: "/data", to: "/mnt/a" },
      { from: "/data/torrents", to: "/downloads" },
    ];
    assert.equal(mapPath("/data/torrents/games/X", m), "/downloads/games/X");
    assert.equal(mapPath("/data/usenet/X", m), "/mnt/a/usenet/X");
    assert.equal(mapPath("/elsewhere/X", m), "/elsewhere/X");
    assert.equal(mapPath("D:\\Downloads\\X", [{ from: "D:/Downloads", to: "/dl" }]), "/dl/X");
  });

  it("saves settings with secrets masked and tests each service", async () => {
    const fake = fakeServices();
    const { app } = await makeApp(root, { apiToken: "svc" }, { fetchImpl: fake.impl });
    const headers = { authorization: "Bearer svc" };
    const saved = (await app.inject({ method: "PUT", url: "/api/connectors", headers, payload: SETTINGS })).json();
    assert.equal(saved.qbittorrent.password, "********");
    assert.equal(saved.qbittorrent.url, "http://qbit:8080");
    // Sending the mask back keeps the real secret.
    await app.inject({ method: "PUT", url: "/api/connectors", headers, payload: { qbittorrent: { ...saved.qbittorrent } } });
    for (const [name, expected] of [["qbittorrent", "qBittorrent v5.1.0"], ["sabnzbd", "SABnzbd 4.4.0"], ["prowlarr", "Prowlarr 1.30.0"]]) {
      const r = await app.inject({ method: "POST", url: `/api/connectors/${name}/test`, headers });
      assert.equal(r.json().message, expected, `${name} test`);
    }
    await app.close();
  });

  it("searches Prowlarr, sends torrents to qBittorrent and copies finished ones into the library", async () => {
    const fake = fakeServices();
    const { app, ctx } = await makeApp(root, { apiToken: "svc" }, { fetchImpl: fake.impl });
    const headers = { authorization: "Bearer svc" };
    const src = path.join(downloads, "torrents", "games", "Cool Game");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "cool.exe"), "game");
    await app.inject({
      method: "PUT",
      url: "/api/connectors",
      headers,
      payload: { ...SETTINGS, import: { mode: "copy", pathMappings: [{ from: "/data/torrents", to: path.join(downloads, "torrents") }] } },
    });

    const results = (await app.inject({ url: "/api/downloads/search?q=cool%20game", headers })).json();
    assert.deepEqual(results.map((r: { guid: string }) => r.guid), ["c", "a", "b"], "most seeders first");
    const grab = await app.inject({ method: "POST", url: "/api/downloads", headers, payload: { url: results[1].downloadUrl, title: results[1].title, protocol: "torrent" } });
    assert.equal(grab.statusCode, 200);
    assert.deepEqual(fake.added, ["qbit:magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|games|gm-1"]);
    assert.equal(results.find((r: { best: boolean }) => r.best).guid, "c", "the rules pick the best allowed release");

    let list = (await app.inject({ url: "/api/downloads", headers })).json();
    assert.equal(list.downloads[0].live.progress, 0.4);
    assert.equal(list.downloads[0].live.state, "downloading");

    assert.equal((await app.inject({ method: "POST", url: `/api/downloads/${list.downloads[0].id}`, headers, payload: { action: "pause" } })).statusCode, 200);
    assert.equal(fake.torrents[0]!.state, "stoppedDL");

    Object.assign(fake.torrents[0]!, { progress: 1, state: "stalledUP" });
    await ctx.downloads.reconcile();
    list = (await app.inject({ url: "/api/downloads", headers })).json();
    assert.equal(list.downloads[0].status, "imported");
    assert.ok(ctx.library.list({ search: "cool" }).length === 1, "game appears in the library");
    assert.ok(await stat(path.join(src, "cool.exe")), "copy mode leaves the seeding files in place");
    await app.close();
  });

  it("doesn't import a download twice, and shows one already moved into the library as imported", async () => {
    const fake = fakeServices();
    const { app, ctx } = await makeApp(root, { apiToken: "svc" }, { fetchImpl: fake.impl });
    const headers = { authorization: "Bearer svc" };
    const folder = path.join(downloads, "moved", "games");
    for (const name of ["Moved Game", "Folder Game"]) {
      await mkdir(path.join(folder, name), { recursive: true });
      await writeFile(path.join(folder, name, `${name}.exe`), "game");
    }
    const old = new Date(Date.now() - 3600_000);
    const { utimes } = await import("node:fs/promises");
    for (const name of ["Moved Game", "Folder Game"]) {
      await utimes(path.join(folder, name, `${name}.exe`), old, old);
      await utimes(path.join(folder, name), old, old);
    }
    await app.inject({
      method: "PUT",
      url: "/api/connectors",
      headers,
      payload: { ...SETTINGS, import: { mode: "move", folder, autoImportFolder: true, pathMappings: [{ from: "/data/torrents/games", to: folder }] } },
    });
    const results = (await app.inject({ url: "/api/downloads/search?q=cool%20game", headers })).json();
    await app.inject({ method: "POST", url: "/api/downloads", headers, payload: { url: results[1].downloadUrl, title: "Moved Game", protocol: "torrent" } });
    Object.assign(fake.torrents[0]!, { name: "Moved Game", content_path: "/data/torrents/games/Moved Game", progress: 1, state: "stalledUP" });

    // Before 0.9.1 the folder import moved it first, and the download then said "not found" forever.
    await ctx.downloads.reconcile();
    let list = (await app.inject({ url: "/api/downloads", headers })).json();
    assert.equal(list.downloads[0].status, "imported");
    assert.equal(list.downloads[0].error, null);
    // The folder import took only the game that wasn't ours; both are in the library once.
    const imports = ctx.db.prepare("SELECT name, status FROM folder_imports ORDER BY name").all() as Array<{ name: string; status: string }>;
    assert.deepEqual(imports.map((i) => `${i.name}:${i.status}`), ["Folder Game:imported", "Moved Game:imported"]);
    await ctx.library.rescan();
    assert.equal(ctx.library.list({ search: "moved game" }).length, 1);
    assert.equal(ctx.library.list({ search: "folder game" }).length, 1);

    // A download whose files were already moved by a folder import is imported, not failed.
    const db = ctx.db;
    db.prepare("UPDATE downloads SET status = 'downloading', error = 'Finished download not found' WHERE id = ?").run(list.downloads[0].id);
    db.prepare("INSERT INTO folder_imports (name, status, target, error, at) VALUES ('Moved Game', 'imported', '/games/Moved Game', NULL, '2026-01-01') ON CONFLICT(name) DO UPDATE SET status = 'imported', target = excluded.target").run();
    Object.assign(fake.torrents[0]!, { state: "missingFiles" });
    await ctx.downloads.reconcile();
    list = (await app.inject({ url: "/api/downloads", headers })).json();
    assert.deepEqual([list.downloads[0].status, list.downloads[0].error, list.downloads[0].importedPath], ["imported", null, "/games/Moved Game"]);
    await app.close();
  });

  it("hands qBittorrent a magnet or torrent file it can use, and says so when it drops one", async () => {
    process.env.GM_TORRENT_VERIFY_MS = "5";
    const fake = fakeServices();
    const { app } = await makeApp(root, { apiToken: "svc" }, { fetchImpl: fake.impl });
    const headers = { authorization: "Bearer svc" };
    await app.inject({ method: "PUT", url: "/api/connectors", headers, payload: SETTINGS });
    const grab = (kind: string) =>
      app.inject({ method: "POST", url: "/api/downloads", headers, payload: { url: `http://prowlarr:9696/2/download?kind=${kind}&apikey=x`, title: `Cool Game (${kind})`, protocol: "torrent" } });

    // Before: the Prowlarr link went to qBittorrent as is, which said "Ok." and dropped it.
    const viaMagnet = await grab("magnet");
    assert.equal(viaMagnet.statusCode, 200, viaMagnet.body);
    assert.equal(fake.added.at(-1), `qbit:${MAGNET_B}|games|gm-${viaMagnet.json().id}`);
    assert.equal(magnetHash(MAGNET_B), "b".repeat(40));
    const viaFile = await grab("file");
    assert.equal(viaFile.statusCode, 200, viaFile.body);
    assert.equal(fake.added.at(-1), `qbit:file:Cool Game.torrent|games|gm-${viaFile.json().id}`);
    const list = (await app.inject({ url: "/api/downloads", headers })).json();
    assert.equal(list.downloads.filter((d: { live: unknown }) => d.live).length, 2, "both show live progress");

    const page = await grab("html");
    assert.equal(page.statusCode, 400);
    assert.match(page.json().error, /web page instead of a torrent/);

    qbDropsEverything = true;
    const dropped = await app.inject({ method: "POST", url: "/api/downloads", headers, payload: { url: "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc", title: "Dropped", protocol: "torrent" } });
    qbDropsEverything = false;
    assert.equal(dropped.statusCode, 400);
    assert.match(dropped.json().error, /never added the torrent/);
    const after = (await app.inject({ url: "/api/downloads", headers })).json();
    assert.equal(after.downloads.find((d: { name: string }) => d.name === "Dropped").status, "failed", "the failure stays visible in the queue");
    await app.close();
  });

  it("sends usenet results to SABnzbd, then unpacks, cleans and re-zips the finished download", async () => {
    const fake = fakeServices();
    const { app, ctx } = await makeApp(root, { apiToken: "svc" }, { fetchImpl: fake.impl });
    const headers = { authorization: "Bearer svc" };
    const sevenZip = (await findServerSevenZip())!;
    const src = path.join(downloads, "complete", "Usenet.Game.v1.2-GROUP");
    const inner = path.join(downloads, "inner", "Usenet Game");
    await mkdir(path.join(inner, "bin"), { recursive: true });
    await writeFile(path.join(inner, "bin", "game.exe"), "exe");
    await writeFile(path.join(inner, "Visit SITE-GAMES.COM.url"), "[InternetShortcut]");
    await mkdir(src, { recursive: true });
    execFileSync(sevenZip.path, ["a", "-t7z", path.join(src, "data.7z"), inner], { stdio: "ignore" });
    await writeFile(path.join(src, "Read Me.txt"), "thanks for downloading");
    await writeFile(path.join(src, "release.nfo"), "nfo");
    await mkdir(path.join(src, "_INSTALL TUTORIAL"));
    await writeFile(path.join(src, "_INSTALL TUTORIAL", "step1.png"), "png");
    await app.inject({ method: "PUT", url: "/api/connectors", headers, payload: { ...SETTINGS, import: { mode: "move", pathMappings: [] } } });

    const grab = await app.inject({ method: "POST", url: "/api/downloads", headers, payload: { url: "http://prowlarr:9696/1/download?apikey=x", title: "Usenet.Game.v1.2-GROUP", protocol: "usenet" } });
    assert.equal(grab.json().externalId, "SABnzbd_nzo_1");
    fake.sabQueue.length = 0;
    fake.sabHistory.push({ nzo_id: "SABnzbd_nzo_1", name: "Usenet.Game.v1.2-GROUP", bytes: 200, status: "Completed", storage: src, category: "games" });
    await ctx.downloads.reconcile();
    const record = ctx.downloads.get(1)!;
    assert.equal(record.status, "imported", record.error ?? "");
    assert.equal(path.basename(record.importedPath!), "Usenet Game v1.2.zip");
    const listing = execFileSync(sevenZip.path, ["l", "-ba", "-slt", record.importedPath!]).toString();
    const names = [...listing.matchAll(/^Path = (.*)$/gm)].map((m) => m[1]!.replace(/\\/g, "/")).sort();
    assert.deepEqual(names, ["bin", "bin/game.exe"], "junk is gone and the wrapper folder is unwrapped");
    assert.ok(ctx.library.list({ search: "usenet" }).length === 1);
    assert.deepEqual((await readdir(root)).filter((n) => n.startsWith(".import")), [], "no staging folder left behind");
    await assert.rejects(stat(src), "move mode removes the source");
    await app.close();
  });

  it("is admin only and rejects odd URLs", async () => {
    const { app, ctx } = await makeApp(root, { apiToken: "svc" });
    const u = await ctx.users.create({ username: "plain", password: "password1" });
    const token = ctx.auth.createApiToken(u.id, "t").token;
    assert.equal((await app.inject({ url: "/api/downloads", headers: { authorization: `Bearer ${token}` } })).statusCode, 403);
    const bad = await app.inject({ method: "POST", url: "/api/downloads", headers: { authorization: "Bearer svc" }, payload: { url: "file:///etc/passwd", title: "x", protocol: "torrent" } });
    assert.equal(bad.statusCode, 400);
    await app.close();
  });
});

describe("links sent from the desktop app's browser", () => {
  it("sends magnets to the torrent client and file links to the Download Manager", async () => {
    const fake = fakeServices();
    const { app, ctx } = await makeApp(root, { apiToken: "svc" }, { fetchImpl: fake.impl });
    const headers = { authorization: "Bearer svc" };
    await app.inject({ method: "PUT", url: "/api/connectors", headers, payload: SETTINGS });
    const send = (payload: object, h: Record<string, string> = headers) => app.inject({ method: "POST", url: "/api/downloads/link", headers: h, payload });

    const magnet = await send({ url: MAGNET_B });
    assert.equal(magnet.statusCode, 200);
    assert.deepEqual(magnet.json(), { kind: "torrent", title: "Cool Game", to: "the torrent client" });
    assert.ok(fake.added.some((a) => a.startsWith(`qbit:${MAGNET_B}|`)), "the magnet went to qBittorrent");

    const nzb = await send({ url: "https://indexer.example/get/123.nzb?apikey=x" });
    assert.equal(nzb.json().to, "SABnzbd");

    const file = await send({ url: "https://pixeldrain.com/u/abc123" });
    assert.equal(file.statusCode, 200);
    assert.equal(file.json().to, "the Download Manager");
    assert.equal(ctx.direct.list()[0]!.files[0]!.url, "https://pixeldrain.com/u/abc123");

    assert.equal((await send({ url: "ftp://example.com/game.zip" })).statusCode, 400);
    assert.equal((await send({ url: "magnet:?dn=no-hash" })).statusCode, 400);

    const kid = await ctx.users.create({ username: "linkkid", password: "password1", kidMode: true });
    const asKid = { authorization: `Bearer ${ctx.auth.createApiToken(kid.id, "t").token}` };
    assert.equal((await send({ url: MAGNET_B }, asKid)).statusCode, 403, "only admins send downloads");
    await app.close();
  });
});

describe("download tidy rules", () => {
  it("spots release junk but keeps game files", async () => {
    const { isJunk, tidyName, releaseVersion } = await import("../src/connectors/tidy.js");
    for (const junk of ["XXX-GAMES.COM.url", "Read Me.txt", "README.html", "_INSTALL TUTORIAL", "FUCKINGTORRENTS.COM.txt", "release.nfo", "game.sfv", "Thumbs.db", "Visit us.website"]) {
      assert.ok(isJunk(junk, 0), junk);
    }
    for (const keep of ["game.bin", "setup.exe", "README", "data", "game.exe", "Engine.ini"]) assert.ok(!isJunk(keep, 0), keep);
    assert.ok(!isJunk("readme.txt", 3), "a readme deep inside the game stays");
    assert.equal(tidyName("The.Witcher.3.Wild.Hunt.v4.04-GOG"), "The Witcher 3 Wild Hunt v4.04");
    assert.equal(tidyName("Hades_Build_123456.zip"), "Hades Build 123456");
    assert.equal(tidyName("Celeste [FitGirl Repack]"), "Celeste");
    assert.equal(releaseVersion("Game v1_2_3"), "1.2.3");
  });

  it("keeps a download as a folder when an archive in it couldn't be unpacked, rather than zipping the archive up", async () => {
    const { tidyDownload } = await import("../src/connectors/tidy.js");
    const tmp = await mkdtemp(path.join(os.tmpdir(), "lootden-tidy-"));
    try {
      const staging = path.join(tmp, ".import-1");
      const games = path.join(tmp, "games");
      await mkdir(staging, { recursive: true });
      await mkdir(games);
      await writeFile(path.join(staging, "Update.Game.v1.0.to.v1.1.rar"), "Rar!\x1a\x07\x01\x00rar bytes");
      const sevenZip = await findServerSevenZip();
      // A 7-Zip without the RAR decoder, as some Linux packages ship it.
      const report = await tidyDownload(staging, "Update.Game.v1.0.to.v1.1.rar", games, { stripJunk: true, extract: true, repack: "zip" }, sevenZip && { ...sevenZip, rar: false });
      assert.ok(!report.target.endsWith(".zip"), report.target);
      assert.equal(await readFile(path.join(report.target, "Update.Game.v1.0.to.v1.1.rar"), "utf8"), "Rar!\x1a\x07\x01\x00rar bytes");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("installs an Inno Setup installer on the server, and keeps any other installer for a PC", async () => {
    const { tidyDownload } = await import("../src/connectors/tidy.js");
    const tmp = await mkdtemp(path.join(os.tmpdir(), "lootden-inno-"));
    try {
      const games = path.join(tmp, "games");
      await mkdir(games);
      // Stands in for innoextract: unpacks {app} and {tmp} like a GOG installer, or fails like a non-Inno one.
      const fake = path.join(tmp, "innoextract");
      await writeFile(
        fake,
        `#!/bin/sh
for a in "$@"; do [ "$prev" = "--output-dir" ] && out="$a"; prev="$a"; setup="$a"; done
case "$setup" in *nsis*) echo "Not a supported Inno Setup installer" >&2; exit 1;; esac
mkdir -p "$out/app/bin" "$out/tmp" && echo game > "$out/app/bin/Game.exe" && echo helper > "$out/tmp/isxdl.dll"
`,
        { mode: 0o755 },
      );
      const stage = async (n: number, setup: string) => {
        const staging = path.join(tmp, `.import-${n}`);
        await mkdir(path.join(staging, "Game"), { recursive: true });
        await writeFile(path.join(staging, "Game", setup), "MZ");
        await writeFile(path.join(staging, "Game", setup.replace(".exe", "-1.bin")), "data");
        return staging;
      };
      const opts = { stripJunk: true, extract: true, repack: "folder" as const };

      const inno = await stage(3, "setup_game_1.2_(1234).exe");
      const report = await tidyDownload(inno, "Game.v1.2-GOG", games, opts, null, () => {}, fake);
      assert.equal(path.basename(report.target), "Game v1.2");
      assert.deepEqual(await readdir(report.target, { recursive: true }), ["bin", path.join("bin", "Game.exe")]);
      assert.deepEqual((await readdir(tmp)).sort(), ["games", "innoextract"], "the work folders are gone");

      const nsis = await stage(4, "setup_nsis.exe");
      const kept = await tidyDownload(nsis, "Other.v2", games, opts, null, () => {}, fake);
      assert.ok((await readdir(kept.target)).includes("setup_nsis.exe"));
      assert.match(kept.warnings.join(" "), /only Inno Setup/);

      const off = await stage(5, "setup_game_1.2_(1234).exe");
      const skipped = await tidyDownload(off, "Third.v3", games, { ...opts, installers: false }, null, () => {}, fake);
      assert.ok((await readdir(skipped.target)).includes("setup_game_1.2_(1234).exe"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to import an empty or fake archive", async () => {
    const { tidyDownload } = await import("../src/connectors/tidy.js");
    const tmp = await mkdtemp(path.join(os.tmpdir(), "lootden-tidy-"));
    try {
      const games = path.join(tmp, "games");
      await mkdir(games);
      const sevenZip = await findServerSevenZip();
      for (const [file, body, error] of [
        ["EA SPORTS College Football 27_1.0.141.rar", "", /is empty \(0 bytes\)/],
        ["Game.part1.rar", "<html>File not found</html>", /isn't a RAR archive/],
        ["Game.7z", "not a 7z", /couldn't be unpacked|isn't a 7z archive/],
      ] as const) {
        const staging = path.join(tmp, ".import-2");
        await rm(staging, { recursive: true, force: true });
        await mkdir(staging, { recursive: true });
        await writeFile(path.join(staging, file), body);
        await assert.rejects(tidyDownload(staging, file, games, { stripJunk: true, extract: true, repack: "zip" }, sevenZip), error, file);
      }
      assert.deepEqual(await readdir(games), [], "nothing reached the games folder");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
