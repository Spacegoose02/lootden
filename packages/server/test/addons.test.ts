import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { jsonList } from "../src/addons/json-list.js";
import type { LibraryAddon } from "../src/addons/types.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

/** A store whose owned games the test changes between syncs. */
let owned: Array<{ externalId: string; title: string; playtimeSeconds?: number }> = [];
const fakeStore: LibraryAddon = {
  id: "fake",
  name: "Fake Store",
  description: "For tests",
  fields: [
    { key: "user", label: "User name", required: true },
    { key: "key", label: "API key", secret: true, required: true },
  ],
  async games({ config }) {
    if (config.key !== "good") throw new Error("Wrong API key");
    return owned;
  },
  launchUrl: (id) => `steam://rungameid/${id}`,
};

async function signIn(app: Awaited<ReturnType<typeof makeApp>>["app"], ctx: Awaited<ReturnType<typeof makeApp>>["ctx"], username: string, role: "user" | "admin" = "user") {
  await ctx.users.create({ username, password: "password123", role });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
  return { cookie: `gm_session=${login.cookies.find((c) => c.name === "gm_session")!.value}` };
}

describe("library add-ons", () => {
  it("connects an account per person, syncs its games and masks secrets", async () => {
    const { app, ctx } = await makeApp(root, {}, { addons: [fakeStore, jsonList] });
    const sam = await signIn(app, ctx, "sam");
    const kim = await signIn(app, ctx, "kim");

    const list = (await app.inject({ url: "/api/addons", headers: sam })).json();
    assert.deepEqual(list.map((a: { id: string; account: unknown }) => [a.id, a.account]), [["fake", null], ["json-list", null]]);

    const missing = await app.inject({ method: "PUT", url: "/api/addons/fake/account", headers: sam, payload: { config: { user: "sam" } } });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().error, /API key is needed/);

    const bad = await app.inject({ method: "PUT", url: "/api/addons/fake/account", headers: sam, payload: { config: { user: "sam", key: "nope" } } });
    assert.match(bad.json().error, /Fake Store: Wrong API key/);
    const failing = (await app.inject({ url: "/api/addons", headers: sam })).json()[0].account;
    assert.equal(failing.error, "Wrong API key", "the error stays on the account");

    owned = [
      { externalId: "620", title: "Portal 2", playtimeSeconds: 3600 },
      { externalId: "999", title: "Hades" },
    ];
    const ok = (await app.inject({ method: "PUT", url: "/api/addons/fake/account", headers: sam, payload: { config: { user: "sam", key: "good" } } })).json();
    assert.equal(ok.games, 2);
    assert.deepEqual(ok.addons[0].account.config, { user: "sam", key: "********" });
    assert.equal(ok.addons[0].account.error, null);

    const games = (await app.inject({ url: "/api/store-games", headers: sam })).json();
    assert.deepEqual(
      games.map((g: { title: string; store: string; launchUrl: string; playtimeSeconds: number | null }) => [g.title, g.store, g.launchUrl, g.playtimeSeconds]),
      [["Hades", "Fake Store", "steam://rungameid/999", null], ["Portal 2", "Fake Store", "steam://rungameid/620", 3600]],
    );
    const portal = ctx.library.list().find((g) => g.title.startsWith("Portal"))!;
    assert.equal(games[1].libraryGameId, portal.id, "matched to the LootDen copy by title");
    assert.deepEqual((await app.inject({ url: "/api/store-games", headers: kim })).json(), [], "each person sees only their own");

    // Saving with the masked key keeps it; a game gone from the store leaves the list.
    owned = [{ externalId: "620", title: "Portal 2", playtimeSeconds: 7200 }];
    const again = (await app.inject({ method: "PUT", url: "/api/addons/fake/account", headers: sam, payload: { config: { user: "sam", key: "********" } } })).json();
    assert.equal(again.games, 1);
    assert.deepEqual((await app.inject({ url: "/api/store-games", headers: sam })).json().map((g: { playtimeSeconds: number }) => g.playtimeSeconds), [7200]);

    // Admins can switch an add-on off; its games are hidden and it can't be connected.
    assert.equal((await app.inject({ method: "PUT", url: "/api/addons/fake", headers: sam, payload: { enabled: false } })).statusCode, 403);
    const admin = await signIn(app, ctx, "boss", "admin");
    await app.inject({ method: "PUT", url: "/api/addons/fake", headers: admin, payload: { enabled: false } });
    assert.deepEqual((await app.inject({ url: "/api/store-games", headers: sam })).json(), []);
    assert.match((await app.inject({ method: "PUT", url: "/api/addons/fake/account", headers: kim, payload: { config: { user: "k", key: "good" } } })).json().error, /switched off/);
    await app.inject({ method: "PUT", url: "/api/addons/fake", headers: admin, payload: { enabled: true } });

    assert.equal((await app.inject({ method: "DELETE", url: "/api/addons/fake/account", headers: sam })).json()[0].account, null);
    assert.deepEqual((await app.inject({ url: "/api/store-games", headers: sam })).json(), []);
  });

  it("reads a JSON games list, and keeps people off the server's own network", async () => {
    const lists: Record<string, unknown> = {
      "https://lists.example/games.json": { games: [{ id: 7, title: "Dredge", store: "itch", launch: "itch://games/7", playtimeMinutes: 90 }, { name: "No Id Game" }, { id: 8 }] },
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://lists.example/hop") return new Response(null, { status: 302, headers: { location: "http://nas.lan/games.json" } });
      if (url in lists) return Response.json(lists[url]);
      if (url === "http://nas.lan/games.json") return Response.json([{ title: "LAN Game" }]);
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const resolveHost = async (h: string) => (h === "nas.lan" ? ["192.168.1.5"] : ["93.184.216.34"]);
    const { app, ctx } = await makeApp(root, {}, { fetchImpl, resolveHost, addons: [jsonList] });
    const sam = await signIn(app, ctx, "sam");
    const admin = await signIn(app, ctx, "boss", "admin");

    const r = (await app.inject({ method: "PUT", url: "/api/addons/json-list/account", headers: sam, payload: { config: { url: "https://lists.example/games.json" } } })).json();
    assert.equal(r.games, 2);
    const games = (await app.inject({ url: "/api/store-games?addon=json-list", headers: sam })).json();
    assert.deepEqual(games.map((g: { title: string; externalId: string; launchUrl: string | null; playtimeSeconds: number | null }) => [g.title, g.externalId, g.launchUrl, g.playtimeSeconds]), [
      ["Dredge", "7", "itch://games/7", 5400],
      ["No Id Game", "No Id Game", null, null],
    ]);

    const lan = await app.inject({ method: "PUT", url: "/api/addons/json-list/account", headers: sam, payload: { config: { url: "http://nas.lan/games.json" } } });
    assert.match(lan.json().error, /server's own network/);
    const redirected = await app.inject({ method: "PUT", url: "/api/addons/json-list/account", headers: sam, payload: { config: { url: "https://lists.example/hop" } } });
    assert.match(redirected.json().error, /server's own network/, "also after a redirect");
    const byAdmin = (await app.inject({ method: "PUT", url: "/api/addons/json-list/account", headers: admin, payload: { config: { url: "http://nas.lan/games.json" } } })).json();
    assert.equal(byAdmin.games, 1, "an admin's account may read the LAN");
  });
});

describe("Steam add-on", () => {
  it("lists owned games with play time, and says what to fix when the profile is private", async () => {
    const { steam } = await import("../src/addons/steam.js");
    let games: unknown = [
      { appid: 620, name: "Portal 2", playtime_forever: 840, rtime_last_played: 1760000000 },
      { appid: 1145360, name: "Hades", playtime_forever: 0 },
    ];
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.hostname + url.pathname);
      if (url.hostname === "steamcommunity.com") return new Response("<profile><steamID64>76561197960287930</steamID64></profile>");
      if (url.searchParams.get("key") !== "k") return new Response("Forbidden", { status: 403 });
      assert.equal(url.searchParams.get("steamid"), "76561197960287930");
      return Response.json({ response: games ? { game_count: 2, games } : {} });
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, {}, { fetchImpl, addons: [steam], resolveHost: async () => ["93.184.216.34"] });
    const sam = await signIn(app, ctx, "sam");

    const bad = await app.inject({ method: "PUT", url: "/api/addons/steam/account", headers: sam, payload: { config: { steamId: "gabelogannewell", apiKey: "nope" } } });
    assert.match(bad.json().error, /refused the API key/);
    const ok = (await app.inject({ method: "PUT", url: "/api/addons/steam/account", headers: sam, payload: { config: { steamId: "https://steamcommunity.com/id/gabelogannewell/", apiKey: "k" } } })).json();
    assert.equal(ok.games, 2);
    assert.ok(calls.includes("steamcommunity.com/id/gabelogannewell/"), "custom URL names are resolved to the 64-bit id");
    const list = (await app.inject({ url: "/api/store-games?addon=steam", headers: sam })).json();
    assert.deepEqual(list.map((g: { title: string; launchUrl: string; playtimeSeconds: number | null; storeUrl: string }) => [g.title, g.launchUrl, g.playtimeSeconds, g.storeUrl]), [
      ["Hades", "steam://rungameid/1145360", null, "https://store.steampowered.com/app/1145360"],
      ["Portal 2", "steam://rungameid/620", 50400, "https://store.steampowered.com/app/620"],
    ]);
    assert.match(list[1].coverUrl, /620\/library_600x900\.jpg$/);
    assert.equal(list[1].lastPlayedAt, new Date(1760000000 * 1000).toISOString());

    games = null;
    const priv = await app.inject({ method: "POST", url: "/api/addons/steam/sync", headers: sam });
    assert.match(priv.json().error, /Game details to Public/);
    assert.equal((await app.inject({ url: "/api/store-games?addon=steam", headers: sam })).json().length, 2, "a failed sync keeps the last list");
  });
});

describe("GOG add-on", () => {
  it("signs in with a pasted code, keeps the refreshed token, and lists every page of games", async () => {
    const { gog, gogCode } = await import("../src/addons/gog.js");
    assert.equal(gogCode("https://embed.gog.com/on_login_success?origin=client&code=abc123"), "abc123");
    let issued = 0;
    const refreshUsed: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "auth.gog.com") {
        const grant = url.searchParams.get("grant_type");
        if (grant === "authorization_code" && url.searchParams.get("code") !== "abc123") return Response.json({ error_description: "bad code" }, { status: 400 });
        if (grant === "refresh_token") refreshUsed.push(url.searchParams.get("refresh_token")!);
        issued++;
        return Response.json({ access_token: `at${issued}`, refresh_token: `rt${issued}` });
      }
      assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer at\d$/);
      const page = Number(url.searchParams.get("page"));
      return Response.json({
        totalPages: 2,
        products: page === 1 ? [{ id: 1, title: "Dredge", image: "//images.gog-statics.com/abc", url: "/en/game/dredge" }, { id: 9, title: "Soundtrack", isGame: false }] : [{ id: 2, title: "Hades", image: "//images.gog-statics.com/def", url: "/en/game/hades" }],
      });
    }) as typeof fetch;
    const { app, ctx, db } = await makeApp(root, {}, { fetchImpl, addons: [gog], resolveHost: async () => ["93.184.216.34"] });
    const sam = await signIn(app, ctx, "sam");

    assert.match((await app.inject({ method: "PUT", url: "/api/addons/gog/account", headers: sam, payload: { config: {} } })).json().error, /Sign in to GOG/);
    assert.match((await app.inject({ method: "PUT", url: "/api/addons/gog/account", headers: sam, payload: { config: { code: "old" } } })).json().error, /didn't accept that code/);
    const ok = (await app.inject({ method: "PUT", url: "/api/addons/gog/account", headers: sam, payload: { config: { code: "https://embed.gog.com/on_login_success?origin=client&code=abc123" } } })).json();
    assert.equal(ok.games, 2);
    assert.deepEqual(ok.addons[0].account.config, { code: "" }, "the used code isn't kept or shown");
    const stored = JSON.parse((db.prepare("SELECT config FROM addon_accounts").get() as { config: string }).config);
    assert.deepEqual(stored, { code: "", refreshToken: "rt1" });

    // Sync and Save (with the code left empty) use the refresh token, and keep the new one.
    await app.inject({ method: "POST", url: "/api/addons/gog/sync", headers: sam });
    await app.inject({ method: "PUT", url: "/api/addons/gog/account", headers: sam, payload: { config: { code: "" } } });
    assert.deepEqual(refreshUsed, ["rt1", "rt2"]);
    const games = (await app.inject({ url: "/api/store-games?addon=gog", headers: sam })).json();
    assert.deepEqual(games.map((g: { title: string; coverUrl: string; storeUrl: string; launchUrl: string }) => [g.title, g.coverUrl, g.storeUrl, g.launchUrl]), [
      ["Dredge", "https://images.gog-statics.com/abc_392.jpg", "https://www.gog.com/en/game/dredge", "goggalaxy://openGameView/1"],
      ["Hades", "https://images.gog-statics.com/def_392.jpg", "https://www.gog.com/en/game/hades", "goggalaxy://openGameView/2"],
    ]);
  });
});
