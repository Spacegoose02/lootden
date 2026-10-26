import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { gogNew, itchNew } from "../src/sources/adapters/feeds.js";
import { jsonFeed } from "../src/sources/adapters/json-feed.js";
import { cleanDownloads, planDownload } from "../src/sources/download.js";
import { isoDate, parseFeed } from "../src/sources/adapters/util.js";
import { isPrivateAddress, paginate, SourceClient } from "../src/sources/client.js";
import type { SourceConfig } from "../src/sources/types.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

const publicDns = async () => ["93.184.216.34"];
const config = (patch: Partial<SourceConfig> = {}): SourceConfig => ({ enabled: true, baseUrl: "https://feed.example/list.json", apiKey: "", perMinute: 60, perHour: 1000, extraHosts: [], onMyNetwork: false, displayName: "", ...patch });

describe("release sources", () => {
  it("only calls allowed public hosts, also after redirects", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (String(input).endsWith("/hop")) return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const client = new SourceClient("Test", { hosts: ["feed.example"], perMinute: 60, perHour: 100 }, fetchImpl, publicDns);
    assert.deepEqual(await client.json("https://feed.example/a"), { ok: true });
    await assert.rejects(client.fetch("https://other.example/a"), /isn't allowed to call other\.example/);
    await assert.rejects(client.fetch("https://feed.example/hop"), /isn't allowed to call evil\.example/);
    await assert.rejects(client.fetch("file:///etc/passwd"), /only http and https/);
    assert.deepEqual(calls, ["https://feed.example/a", "https://feed.example/hop"]);

    const lan = new SourceClient("Home", { hosts: ["nas.lan"], perMinute: 60, perHour: 100 }, fetchImpl, async () => ["192.168.1.20"]);
    await assert.rejects(lan.fetch("http://nas.lan/feed"), /private network/);
    const allowed = new SourceClient("Home", { hosts: ["nas.lan"], perMinute: 60, perHour: 100, allowPrivate: true }, fetchImpl, async () => ["192.168.1.20"]);
    assert.equal((await allowed.fetch("http://nas.lan/feed")).status, 200);
    assert.ok(isPrivateAddress("127.0.0.1") && isPrivateAddress("::1") && isPrivateAddress("169.254.169.254") && !isPrivateAddress("8.8.8.8"));
  });

  it("waits after a 429 and keeps to the hourly cap", async () => {
    let n = 0;
    const fetchImpl = (async () => (++n === 1 ? new Response("slow", { status: 429, headers: { "retry-after": "0" } }) : Response.json([]))) as typeof fetch;
    const client = new SourceClient("Test", { hosts: ["feed.example"], perMinute: 60, perHour: 3 }, fetchImpl, publicDns);
    assert.equal((await client.fetch("https://feed.example/a")).status, 200);
    assert.equal(n, 2, "retried once after the 429");
    await client.fetch("https://feed.example/b");
    await assert.rejects(client.fetch("https://feed.example/c"), /used its 3 requests for this hour/);
    assert.equal(client.usedThisHour, 3);
  });

  it("reads JSON Feed pages, RSS dates, itch.io and GOG listings", async () => {
    assert.deepEqual(await paginate(async (p) => ({ items: p < 3 ? [p] : [], more: true })), [1, 2]);
    assert.equal(isoDate("2024.03.21"), "2024-03-21");
    assert.equal(isoDate("Thu, 21 Mar 2024 10:00:00 GMT"), "2024-03-21");

    const pages: Record<string, unknown> = {
      "https://feed.example/list.json": { items: [{ id: 1, title: "Tiny Quest", date_published: "2026-10-01T10:00:00Z", url: "https://x/1", details: { Store: "Mine" } }], next_url: "https://feed.example/list.json?page=2" },
      "https://feed.example/list.json?page=2": { items: [{ id: 2, title: "Big Quest", date: "2026-09-30", platform: "PC" }] },
    };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer k");
      return Response.json(pages[String(input)]);
    }) as typeof fetch;
    const client = new SourceClient("JSON", { hosts: ["feed.example"], perMinute: 60, perHour: 100 }, fetchImpl, publicDns);
    const items = await jsonFeed.latest({ config: config({ apiKey: "k" }), client });
    assert.deepEqual(items.map((i) => [i.title, i.date, i.platform]), [["Tiny Quest", "2026-10-01", null], ["Big Quest", "2026-09-30", "pc"]]);
    assert.deepEqual(items[0]!.details, { Store: "Mine" });

    const rss = `<rss><channel><item><title>Tiny Quest [Free] [Windows]</title><link>https://maker.itch.io/tiny</link><pubDate>Mon, 12 Oct 2026 09:00:00 GMT</pubDate></item></channel></rss>`;
    assert.equal(parseFeed(rss, "x")[0]!.date, "2026-10-12");
    const itchClient = new SourceClient("itch", { hosts: ["itch.io"], perMinute: 60, perHour: 100 }, (async () => new Response(rss)) as typeof fetch, publicDns);
    const [it1] = await itchNew.latest({ config: config({ baseUrl: itchNew.defaultBaseUrl }), client: itchClient });
    assert.deepEqual([it1!.title, it1!.platform], ["Tiny Quest", "pc"]);

    const gogClient = new SourceClient("GOG", { hosts: ["catalog.gog.com"], perMinute: 60, perHour: 100 }, (async () => Response.json({ products: [{ id: 9, title: "Dredge", slug: "dredge", releaseDate: "2023.03.30" }] })) as typeof fetch, publicDns);
    const [g] = await gogNew.latest({ config: config({ baseUrl: gogNew.defaultBaseUrl }), client: gogClient });
    assert.deepEqual([g!.title, g!.date, g!.url], ["Dredge", "2023-03-30", "https://www.gog.com/en/game/dredge"]);
  });

  it("saves settings from Settings, lists releases on Discover and alerts for wishlist games", async () => {
    let call = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (new URL(String(input)).hostname !== "nas.lan") return new Response("nope", { status: 404 });
      call++;
      return Response.json({ items: call === 1 ? [{ id: "a", title: "Celeste", date: "2026-10-12" }, { id: "b", title: "Something Else" }] : [{ id: "a", title: "Celeste" }] });
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, { apiToken: "svc" }, { fetchImpl });
    const headers = { authorization: "Bearer svc" };
    await app.inject({ method: "POST", url: "/api/wishlist", headers, payload: { title: "Celeste" } });

    const bad = await app.inject({ method: "PUT", url: "/api/sources/json-feed", headers, payload: { enabled: true } });
    assert.match(bad.json().error, /needs an address/);
    const saved = (await app.inject({ method: "PUT", url: "/api/sources/json-feed", headers, payload: { enabled: true, baseUrl: "http://nas.lan/releases.json", apiKey: "secret", onMyNetwork: true } })).json();
    assert.equal(saved.config.apiKey, "********");
    await app.inject({ method: "PUT", url: "/api/sources/json-feed", headers, payload: { ...saved.config } });
    assert.equal(ctx.sources.config(ctx.sources.adapters.find((a) => a.id === "json-feed")!).apiKey, "secret", "the mask keeps the key");

    const test = (await app.inject({ method: "POST", url: "/api/sources/json-feed/test", headers })).json();
    assert.equal(test.message, "Listed 2 releases");
    const alerts = ctx.notifier.list().alerts.filter((a) => a.kind === "sources");
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.title, /Celeste showed up in JSON feed/);

    await ctx.sources.run();
    assert.equal(ctx.notifier.list().alerts.filter((a) => a.kind === "sources").length, 1, "only once per release");
    const latest = (await app.inject({ url: "/api/sources/latest", headers })).json();
    assert.deepEqual(latest.map((r: { title: string }) => r.title).sort(), ["Celeste", "Something Else"]);
    assert.equal(latest[0].sourceName, "JSON feed (example)");
    assert.equal((await app.inject({ url: "/api/sources/for?title=celeste", headers })).json().length, 1);

    // A name of your own shows wherever the source does; blank goes back to the default.
    const named = (await app.inject({ method: "PUT", url: "/api/sources/json-feed", headers, payload: { displayName: "  NAS releases  " } })).json();
    assert.equal(named.name, "NAS releases");
    assert.equal(named.defaultName, "JSON feed (example)");
    assert.equal(named.nameable, true);
    assert.ok((await app.inject({ url: "/api/sources/latest", headers })).json().every((r: { sourceName: string }) => r.sourceName === "NAS releases"));
    const gog = (await app.inject({ method: "PUT", url: "/api/sources/gog-new", headers, payload: { displayName: "Mine" } })).json();
    assert.equal(gog.name, "GOG new releases", "only feed sources take a name");
    assert.equal(gog.nameable, false);
    await app.inject({ method: "PUT", url: "/api/sources/json-feed", headers, payload: { displayName: "" } });
    assert.equal((await app.inject({ url: "/api/sources/latest", headers })).json()[0].sourceName, "JSON feed (example)");

    // Switched off: nothing on Discover.
    await app.inject({ method: "PUT", url: "/api/sources/json-feed", headers, payload: { enabled: false } });
    assert.deepEqual((await app.inject({ url: "/api/sources/latest", headers })).json(), []);
  });

  it("picks a release's own link: a known file host, then a torrent, never one it didn't list", () => {
    const downloads = cleanDownloads([
      { title: "Game", uris: ["https://gofile.io/d/x", "magnet:?xt=urn:btih:abc", "https://www.mediafire.com/file/k/Game.rar/file", "javascript:alert(1)", " "] },
      { title: "empty", uris: [] },
    ]);
    assert.deepEqual(downloads, [{ title: "Game", uris: ["https://gofile.io/d/x", "magnet:?xt=urn:btih:abc", "https://www.mediafire.com/file/k/Game.rar/file"], size: null }]);
    assert.deepEqual(planDownload(downloads, { torrents: true }), { via: "direct", url: "https://www.mediafire.com/file/k/Game.rar/file" });
    assert.deepEqual(planDownload(downloads, { torrents: true, uri: "magnet:?xt=urn:btih:abc" }), { via: "torrent", url: "magnet:?xt=urn:btih:abc" });
    assert.throws(() => planDownload(downloads, { torrents: true, uri: "https://evil.example/x.rar" }), /isn't one this release lists/);
    assert.throws(() => planDownload(downloads, { torrents: true, uri: "https://gofile.io/d/x" }), /can't download from that host/);
    const torrentOnly = [{ uris: ["magnet:?xt=urn:btih:abc", "https://gofile.io/d/x"] }];
    assert.deepEqual(planDownload(torrentOnly, { torrents: true }), { via: "torrent", url: "magnet:?xt=urn:btih:abc" });
    assert.throws(() => planDownload(torrentOnly, { torrents: false }), /set up a torrent client/);
    assert.deepEqual(planDownload([{ uris: ["https://cdn.example/Game.zip"] }], { torrents: false }), { via: "direct", url: "https://cdn.example/Game.zip" });
    assert.throws(() => planDownload(undefined, { torrents: true }), /no download links/);
  });

  it("keeps a source's download links and starts one from Discover", async () => {
    let links = ["https://www.mediafire.com/file/k/Linked.Game.rar/file"];
    const fetchImpl = (async (input: string | URL | Request) => {
      if (new URL(String(input)).hostname !== "nas.lan") return new Response("nope", { status: 404 });
      return Response.json({ items: [{ id: "l", title: "Linked Game", downloads: [{ title: "Linked.Game", uris: links, fileSize: "2 GB" }] }, { id: "n", title: "No Links" }] });
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, { apiToken: "svc" }, { fetchImpl });
    const headers = { authorization: "Bearer svc" };
    await app.inject({ method: "PUT", url: "/api/sources/json-feed", headers, payload: { enabled: true, baseUrl: "http://nas.lan/releases.json", onMyNetwork: true } });
    await app.inject({ method: "POST", url: "/api/sources/json-feed/test", headers });

    const latest: Array<{ id: string; title: string; downloads?: Array<{ uris: string[]; size: string | null }> }> = (await app.inject({ url: "/api/sources/latest", headers })).json();
    const linked = latest.find((r) => r.title === "Linked Game")!;
    const none = latest.find((r) => r.title === "No Links")!;
    assert.deepEqual(linked.downloads, [{ title: "Linked.Game", uris: links, size: "2 GB" }]);
    assert.equal(none.downloads, undefined);

    // A release seen before picks up its current links on the next refresh.
    links = ["magnet:?xt=urn:btih:abc", "https://www.mediafire.com/file/k/Linked.Game.rar/file"];
    await ctx.sources.refresh("json-feed");
    assert.deepEqual(ctx.sources.item(linked.id)!.downloads![0]!.uris, links);

    const noLinks = await app.inject({ method: "POST", url: "/api/sources/download", headers, payload: { id: none.id } });
    assert.equal(noLinks.statusCode, 400);
    assert.match(noLinks.json().error, /no download links/);
    assert.equal((await app.inject({ method: "POST", url: "/api/sources/download", headers, payload: { id: "nope" } })).statusCode, 404);
    const forged = await app.inject({ method: "POST", url: "/api/sources/download", headers, payload: { id: linked.id, uri: "https://evil.example/a.rar" } });
    assert.match(forged.json().error, /isn't one this release lists/);
    // No torrent client set up, so the magnet can't be chosen.
    const magnet = await app.inject({ method: "POST", url: "/api/sources/download", headers, payload: { id: linked.id, uri: links[0] } });
    assert.match(magnet.json().error, /torrent client/);

    const started = await app.inject({ method: "POST", url: "/api/sources/download", headers, payload: { id: linked.id } });
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().via, "direct");
    const pkg = ctx.direct.list()[0]!;
    assert.equal(pkg.name, "Linked Game");
    assert.deepEqual(pkg.files.map((f) => f.url), ["https://www.mediafire.com/file/k/Linked.Game.rar/file"]);
    await ctx.direct.control(pkg.id, "remove").catch(() => null);
  });
});
