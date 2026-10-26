import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { saveConnectorSettings } from "../src/connectors/settings.js";
import { parseEpic, parseGog, parseItchFeed, pickItchUpload } from "../src/news/freegames.js";
import { steamMarkupToText } from "../src/news/updates.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
process.env.GM_ITCH_GAP_MS = "5";
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

const EPIC = {
  data: {
    Catalog: {
      searchStore: {
        elements: [
          {
            title: "Free Now",
            catalogNs: { mappings: [{ pageSlug: "free-now-1a2b" }] },
            keyImages: [{ type: "OfferImageWide", url: "https://cdn/epic-wide.jpg" }],
            price: { totalPrice: { discountPrice: 0, originalPrice: 1999 } },
            promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: "2026-10-09T15:00:00.000Z", endDate: "2026-10-16T15:00:00.000Z", discountSetting: { discountPercentage: 0 } }] }], upcomingPromotionalOffers: [] },
          },
          {
            title: "Next Week",
            productSlug: "next-week",
            keyImages: [{ type: "Thumbnail", url: "https://cdn/next.jpg" }],
            price: { totalPrice: { discountPrice: 2499, originalPrice: 2499 } },
            promotions: { promotionalOffers: [], upcomingPromotionalOffers: [{ promotionalOffers: [{ startDate: "2026-10-16T15:00:00.000Z", endDate: "2026-10-23T15:00:00.000Z", discountSetting: { discountPercentage: 0 } }] }] },
          },
          { title: "Just On Sale", promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: "x", endDate: "y", discountSetting: { discountPercentage: 50 } }] }] } },
        ],
      },
    },
  },
};

const GOG = {
  products: [
    { title: "Giveaway Game", storeLink: "https://www.gog.com/en/game/giveaway", coverHorizontal: "https://gog/g.png", tags: [], price: { finalMoney: { amount: "0.00" }, baseMoney: { amount: "9.99" } } },
    { title: "Some Demo", storeLink: "https://www.gog.com/en/game/demo", tags: ["Demo (demo)"], price: { finalMoney: { amount: "0.00" }, baseMoney: { amount: "0.00" } } },
  ],
};

const ITCH = `<?xml version="1.0"?><rss version="2.0"><channel><title>Top rated free games</title>
<item><title>Tiny Quest [Free] [Adventure] [Windows] [Linux]</title><plainTitle>Tiny Quest</plainTitle><imageurl>https://img.itch.zone/q.png</imageurl><link>https://maker.itch.io/tiny-quest</link></item>
<item><title>Web Toy [Free] [Toy] [HTML5]</title><plainTitle>Web Toy</plainTitle><link>https://maker.itch.io/web-toy</link></item>
</channel></rss>`;

describe("free games, update notes and the downloads folder", () => {
  it("reads each store's free listings", () => {
    const epic = parseEpic(EPIC);
    assert.deepEqual(
      epic.map((g) => [g.title, g.upcoming, g.url]),
      [
        ["Free Now", false, "https://store.epicgames.com/en-US/p/free-now-1a2b"],
        ["Next Week", true, "https://store.epicgames.com/en-US/p/next-week"],
      ],
    );
    assert.equal(epic[0]!.endsAt, "2026-10-16T15:00:00.000Z");
    assert.deepEqual(parseGog(GOG).map((g) => g.title), ["Giveaway Game"]);
    // Browser-only itch.io games can't be downloaded into the library, so they're left out.
    assert.deepEqual(parseItchFeed(ITCH, true).map((g) => [g.title, g.canAdd]), [["Tiny Quest", true]]);
  });

  it("lists free games and downloads an itch.io game into the library", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get("authorization");
      if (url.hostname.includes("epicgames")) return Response.json(EPIC);
      if (url.hostname === "catalog.gog.com") return Response.json(GOG);
      if (url.hostname === "store.steampowered.com") return Response.json({ results_html: "" });
      if (url.toString() === "https://itch.io/games/top-rated/free.xml") return new Response(ITCH);
      if (url.toString() === "https://maker.itch.io/tiny-quest") return new Response('<meta property="og:title" content="Tiny Quest"><meta name="itch:path" content="games/4242">');
      if (url.pathname === "/games/4242/uploads") {
        assert.equal(auth, "Bearer itch-key");
        return Response.json({ uploads: [{ id: 7, filename: "TinyQuest-mac.zip", p_osx: true, type: "default" }, { id: 8, filename: "TinyQuest-win.zip", p_windows: true, type: "default" }] });
      }
      if (url.pathname === "/uploads/8/download") return new Response("zip bytes");
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, { apiToken: "svc" }, { fetchImpl });
    const headers = { authorization: "Bearer svc" };
    const free = (await app.inject({ url: "/api/discover/free", headers })).json();
    assert.deepEqual([...new Set(free.games.map((g: { store: string }) => g.store))], ["epic", "gog", "prime", "itch"]);
    assert.equal(free.itchConnected, false);

    const noKey = await app.inject({ method: "POST", url: "/api/discover/free/itch", headers, payload: { url: "https://maker.itch.io/tiny-quest" } });
    assert.match(noKey.json().error, /itch\.io API key/);
    saveConnectorSettings(ctx.db, { itch: { apiKey: "itch-key" } });
    const added = await app.inject({ method: "POST", url: "/api/discover/free/itch", headers, payload: { url: "https://maker.itch.io/tiny-quest" } });
    assert.equal(added.statusCode, 200, added.body);
    assert.deepEqual((await readdir(path.join(root, "Tiny Quest"))).sort(), [".itch.json", "TinyQuest-win.zip"]);
    assert.ok(ctx.library.list({ search: "tiny quest" }).length === 1);
    await rm(path.join(root, "Tiny Quest"), { recursive: true });
  });

  it("finds itch.io downloads tagged by traits or only by file name, and says why when there are none", () => {
    const pick = (uploads: Parameters<typeof pickItchUpload>[0]) => pickItchUpload(uploads);
    // The current API lists platforms as traits rather than p_windows flags.
    assert.equal(pick([{ id: 1, filename: "OurLife-mac.zip", traits: ["p_osx"] }, { id: 2, filename: "OurLife-pc.zip", traits: ["p_windows"], type: "default" }]).upload?.id, 2);
    // Untagged uploads go by name; a demo only counts when there's nothing else.
    assert.equal(pick([{ id: 3, filename: "HoloCure_demo.zip", traits: ["p_windows", "demo"] }, { id: 4, filename: "HoloCure.exe" }]).upload?.id, 4);
    assert.equal(pick([{ id: 5, filename: "game.zip" }]).upload?.id, 5);
    assert.equal(pick([{ id: 6, filename: "Game-Linux.tar.gz" }]).upload?.id, 6);
    assert.match(pick([]).why, /no downloads for this game/);
    assert.match(pick([{ id: 7, filename: "index.zip", type: "html" }]).why, /browser-only/);
    assert.match(pick([{ id: 8, filename: "Game.dmg", traits: ["p_osx"] }, { id: 9, filename: "game.apk" }]).why, /only has Mac and Android/);
  });

  it("waits and retries when itch.io rate-limits, then explains if it keeps saying no", async () => {
    let calls = 0;
    let limited = 2;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls++;
      if (url.hostname === "fan.itch.io") {
        if (limited-- > 0) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
        return new Response('<meta property="og:title" content="Holo Fan"><meta name="itch:path" content="games/77">');
      }
      if (url.pathname === "/games/77/uploads") return Response.json({ uploads: [{ id: 1, filename: "HoloFan.zip", traits: ["p_windows"] }] });
      if (url.pathname === "/games/78/uploads") return new Response("no", { status: 429 });
      if (url.pathname === "/uploads/1/download") return new Response("zip");
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, { apiToken: "svc" }, { fetchImpl });
    saveConnectorSettings(ctx.db, { itch: { apiKey: "k" } });
    const headers = { authorization: "Bearer svc" };
    const ok = await app.inject({ method: "POST", url: "/api/discover/free/itch", headers, payload: { url: "https://fan.itch.io/holo" } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(calls, 5);
    await rm(path.join(root, "Holo Fan"), { recursive: true });
    const stuck = (async (input: string | URL | Request) =>
      String(input).includes("/games/78/") ? new Response("no", { status: 429 }) : new Response('<meta name="itch:path" content="games/78">')) as typeof fetch;
    const two = await makeApp(root, { apiToken: "svc" }, { fetchImpl: stuck });
    saveConnectorSettings(two.ctx.db, { itch: { apiKey: "k" } });
    const res = await two.app.inject({ method: "POST", url: "/api/discover/free/itch", headers, payload: { url: "https://other.itch.io/game" } });
    assert.match(res.json().error, /Try again in a minute/);
  });

  it("turns Steam announcement markup into readable text", () => {
    const text = steamMarkupToText("[h2]Patch 1.2[/h2][list][*]Fixed [b]crash[/b][*]New [url=https://x]map[/url][/list]{STEAM_CLAN_IMAGE}/a.png");
    assert.equal(text, "Patch 1.2\n\n• Fixed crash\n• New map");
  });

  it("deletes a download once it's imported, by default", async () => {
    const downloads = await mkdtemp(path.join(os.tmpdir(), "gm-dl-"));
    try {
      await mkdir(path.join(downloads, "Other.Game.v2-GOG"));
      await writeFile(path.join(downloads, "Other.Game.v2-GOG", "game.exe"), "x");
      const { app, ctx } = await makeApp(root, { apiToken: "svc" });
      assert.equal(ctx.downloads.settings().import.mode, "move");
      saveConnectorSettings(ctx.db, { import: { ...ctx.downloads.settings().import, folder: downloads, tidy: { stripJunk: true, extract: false, repack: "folder" } } });
      const r = await app.inject({ method: "POST", url: "/api/downloads/folder/import", headers: { authorization: "Bearer svc" }, payload: { name: "Other.Game.v2-GOG" } });
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(await readdir(r.json().target), ["game.exe"]);
      assert.deepEqual(await readdir(downloads), []);
      await rm(r.json().target, { recursive: true });
    } finally {
      await rm(downloads, { recursive: true, force: true });
    }
  });

  it("imports games already sitting in the downloads folder", async () => {
    const downloads = await mkdtemp(path.join(os.tmpdir(), "gm-dl-"));
    try {
      await mkdir(path.join(downloads, "Cool.Game.v1.2-GOG"));
      await writeFile(path.join(downloads, "Cool.Game.v1.2-GOG", "game.exe"), "x");
      await writeFile(path.join(downloads, "Cool.Game.v1.2-GOG", "Visit-site.com.txt"), "ad");
      await writeFile(path.join(downloads, "half.iso.part"), "x");
      const { app, ctx } = await makeApp(root, { apiToken: "svc" });
      const headers = { authorization: "Bearer svc" };
      saveConnectorSettings(ctx.db, { import: { ...ctx.downloads.settings().import, folder: downloads, mode: "copy", tidy: { stripJunk: true, extract: false, repack: "folder" } } });
      const list = (await app.inject({ url: "/api/downloads/folder", headers })).json();
      assert.deepEqual(list.items.map((i: { name: string; status: string }) => [i.name, i.status]), [["Cool.Game.v1.2-GOG", "new"]]);
      const r = await app.inject({ method: "POST", url: "/api/downloads/folder/import", headers, payload: { name: "Cool.Game.v1.2-GOG" } });
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(await readdir(r.json().target), ["game.exe"]);
      // Copied, not moved: the original stays for seeding.
      assert.ok((await readdir(downloads)).includes("Cool.Game.v1.2-GOG"));
      const again = (await app.inject({ url: "/api/downloads/folder", headers })).json();
      assert.equal(again.items[0].status, "imported");
      await rm(r.json().target, { recursive: true });

      // A lone ROM sent to a console lands next to that console's other games.
      await writeFile(path.join(downloads, "Super Metroid (USA).sfc"), "rom");
      const rom = await app.inject({ method: "POST", url: "/api/downloads/folder/import", headers, payload: { name: "Super Metroid (USA).sfc", platform: "snes" } });
      assert.equal(rom.json().target, path.join(root, "Emulation", "snes", "Super Metroid (USA).sfc"));
      await rm(path.join(root, "Emulation"), { recursive: true });
    } finally {
      await rm(downloads, { recursive: true, force: true });
    }
  });
});
