import assert from "node:assert/strict";
import net from "node:net";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { humbleGames, humbleSession } from "../src/addons/humble.js";
import { isoDurationSeconds, npssoOf, psnGames } from "../src/addons/playstation.js";
import { dealWorthAlert } from "../src/integrations/prices.js";
import { HomeAssistantBridge } from "../src/integrations/homeassistant.js";
import { connectPacket, MqttPublisher, publishPacket, remainingLength } from "../src/integrations/mqtt.js";
import { LudusaviManifest, manifestPathToTemplate, parseGameBlock } from "../src/saves/ludusavi.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function admin(app: Awaited<ReturnType<typeof makeApp>>["app"], ctx: Awaited<ReturnType<typeof makeApp>>["ctx"]) {
  await ctx.users.create({ username: "boss", password: "password123", role: "admin" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "boss", password: "password123" } });
  return { cookie: `gm_session=${login.cookies.find((c) => c.name === "gm_session")!.value}` };
}

describe("ProtonDB and Steam Deck badges", () => {
  it("asks both once, and keeps the answer", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string | URL) => {
      calls++;
      const u = String(url);
      if (u.includes("protondb.com")) return json({ tier: "gold", trendingTier: "platinum", total: 321, confidence: "strong" });
      if (u.includes("ajaxgetdeckappcompatibilityreport")) return json({ success: 1, results: { appid: 413150, resolved_category: 3 } });
      return json({}, 404);
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, {}, { fetchImpl });
    const headers = await admin(app, ctx);
    const res = await app.inject({ method: "GET", url: "/api/compat/steam/413150", headers });
    assert.equal(res.statusCode, 200);
    const c = res.json();
    assert.deepEqual(c.protondb, { tier: "gold", trending: "platinum", reports: 321, confidence: "strong" });
    assert.equal(c.deck, "verified");
    await app.inject({ method: "GET", url: "/api/compat/steam/413150", headers });
    assert.equal(calls, 2, "the second look comes from the cache");
    assert.equal((await app.inject({ method: "GET", url: "/api/compat/steam/abc", headers })).statusCode, 400);
  });
});

describe("wishlist prices", () => {
  it("decides when a price is worth an alert", () => {
    const s = { minCut: 0, atLow: true };
    assert.equal(dealWorthAlert({ price: 10, cut: 50, low: 10, target: null }, s), true, "lowest ever");
    assert.equal(dealWorthAlert({ price: 20, cut: 0, low: 10, target: null }, s), false);
    assert.equal(dealWorthAlert({ price: 20, cut: 0, low: 10, target: 25 }, s), true, "under the target");
    assert.equal(dealWorthAlert({ price: 20, cut: 60, low: 10, target: null }, { minCut: 50, atLow: false }), true, "far enough off");
    assert.equal(dealWorthAlert({ price: null, cut: 0, low: null, target: 5 }, s), false);
  });

  it("checks IsThereAnyDeal and alerts once per drop", async () => {
    let price = 9.99;
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      seen.push(u.pathname);
      assert.equal(u.searchParams.get("key"), "itad-key");
      if (u.pathname === "/games/lookup/v1") return json({ found: true, game: { id: "game-uuid", slug: "hades", title: "Hades" } });
      if (u.pathname === "/games/prices/v3") {
        assert.deepEqual(JSON.parse(String(init?.body)), ["game-uuid"]);
        return json([{ id: "game-uuid", historyLow: { all: { amount: 9.99, currency: "USD" } }, deals: [{ shop: { id: 61, name: "Steam" }, price: { amount: price, currency: "USD" }, regular: { amount: 24.99 }, cut: 60, url: "https://store.steampowered.com/app/1145360" }, { shop: { name: "GOG" }, price: { amount: 24.99, currency: "USD" }, regular: { amount: 24.99 }, cut: 0, url: "https://gog.com" }] }]);
      }
      return json({}, 404);
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, {}, { fetchImpl });
    const headers = await admin(app, ctx);
    ctx.wishlist.addManual("Hades", null);
    assert.equal((await app.inject({ method: "GET", url: "/api/wishlist/prices", headers })).json().enabled, false);
    const saved = await app.inject({ method: "PUT", url: "/api/wishlist/prices/settings", headers, payload: { apiKey: "itad-key", country: "gb" } });
    assert.equal(saved.json().settings.apiKey, "********");
    assert.equal(saved.json().settings.country, "GB");

    const r = await app.inject({ method: "POST", url: "/api/wishlist/prices/check", headers });
    assert.equal(r.statusCode, 200, r.body);
    const p = r.json().prices[0];
    assert.equal(p.price, 9.99);
    assert.equal(p.shop, "Steam");
    assert.equal(p.cut, 60);
    assert.equal(p.low, 9.99);
    assert.equal(p.itadUrl, "https://isthereanydeal.com/game/hades/info/");
    const deals = () => ctx.notifier.list().alerts.filter((a) => a.kind === "deals");
    assert.equal(deals().length, 1);
    assert.match(deals()[0]!.title, /Hades is/);

    await app.inject({ method: "POST", url: "/api/wishlist/prices/check", headers });
    assert.equal(deals().length, 1, "same price, no second alert");
    price = 7.49;
    await app.inject({ method: "POST", url: "/api/wishlist/prices/check", headers });
    assert.equal(deals().length, 2, "cheaper again, a new alert");
    assert.equal(seen.filter((x) => x === "/games/lookup/v1").length, 1, "the lookup is remembered");

    const t = await app.inject({ method: "PUT", url: `/api/wishlist/${p.wishId}/target`, headers, payload: { target: 5 } });
    assert.equal(t.json().prices[0].target, 5);
  });
});

describe("Home Assistant over MQTT", () => {
  it("encodes MQTT packets", () => {
    assert.deepEqual([...remainingLength(0)], [0]);
    assert.deepEqual([...remainingLength(321)], [0xc1, 0x02]);
    const c = connectPacket({ url: "mqtt://x", clientId: "id", username: "u", password: "p", will: { topic: "t", payload: "offline", retain: true } });
    assert.equal(c[0], 0x10);
    assert.equal(c.subarray(2, 8).toString("latin1"), "\u0000\u0004MQTT");
    assert.equal(c[9], 0x80 | 0x40 | 0x20 | 0x04 | 0x02);
    const p = publishPacket("a/b", "hi", true);
    assert.deepEqual([...p], [0x31, 7, 0, 3, 0x61, 0x2f, 0x62, 0x68, 0x69]);
  });

  it("publishes discovery and who's playing to a broker", async () => {
    const got: Array<{ topic: string; payload: string; retain: boolean }> = [];
    let connect: Buffer | null = null;
    const broker = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) return;
          let len = 0;
          let mul = 1;
          let i = 1;
          for (; i < buf.length; i++) {
            len += (buf[i]! & 0x7f) * mul;
            mul *= 128;
            if (!(buf[i]! & 0x80)) break;
          }
          const start = i + 1;
          if (buf.length < start + len) return;
          const type = buf[0]!;
          const body = buf.subarray(start, start + len);
          if (type === 0x10) {
            connect = body;
            sock.write(Buffer.from([0x20, 2, 0, 0]));
          } else if ((type & 0xf0) === 0x30) {
            const tl = body.readUInt16BE(0);
            got.push({ topic: body.subarray(2, 2 + tl).toString(), payload: body.subarray(2 + tl).toString(), retain: (type & 1) === 1 });
          }
          buf = buf.subarray(start + len);
        }
      });
    });
    await new Promise<void>((r) => broker.listen(0, "127.0.0.1", () => r()));
    const port = (broker.address() as net.AddressInfo).port;
    const { ctx, db } = await makeApp(root);
    const kid = await ctx.users.create({ username: "kiddo", password: "password123", role: "user" });
    const bridge = new HomeAssistantBridge(db, () => ({ people: [{ id: kid.id, name: "Kiddo", playing: { title: "Stardew Valley", device: "DEN-PC", startedAt: "2026-11-01T10:00:00Z", remainingMinutes: 30, picture: null } }], games: 12, pcsOnline: 1, downloads: 0 }), () => "http://lootden.lan");
    await assert.rejects(bridge.save({ enabled: true, url: "http://nope" }), /mqtt:\/\//);
    const view = await bridge.save({ enabled: true, url: `mqtt://127.0.0.1:${port}`, username: "ha", password: "secret" });
    assert.equal(view.password, "********");
    assert.equal(view.connected, true);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(connect);
    assert.ok(got.some((g) => g.topic === "lootden/status" && g.payload === "online" && g.retain));
    const disc = got.find((g) => g.topic === `homeassistant/sensor/lootden/player_${kid.id}/config`);
    assert.ok(disc, "discovery config for the person");
    assert.equal(JSON.parse(disc.payload).state_topic, `lootden/people/${kid.id}/state`);
    assert.equal(got.find((g) => g.topic === `lootden/people/${kid.id}/state`)?.payload, "Stardew Valley");
    assert.equal(got.find((g) => g.topic === "lootden/games")?.payload, "12");
    assert.equal(JSON.parse(got.find((g) => g.topic === `lootden/people/${kid.id}/attributes`)!.payload).minutes_left_today, 30);
    bridge.stop();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(got.at(-1)?.payload, "offline");
    await new Promise<void>((r) => broker.close(() => r()));
  });

  it("says when the broker refuses the password", async () => {
    const broker = net.createServer((sock) => sock.once("data", () => sock.write(Buffer.from([0x20, 2, 0, 4]))));
    await new Promise<void>((r) => broker.listen(0, "127.0.0.1", () => r()));
    const c = new MqttPublisher({ url: `mqtt://127.0.0.1:${(broker.address() as net.AddressInfo).port}`, clientId: "x" });
    await assert.rejects(c.connect(), /wrong user name or password/);
    await new Promise<void>((r) => broker.close(() => r()));
  });
});

const MANIFEST = `---
Stardew Valley:
  files:
    "<home>/.config/StardewValley/Saves":
      tags:
        - save
      when:
        - os: mac
    "<winAppData>/StardewValley/Saves":
      tags:
        - save
      when:
        - os: windows
  gog:
    id: 1453375253
  steam:
    id: 413150
"Grand Theft Auto V: \\"Special\\"":
  files:
    "<winDocuments>/Rockstar Games/GTA V/Profiles/<storeUserId>":
      tags:
        - save
      when:
        - os: windows
    <base>/steam_only.cfg:
      when:
        - os: windows
          store: steam
    <root>/elsewhere: {}
Hollow Knight:
  files:
    "<winLocalAppDataLow>/Team Cherry/Hollow Knight/*.dat":
      tags:
        - save
`;

describe("Ludusavi's save list", () => {
  it("turns its placeholders into LootDen's", () => {
    assert.equal(manifestPathToTemplate("<winAppData>/Foo/Saves/"), "%APPDATA%/Foo/Saves");
    assert.equal(manifestPathToTemplate("<base>/saves/*.sav"), "{game}/saves/*.sav");
    assert.equal(manifestPathToTemplate("<root>/x"), null);
    assert.equal(manifestPathToTemplate("<xdgConfig>/x"), null);
  });

  it("finds games by Steam id, GOG id or title, keeping Windows paths for the right store", () => {
    const m = new LudusaviManifest("/tmp/unused");
    m.index(MANIFEST);
    assert.equal(m.size, 3);
    assert.deepEqual(m.find({ title: "whatever", steamAppId: "413150", store: "steam" })?.locations, [{ template: "%APPDATA%/StardewValley/Saves", tags: ["save"] }]);
    assert.equal(m.find({ title: "x", gogId: "1453375253" })?.name, "Stardew Valley");
    const gta = m.find({ title: 'Grand Theft Auto V: "Special"', store: "rockstar" });
    assert.deepEqual(
      gta?.locations.map((l) => l.template),
      ["%DOCUMENTS%/Rockstar Games/GTA V/Profiles/*"],
      "the Steam-only file is left out for Rockstar's copy",
    );
    assert.equal(m.find({ title: 'Grand Theft Auto V: "Special"', store: "steam" })?.locations.length, 2);
    assert.equal(m.find({ title: "Hollow Knight™" })?.locations[0]?.template, "%USERPROFILE%/AppData/LocalLow/Team Cherry/Hollow Knight/*.dat");
    assert.equal(m.find({ title: "Not A Game" }), null);
  });

  it("reads a block on its own", () => {
    assert.deepEqual(parseGameBlock('X:\n  files:\n    "<base>/a": {}\n', null), [{ template: "{game}/a", tags: [] }]);
  });

  it("serves a store game's save places and keeps its backups apart", async () => {
    const fetchImpl = (async (url: string | URL) => (String(url).includes("ludusavi-manifest") ? new Response(MANIFEST) : json({}, 404))) as typeof fetch;
    const { app, ctx } = await makeApp(root, {}, { fetchImpl });
    const headers = await admin(app, ctx);
    const r = await app.inject({ method: "GET", url: "/api/store-games/steam/413150/save-paths?title=Stardew%20Valley", headers });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().locations[0].template, "%APPDATA%/StardewValley/Saves");
    const up = await app.inject({ method: "POST", url: "/api/store-games/steam/413150/saves?device=PC", headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from("PK zip bytes") });
    assert.equal(up.statusCode, 200, up.body);
    assert.equal(up.json().gameId, "store:steam:413150");
    const list = await app.inject({ method: "GET", url: "/api/store-games/steam/413150/saves", headers });
    assert.equal(list.json().length, 1);
    assert.equal((await app.inject({ method: "GET", url: "/api/store-games/gog/1/saves", headers })).json().length, 0);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/store-games/gog/1/saves/${up.json().id}`, headers })).statusCode, 404, "can't delete it through another game");
    const dl = await app.inject({ method: "GET", url: `/api/store-games/steam/413150/saves/${up.json().id}?title=Stardew`, headers });
    assert.equal(dl.body, "PK zip bytes");
  });
});

describe("Humble and PlayStation add-ons", () => {
  it("lists Humble's DRM-free games, not books", () => {
    assert.equal(humbleSession('_simpleauth_sess="abc|123|def"; other=1'), "abc|123|def");
    assert.equal(humbleSession("plain"), "plain");
    const games = humbleGames([
      { gamekey: "K1", subproducts: [{ machine_name: "celeste", human_name: "Celeste™", icon: "https://i/c.png", downloads: [{ platform: "windows" }] }, { machine_name: "book", human_name: "A Book", downloads: [{ platform: "ebook" }] }] },
      { gamekey: "K2", subproducts: [{ machine_name: "celeste", human_name: "Celeste", downloads: [{ platform: "linux" }] }] },
    ]);
    assert.deepEqual(games, [{ externalId: "celeste", title: "Celeste", coverUrl: "https://i/c.png", storeUrl: "https://www.humblebundle.com/downloads?key=K1" }]);
  });

  it("reads PlayStation's played list with play time", () => {
    assert.equal(isoDurationSeconds("PT12H3M4S"), 43384);
    assert.equal(isoDurationSeconds("P1DT1H"), 90000);
    assert.equal(isoDurationSeconds("PT0S"), null);
    assert.equal(npssoOf('{"npsso":"abc"}'), "abc");
    const g = psnGames([
      { titleId: "PPSA01", name: "Astro Bot", category: "ps5_native_game", playDuration: "PT2H", lastPlayedDateTime: "2026-10-01T00:00:00Z", concept: { id: 9 } },
      { titleId: "CUSA01", name: "Astro Bot", category: "ps4_game", playDuration: "PT1H", lastPlayedDateTime: "2026-09-01T00:00:00Z", concept: { id: 9 } },
    ]);
    assert.equal(g.length, 1);
    assert.equal(g[0]!.playtimeSeconds, 3 * 3600);
    assert.equal(g[0]!.lastPlayedAt, "2026-10-01T00:00:00Z");
  });
});
