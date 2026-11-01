import assert from "node:assert/strict";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { coverQuery, listTitle, parseListFeed } from "../src/news/wishlist.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>New games</title>
<item><title>Hollow Knight: Silksong</title><link>https://store.steampowered.com/app/1030300/Hollow_Knight_Silksong/</link></item>
<item><title>Some.Indie.Game.v1.0.2-GROUP</title><link>https://example.com/some-indie-game</link><enclosure url="https://example.com/a.jpg" type="image/jpeg"/></item>
<item><title>Half-Life 2</title><link>https://example.com/hl2</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom list</title>
<entry><title>Hades II</title><link rel="alternate" href="https://example.com/hades-2"/></entry>
<entry><title>THE HOLLOW KNIGHT: SILKSONG</title><link href="https://example.com/silksong"/></entry>
</feed>`;

describe("wishlist, list feeds and the calendar", () => {
  it("reads RSS and Atom lists", () => {
    const rss = parseListFeed(RSS);
    assert.equal(rss.title, "New games");
    assert.deepEqual(
      rss.items.map((i) => [i.title, i.steamAppId, i.image]),
      [
        ["Hollow Knight: Silksong", 1030300, null],
        ["Some Indie Game", null, "https://example.com/a.jpg"],
        ["Half-Life 2", null, null],
      ],
    );
    assert.deepEqual(parseListFeed(ATOM).items.map((i) => [i.title, i.url]), [
      ["Hades II", "https://example.com/hades-2"],
      ["THE HOLLOW KNIGHT: SILKSONG", "https://example.com/silksong"],
    ]);
    assert.equal(listTitle("Baldurs.Gate.3.v4.1.1-GOG"), "Baldurs Gate 3");
    assert.throws(() => parseListFeed("<html></html>"), /isn't an RSS or Atom feed/);
  });

  it("syncs a Steam wishlist and feeds without duplicates, and remembers removals", async () => {
    let wishlist = [{ appid: 1030300 }, { appid: 1145350 }];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "steamcommunity.com") return new Response("<profile><steamID64>76561197960287930</steamID64></profile>");
      if (url.pathname.includes("GetWishlist")) {
        assert.equal(url.searchParams.get("steamid"), "76561197960287930");
        return Response.json({ response: { items: wishlist } });
      }
      if (url.pathname.includes("GetItems")) {
        const ids = JSON.parse(url.searchParams.get("input_json")!).ids.map((i: { appid: number }) => i.appid);
        const names: Record<number, object> = {
          1030300: { appid: 1030300, name: "Hollow Knight: Silksong", release: { steam_release_date: 1772323200 } },
          1145350: { appid: 1145350, name: "Hades II", release: { is_coming_soon: true, coming_soon_display: "Q4 2026", custom_release_date_message: "Q4 2026" } },
        };
        return Response.json({ response: { store_items: ids.map((id: number) => names[id]) } });
      }
      if (url.toString() === "https://example.com/list.rss") return new Response(RSS);
      if (url.toString() === "https://example.com/list.atom") return new Response(ATOM);
      if (url.hostname === "store.steampowered.com") return Response.json({ results_html: "" });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const { app } = await makeApp(root, { apiToken: "svc" }, { fetchImpl });
    const headers = { authorization: "Bearer svc" };

    const linked = await app.inject({ method: "PUT", url: "/api/wishlist/steam", headers, payload: { profile: "https://steamcommunity.com/id/gabe/" } });
    assert.equal(linked.statusCode, 200, linked.body);
    let state = linked.json();
    assert.equal(state.steam.count, 2);
    assert.deepEqual(state.items.map((i: { title: string; releaseDate: string | null; dateText: string | null }) => [i.title, i.releaseDate, i.dateText]).sort(), [
      ["Hades II", null, "Q4 2026"],
      ["Hollow Knight: Silksong", "2026-03-01", null],
    ]);

    // The RSS list repeats Silksong (same Steam app) and the Atom list repeats both by title.
    state = (await app.inject({ method: "POST", url: "/api/wishlist/feeds", headers, payload: { url: "https://example.com/list.rss" } })).json();
    state = (await app.inject({ method: "POST", url: "/api/wishlist/feeds", headers, payload: { url: "https://example.com/list.atom", name: "Friends' picks" } })).json();
    assert.equal(state.items.length, 4);
    const silk = state.items.find((i: { title: string }) => i.title === "Hollow Knight: Silksong");
    assert.deepEqual(silk.sources.map((s: { name: string }) => s.name).sort(), ["Friends' picks", "New games", "Steam wishlist"]);

    // Removed by hand: a sync doesn't bring it back.
    const hl2 = state.items.find((i: { title: string }) => i.title === "Half-Life 2");
    state = (await app.inject({ method: "DELETE", url: `/api/wishlist/${hl2.id}`, headers })).json();
    state = (await app.inject({ method: "POST", url: "/api/wishlist/sync", headers })).json();
    assert.ok(!state.items.some((i: { title: string }) => i.title === "Half-Life 2"));

    // Taken off the Steam wishlist: Hades II stays because the Atom list still has it.
    wishlist = [{ appid: 1030300 }];
    state = (await app.inject({ method: "POST", url: "/api/wishlist/sync", headers })).json();
    assert.deepEqual(state.items.find((i: { title: string }) => i.title === "Hades II").sources.map((s: { name: string }) => s.name), ["Friends' picks"]);

    // Removing a feed removes what only it brought in.
    const rssFeed = state.feeds.find((f: { name: string }) => f.name === "New games");
    state = (await app.inject({ method: "DELETE", url: `/api/wishlist/feeds/${rssFeed.id}`, headers })).json();
    assert.ok(!state.items.some((i: { title: string }) => i.title === "Some Indie Game"));

    // Added by hand, and the library knows it.
    state = (await app.inject({ method: "POST", url: "/api/wishlist", headers, payload: { title: "Portal 2" } })).json();
    assert.ok(state.items.find((i: { title: string }) => i.title === "Portal 2").libraryId);

    // The calendar: a custom entry, a past one, and wishlist games with a date.
    const today = new Date().toISOString().slice(0, 10);
    const lastWeek = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    for (const [title, date] of [["LAN party", today], ["Beta weekend", lastWeek]]) {
      const r = await app.inject({ method: "POST", url: "/api/calendar/entries", headers, payload: { title, date, note: "Bring snacks" } });
      assert.equal(r.statusCode, 200, r.body);
    }
    const upcoming = (await app.inject({ url: "/api/calendar?days=30", headers })).json();
    assert.deepEqual(upcoming.items.filter((i: { provider: string }) => i.provider === "custom").map((i: { name: string }) => i.name), ["LAN party"]);
    const withPast = (await app.inject({ url: "/api/calendar?days=30&past=30", headers })).json();
    assert.deepEqual(withPast.items.filter((i: { provider: string }) => i.provider === "custom").map((i: { name: string }) => i.name), ["Beta weekend", "LAN party"]);
    const year = (await app.inject({ url: "/api/calendar?days=30&past=365", headers })).json();
    assert.ok(year.items.some((i: { provider: string; name: string }) => i.provider === "wishlist" && i.name === "Hollow Knight: Silksong"));
    const id = upcoming.items.find((i: { name: string }) => i.name === "LAN party").providerId;
    assert.equal((await app.inject({ method: "DELETE", url: `/api/calendar/entries/${id}`, headers })).statusCode, 200);
    await app.close();
  });

  it("finds Steam covers for feed entries that came without one, and follows a renamed feed", async () => {
    // A Watchmask (formerly Yamtrack) Discover feed: titles with the year, the cover as media:thumbnail on newer versions.
    let feed = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Upcoming games - Watchmask</title>
<item><title>Rooted (2027)</title><link>https://wm.example/details/game/igdb/1/rooted</link></item>
<item><title>Police Officer (2026)</title><link>https://wm.example/details/game/igdb/2/police-officer</link></item>
<item><title>Ski-E-O! Ski Resort Tycoon (2026)</title><link>https://wm.example/details/game/igdb/3/ski</link><media:thumbnail url="https://images.igdb.com/igdb/image/upload/t_cover_big/ski.jpg"/></item>
</channel></rss>`;
    const searches: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "wm.example") return new Response(feed);
      if (url.pathname === "/api/storesearch/") {
        const term = url.searchParams.get("term")!;
        searches.push(term);
        const items: Record<string, object[]> = {
          Rooted: [{ id: 2300230, name: "Rooted", type: "app" }],
          // Only a different game by a similar name: no cover is better than the wrong one.
          "Police Officer": [{ id: 999, name: "Police Officer Simulator", type: "app" }],
        };
        return Response.json({ total: 1, items: items[term] ?? [] });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, { apiToken: "svc" }, { fetchImpl });
    const headers = { authorization: "Bearer svc" };

    let state = (await app.inject({ method: "POST", url: "/api/wishlist/feeds", headers, payload: { url: "https://wm.example/rss/t/game/upcoming.xml", name: "Yamtrack" } })).json();
    const byTitle = (t: string) => state.items.find((i: { title: string }) => i.title === t);
    assert.equal(byTitle("Rooted (2027)").image, "https://cdn.cloudflare.steamstatic.com/steam/apps/2300230/header.jpg");
    assert.equal(byTitle("Rooted (2027)").steamAppId, 2300230);
    assert.equal(byTitle("Police Officer (2026)").image, null);
    assert.equal(byTitle("Ski-E-O! Ski Resort Tycoon (2026)").image, "https://images.igdb.com/igdb/image/upload/t_cover_big/ski.jpg");
    assert.ok(!searches.includes("Ski-E-O! Ski Resort Tycoon"), "entries with a feed cover aren't looked up");

    // A miss isn't searched again on every sync.
    const before = searches.length;
    await ctx.wishlist.syncAll();
    assert.equal(searches.length, before);

    // Renaming the feed (adding the same address under a new name) relabels its entries.
    feed = feed.replace("Upcoming games", "Upcoming");
    state = (await app.inject({ method: "POST", url: "/api/wishlist/feeds", headers, payload: { url: "https://wm.example/rss/t/game/upcoming.xml", name: "Watchmask" } })).json();
    assert.deepEqual(byTitle("Rooted (2027)").sources.map((s: { name: string }) => s.name), ["Watchmask"]);
    assert.equal(state.feeds.length, 1);
    await app.close();

    assert.equal(coverQuery("Rooted (2027)"), "Rooted");
    assert.equal(coverQuery("Blade Runner 2049"), "Blade Runner 2049");
  });

  it("lists recently added games by the folder's date modified", async () => {
    const dir = path.join(root, "..", `${path.basename(root)}-recent`);
    await mkdir(path.join(dir, "Old Game"), { recursive: true });
    await mkdir(path.join(dir, "New Game"), { recursive: true });
    // Unpacked files keep old dates from the archive; only the folders say what arrived last.
    await writeFile(path.join(dir, "New Game", "game.exe"), "x");
    await writeFile(path.join(dir, "Old Game", "game.exe"), "x");
    const old = new Date("2020-01-01");
    await utimes(path.join(dir, "New Game", "game.exe"), old, old);
    await utimes(path.join(dir, "Old Game"), new Date("2026-01-01"), new Date("2026-01-01"));
    await utimes(path.join(dir, "New Game"), new Date("2026-10-01"), new Date("2026-10-01"));
    try {
      const { app } = await makeApp(dir, { apiToken: "svc" });
      const list = (await app.inject({ url: "/api/games?sort=added&order=desc", headers: { authorization: "Bearer svc" } })).json();
      assert.deepEqual(list.map((g: { title: string }) => g.title), ["New Game", "Old Game"]);
      await app.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
