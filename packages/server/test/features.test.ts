import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { DelugeClient } from "../src/connectors/deluge.js";
import { judgeRelease } from "../src/connectors/rules.js";
import { parseClamOutput } from "../src/connectors/scan.js";
import { DEFAULT_RULES, loadConnectorSettings, maskedConnectorSettings, saveConnectorSettings } from "../src/connectors/settings.js";
import { TransmissionClient } from "../src/connectors/transmission.js";
import type { SearchResult } from "../src/connectors/prowlarr.js";
import { NexusMods } from "../src/news/nexus.js";
import { isReleased } from "../src/news/wanted.js";
import { compareVersions, versionIn } from "../src/news/version-check.js";
import { makeApp, makeLibrary } from "./helpers.js";

process.env.GM_TORRENT_VERIFY_MS = "5";
process.env.GM_WANTED_DELAY_MS = "1";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

const release = (title: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  guid: title,
  title,
  sizeBytes: 5_000_000_000,
  indexer: "Good",
  protocol: "torrent",
  downloadUrl: `http://prowlarr/${encodeURIComponent(title)}`,
  infoUrl: null,
  seeders: 10,
  leechers: 0,
  publishedAt: null,
  ...extra,
});

const MAGNET = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=x";

describe("wanted list, rules, alerts, scans, updates, journal and stats", () => {
  it("judges releases by the rules and the wanted title", () => {
    const rules = { ...DEFAULT_RULES, preferred: ["GOG"], maxSizeMb: 10_000 };
    assert.equal(judgeRelease(release("Hades OST"), rules).allowed, false);
    assert.match(judgeRelease(release("Hades OST"), rules).reason!, /ost/i);
    assert.equal(judgeRelease(release("Hades", { sizeBytes: 50e9 }), rules).allowed, false);
    assert.equal(judgeRelease(release("Hades", { seeders: 0 }), rules).allowed, false);
    assert.equal(judgeRelease(release("Hades", { indexer: "Bad" }), { ...rules, blockedIndexers: ["bad"] }).allowed, false);
    assert.equal(judgeRelease(release("Hades II v1.0"), rules, "Hades").allowed, false, "a different game with a similar name");
    const gog = judgeRelease(release("Hades v1.38 GOG"), rules, "Hades");
    const plain = judgeRelease(release("Hades v1.38"), rules, "Hades");
    assert.ok(gog.allowed && plain.allowed && gog.score > plain.score);
  });

  it("masks every secret and keeps it when the mask comes back", async () => {
    const { ctx } = await makeApp(root);
    saveConnectorSettings(ctx.db, { nexus: { apiKey: "nx" }, scan: { ...loadConnectorSettings(ctx.db).scan, virusTotalKey: "vt" }, deluge: { url: "http://d:8112", password: "pw", category: "games", savePath: "" } });
    const masked = maskedConnectorSettings(loadConnectorSettings(ctx.db));
    assert.equal(masked.nexus.apiKey, "********");
    assert.equal(masked.scan.virusTotalKey, "********");
    assert.equal(masked.deluge.password, "********");
    saveConnectorSettings(ctx.db, masked);
    const s = loadConnectorSettings(ctx.db);
    assert.deepEqual([s.nexus.apiKey, s.scan.virusTotalKey, s.deluge.password], ["nx", "vt", "pw"]);
    assert.throws(() => saveConnectorSettings(ctx.db, { transmission: { ...s.transmission, url: "tower:9091" } }), /http/);
  });

  it("records alerts and sends the switched-on kinds through Apprise", async () => {
    const sent: Array<{ url: string; body: Record<string, string> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, { apiToken: "svc", publicUrl: "https://games.example" }, { fetchImpl });
    const headers = { authorization: "Bearer svc" };
    saveConnectorSettings(ctx.db, { notify: { ...loadConnectorSettings(ctx.db).notify, appriseUrl: "http://apprise:8000", appriseTargets: "ntfys://lootden", grabbed: false } });
    await ctx.notifier.send("released", "Hades is out", "Released 2026-10-01", "/wishlist");
    await ctx.notifier.send("grabbed", "Sent Hades", null, "/downloads");
    assert.equal(sent.length, 1, "grabbed is switched off");
    assert.equal(sent[0]!.url, "http://apprise:8000/notify");
    assert.equal(sent[0]!.body.urls, "ntfys://lootden");
    assert.equal(sent[0]!.body.title, "LootDen: Hades is out");
    assert.match(sent[0]!.body.body, /https:\/\/games\.example\/wishlist/);
    const list = (await app.inject({ url: "/api/alerts", headers })).json();
    assert.equal(list.unread, 2);
    assert.equal(list.alerts[0].title, "Sent Hades");
    await app.inject({ method: "POST", url: "/api/alerts/read", headers });
    assert.equal((await app.inject({ url: "/api/alerts", headers })).json().unread, 0);
    const test = await app.inject({ method: "POST", url: "/api/alerts/test", headers });
    assert.equal(test.statusCode, 200, test.body);
  });

  it("searches monitored wishlist games, announces finds and grabs the best one", async () => {
    const added: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "prowlarr" && url.pathname === "/api/v1/search") {
        return Response.json([
          { guid: "a", title: "Celeste OST", size: 1e8, indexer: "Idx", protocol: "torrent", downloadUrl: "http://prowlarr/dl/a", seeders: 50 },
          { guid: "b", title: "Celeste v1.4", size: 1e9, indexer: "Idx", protocol: "torrent", downloadUrl: "http://prowlarr/dl/b", seeders: 20 },
        ]);
      }
      if (url.hostname === "prowlarr" && url.pathname === "/dl/b") return new Response(null, { status: 302, headers: { location: MAGNET } });
      if (url.hostname === "tr") {
        const body = JSON.parse(String(init?.body)) as { method: string; arguments: Record<string, unknown> };
        if (body.method === "torrent-add") {
          added.push(String(body.arguments.filename));
          return Response.json({ result: "success", arguments: { "torrent-added": { hashString: "0123456789ABCDEF0123456789ABCDEF01234567" } } });
        }
        if (body.method === "torrent-get") return Response.json({ result: "success", arguments: { torrents: [{ hashString: "0123456789abcdef0123456789abcdef01234567", name: "Celeste", totalSize: 1, percentDone: 0, rateDownload: 0, eta: -1, status: 4, error: 0, downloadDir: "/dl", labels: ["games"] }] } });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, { apiToken: "svc" }, { fetchImpl });
    const headers = { authorization: "Bearer svc" };
    saveConnectorSettings(ctx.db, {
      prowlarr: { url: "http://prowlarr", apiKey: "k", categories: [4050] },
      transmission: { url: "http://tr:9091", username: "", password: "", category: "games", savePath: "" },
      torrentClient: "transmission",
    });
    const w = (await app.inject({ method: "POST", url: "/api/wishlist", headers, payload: { title: "Celeste" } })).json().items[0];
    assert.equal(w.monitored, true);

    const searched = (await app.inject({ method: "POST", url: `/api/wishlist/${w.id}/search`, headers })).json();
    assert.equal(searched.found.title, "Celeste v1.4", "the soundtrack is ruled out");
    assert.equal(ctx.notifier.list().alerts[0]!.kind, "found");

    const grabbed = await app.inject({ method: "POST", url: `/api/wishlist/${w.id}/grab`, headers });
    assert.equal(grabbed.statusCode, 200, grabbed.body);
    assert.deepEqual(added, [MAGNET]);
    assert.ok(grabbed.json().items[0].downloadId);
    assert.equal(ctx.notifier.list().alerts[0]!.kind, "grabbed");

    // Unwatched games are skipped by the scheduled pass.
    const other = (await app.inject({ method: "POST", url: "/api/wishlist", headers, payload: { title: "Hollow Knight" } })).json().items.find((i: { title: string }) => i.title === "Hollow Knight");
    await app.inject({ method: "PUT", url: `/api/wishlist/${other.id}`, headers, payload: { monitored: false } });
    saveConnectorSettings(ctx.db, { wanted: { autoSearch: true, autoGrab: false, intervalHours: 12, onlyReleased: false } });
    await ctx.wanted.run();
    assert.equal(ctx.wishlist.list().find((i) => i.id === other.id)!.searchedAt, null);
  });

  it("says a game is out only when its date has passed", () => {
    assert.equal(isReleased({ releaseDate: "2020-01-01", dateText: null }), true);
    assert.equal(isReleased({ releaseDate: "2999-01-01", dateText: null }), false);
    assert.equal(isReleased({ releaseDate: null, dateText: "Q4 2026" }), false);
  });

  it("talks to Transmission and Deluge", async () => {
    let session = "";
    const tr = new TransmissionClient({ url: "http://tr:9091", username: "u", password: "p", category: "games", savePath: "/dl" }, (async (_i: string | URL | Request, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      if (h.get("x-transmission-session-id") !== "abc") return new Response("", { status: 409, headers: { "x-transmission-session-id": "abc" } });
      session = h.get("x-transmission-session-id")!;
      const body = JSON.parse(String(init?.body)) as { method: string; arguments: Record<string, unknown> };
      if (body.method === "torrent-add") {
        assert.equal(body.arguments["download-dir"], "/dl");
        assert.ok(body.arguments.metainfo, "a .torrent file goes as metainfo");
        return Response.json({ result: "success", arguments: { "torrent-duplicate": { hashString: "aa".repeat(20) } } });
      }
      return Response.json({ result: "success", arguments: { torrents: [{ hashString: "aa".repeat(20), name: "G", totalSize: 9, percentDone: 1, rateDownload: 0, eta: -1, status: 6, error: 0, downloadDir: "/dl", labels: ["games"] }] } });
    }) as typeof fetch);
    assert.equal(await tr.addTorrent({ file: new Uint8Array([1, 2]), hash: "aa".repeat(20), name: "g.torrent" }, "gm-1"), "aa".repeat(20));
    assert.equal(session, "abc");
    const [t] = await tr.list();
    assert.deepEqual([t!.state, t!.path], ["seeding", "/dl/G"]);

    const calls: string[] = [];
    const deluge = new DelugeClient({ url: "http://deluge:8112", password: "pw", category: "games", savePath: "" }, (async (_i: string | URL | Request, init?: RequestInit) => {
      const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      calls.push(method);
      const ok = (result: unknown, cookie?: string) => Response.json({ result, error: null, id: 1 }, cookie ? { headers: { "set-cookie": `_session_id=${cookie}; Path=/` } } : undefined);
      if (method === "auth.login") return params[0] === "pw" ? ok(true, "s1") : ok(false);
      if (method === "web.connected") return ok(false);
      if (method === "web.get_hosts") return ok([["host1", "127.0.0.1", 58846, "Online"]]);
      if (method === "core.add_torrent_magnet") return ok("BB".repeat(20));
      if (method === "core.get_torrents_status") return ok({ ["bb".repeat(20)]: { name: "G", total_size: 5, progress: 50, download_payload_rate: 10, eta: 30, state: "Downloading", save_path: "/d", label: "games" } });
      return ok(true);
    }) as typeof fetch);
    assert.equal(await deluge.addTorrent({ magnet: MAGNET, hash: null }, "gm-2"), "bb".repeat(20));
    assert.ok(calls.includes("web.connect") && calls.includes("label.set_torrent"));
    const [d] = await deluge.list();
    assert.deepEqual([d!.progress, d!.state], [0.5, "downloading"]);
  });

  it("scans imports with ClamAV and holds flagged ones for review", async () => {
    assert.deepEqual(parseClamOutput("/g/a.exe: Win.Trojan.X FOUND\n/g/b.dll: OK"), [{ file: "/g/a.exe", threat: "Win.Trojan.X", engine: "clamav" }]);
    // A fake clamd: flags anything with "bad" in the path.
    const server = net.createServer((sock) => {
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
        if (!buf.endsWith("\0")) return;
        if (buf.startsWith("zPING")) sock.end("PONG\0");
        else {
          const target = buf.slice("zMULTISCAN ".length, -1);
          sock.end(target.includes("bad") ? `${target}/game.exe: Win.Test.Eicar FOUND\0` : `${target}: OK\0`);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const { app, ctx } = await makeApp(root, { apiToken: "svc" });
      const headers = { authorization: "Bearer svc" };
      saveConnectorSettings(ctx.db, { scan: { clamav: "clamd", clamdHost: "127.0.0.1", clamdPort: port, virusTotalKey: "", hold: true } });
      assert.match((await app.inject({ method: "POST", url: "/api/scans/test", headers })).json().message, /ClamAV answered/);

      const good = path.join(root, "Good Game");
      const bad = path.join(root, "bad game");
      for (const dir of [good, bad]) {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "game.exe"), "x");
      }
      assert.equal(await ctx.downloads.afterImport(good, "Good Game"), good);
      assert.equal(await ctx.downloads.afterImport(bad, "bad game"), null);
      assert.ok(!(await readdir(root)).includes("bad game"), "moved out of the games folder");
      assert.equal(ctx.notifier.list().alerts[0]!.kind, "flagged");

      const scans = (await app.inject({ url: "/api/scans", headers })).json();
      const held = scans.find((s: { status: string }) => s.status === "flagged");
      assert.match(held.findings[0].threat, /Eicar/);
      const released = await app.inject({ method: "POST", url: `/api/scans/${held.id}`, headers, payload: { action: "release" } });
      assert.equal(released.statusCode, 200, released.body);
      assert.ok((await readdir(root)).includes("bad game"));
      await rm(good, { recursive: true });
      await rm(bad, { recursive: true });
    } finally {
      server.close();
    }
  });

  it("compares versions and checks GOG for a newer installer", async () => {
    assert.equal(compareVersions("1.10.2", "1.9"), 1);
    assert.equal(compareVersions("1.2", "1.2.0"), 0);
    assert.equal(compareVersions("Build 120", "Build 99"), 1);
    assert.equal(versionIn("Patch 1.2.3 is live"), "1.2.3");
    assert.equal(versionIn("Halloween event!"), null);
    assert.equal(versionIn("Update 1.1.0.21 notes"), "1.1.0.21");
    assert.equal(compareVersions("1.1.0.21", "1.1.0.19"), 1);

    await writeFile(path.join(root, "Dredge v1.2.zip"), "zip");
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "embed.gog.com") return Response.json({ products: [{ id: 42, title: "DREDGE", url: "/game/dredge" }] });
      if (url.hostname === "api.gog.com") return Response.json({ downloads: { installers: [{ os: "windows", version: "1.5.3" }] } });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, { apiToken: "svc" }, { fetchImpl });
    const headers = { authorization: "Bearer svc" };
    const game = ctx.library.list({ search: "dredge" })[0]!;
    const check = (await app.inject({ method: "POST", url: `/api/games/${game.id}/version`, headers })).json();
    assert.deepEqual([check.current, check.latest, check.source, check.behind], ["1.2", "1.5.3", "gog", true]);
    // The cover's version pill hears about it straight away.
    assert.deepEqual(ctx.library.list({ search: "dredge" })[0]!.storeVersion, { latest: "1.5.3", source: "gog", behind: true });
    assert.equal((await app.inject({ url: "/api/updates", headers })).json()[0].title, game.title);
    assert.equal(ctx.notifier.list().alerts[0]!.kind, "updates");
    const home = (await app.inject({ url: "/api/home", headers })).json();
    assert.ok(home.sections.some((s: { id: string }) => s.id === "updates"));
    await rm(path.join(root, "Dredge v1.2.zip"));
  });

  it("keeps a journal and backlog per profile, picks from it, and counts library stats", async () => {
    const { app, ctx } = await makeApp(root);
    const user = await ctx.users.create({ username: "sam", password: "password123", role: "user" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "sam", password: "password123" } });
    const cookie = login.cookies.find((c) => c.name === "gm_session")!;
    const headers = { cookie: `gm_session=${cookie.value}` };
    const [a, b] = ctx.library.list({ platform: "pc" });

    const empty = (await app.inject({ url: "/api/backlog/roulette", headers })).json();
    assert.equal(empty.from, "unplayed", "falls back to unplayed games");

    await app.inject({ method: "PUT", url: `/api/games/${a!.id}/journal`, headers, payload: { status: "backlog", rating: 9 } });
    const j = (await app.inject({ method: "POST", url: `/api/games/${b!.id}/journal/entries`, headers, payload: { text: "Beat the first boss" } })).json();
    assert.equal(j.status, "playing", "writing about a game marks it as playing");
    const ja = (await app.inject({ url: `/api/games/${a!.id}/journal`, headers })).json();
    assert.deepEqual([ja.status, ja.rating], ["backlog", 5]);
    const bad = await app.inject({ method: "PUT", url: `/api/games/${a!.id}/journal`, headers, payload: { status: "someday" } });
    assert.equal(bad.statusCode, 400);

    const backlog = (await app.inject({ url: "/api/backlog", headers })).json();
    assert.equal(backlog.counts.backlog, 1);
    assert.equal(backlog.counts.playing, 1);
    const pick = (await app.inject({ url: "/api/backlog/roulette", headers })).json();
    assert.deepEqual([pick.game.id, pick.from, pick.poolSize], [a!.id, "backlog", 1]);

    await app.inject({ method: "DELETE", url: `/api/journal/entries/${j.entries[0].id}`, headers });
    assert.equal((await app.inject({ url: `/api/games/${b!.id}/journal`, headers })).json().entries.length, 0);

    const stats = (await app.inject({ url: "/api/stats/library", headers })).json();
    assert.equal(stats.gameCount, ctx.library.list({}).length);
    assert.equal(stats.addedByMonth.length, 12);
    assert.equal(stats.backlog.backlog, 1);
    assert.ok(stats.biggest[0].bytes >= stats.biggest.at(-1).bytes);
    assert.equal(user.username, "sam");
  });

  it("lists trending NexusMods mods without adult ones", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(new Headers(init?.headers).get("apikey"), "nx");
      if (url.pathname === "/v1/games.json") return Response.json([{ name: "The Sims 4", domain_name: "thesims4" }]);
      if (url.pathname === "/v1/games/thesims4/mods/trending.json")
        return Response.json([
          { mod_id: 1, name: "Better UI", summary: "s", author: "a", endorsement_count: 5, available: true, status: "published" },
          { mod_id: 2, name: "Spicy", summary: "s", author: "a", endorsement_count: 9, contains_adult_content: true, available: true, status: "published" },
        ]);
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, { apiToken: "svc" }, { fetchImpl });
    saveConnectorSettings(ctx.db, { nexus: { apiKey: "nx" } });
    const game = ctx.library.list({ search: "sims" })[0]!;
    const mods = (await app.inject({ url: `/api/games/${game.id}/mods`, headers: { authorization: "Bearer svc" } })).json();
    assert.equal(mods.domain, "thesims4");
    assert.deepEqual(mods.mods.map((m: { name: string }) => m.name), ["Better UI"]);
    assert.equal(mods.mods[0].url, "https://www.nexusmods.com/thesims4/mods/1");
    assert.equal(mods.configured, true);
  });

  it("matches NexusMods games without subtitles or editions, and tests the key", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/games.json") return Response.json([{ name: "The Witcher 3", domain_name: "witcher3" }, { name: "Fallout 4", domain_name: "fallout4" }, { name: "Skyrim Special Edition", domain_name: "skyrimspecialedition" }]);
      if (url.pathname === "/v1/users/validate.json") return Response.json({ name: "raccoon" });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const nexus = new NexusMods(() => "nx", fetchImpl);
    assert.equal(await nexus.domainFor("The Witcher 3: Wild Hunt"), "witcher3");
    assert.equal(await nexus.domainFor("Fallout 4 Game of the Year Edition"), "fallout4");
    assert.equal(await nexus.domainFor("Skyrim Special Edition"), "skyrimspecialedition");
    assert.equal(await nexus.domainFor("Celeste"), null);
    assert.match(await nexus.test(), /raccoon/);
    await assert.rejects(new NexusMods(() => "", fetchImpl).test(), /Add a NexusMods API key/);
  });
});
