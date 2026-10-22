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
