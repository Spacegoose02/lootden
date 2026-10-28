import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { storeQuery } from "../src/addons/details.js";
import { PairingCodes } from "../src/auth/pairing.js";
import { Vault } from "../src/auth/vault.js";
import type { LibraryAddon } from "../src/addons/types.js";
import { AddonRegistry } from "../src/addons/registry.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

const fakeSteam: LibraryAddon = {
  id: "steam",
  name: "Steam",
  description: "For tests",
  fields: [{ key: "key", label: "API key", secret: true, required: true }],
  games: async () => [{ externalId: "620", title: "Portal 2", coverUrl: "https://cdn.example/620.jpg" }],
};

/** The Steam store, as far as these tests need it: a search and one game's details. */
const searches: string[] = [];
const steamStore = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === "/api/storesearch/") {
    searches.push(url.searchParams.get("term") ?? "");
    return Response.json(url.searchParams.get("term") === "Far Cry 6" ? { items: [{ id: 2369390, name: "Far Cry® 6", type: "app" }] } : { items: [] });
  }
  if (url.pathname === "/api/appdetails") {
    const id = url.searchParams.get("appids")!;
    const name = id === "620" ? "Portal 2" : "Far Cry® 6";
    return Response.json({ [id]: { success: true, data: { name, steam_appid: Number(id), short_description: `About ${name}`, genres: [{ description: "Action" }], screenshots: [{ path_full: `https://shots.example/${id}.jpg` }], developers: ["Valve"] } } });
  }
  throw new Error(`Unexpected network call in test: ${url}`);
}) as typeof fetch;

async function signIn(app: Awaited<ReturnType<typeof makeApp>>["app"], ctx: Awaited<ReturnType<typeof makeApp>>["ctx"], username: string) {
  await ctx.users.create({ username, password: "password123", role: "user" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
  return { cookie: `gm_session=${login.cookies.find((c) => c.name === "gm_session")!.value}` };
}

describe("store games: pages, covers and a person's changes", () => {
  it("turns install folder names into searches", () => {
    assert.equal(storeQuery("FarCry6"), "Far Cry 6");
    assert.equal(storeQuery("RidersRepublic"), "Riders Republic");
    assert.equal(storeQuery("Tom Clancy's Rainbow Six® Extraction"), "Tom Clancy's Rainbow Six Extraction");
    assert.equal(storeQuery("Steep"), "Steep");
  });

  it("finds details and covers by title, even for games only on the PC", async () => {
    const { app, ctx } = await makeApp(root, {}, { fetchImpl: steamStore, addons: [fakeSteam], resolveHost: async () => ["93.184.216.34"] });
    const sam = await signIn(app, ctx, "sam");

    // A Ubisoft game the PC found: the server has never heard of it, so the title comes along.
    const page = (await app.inject({ url: "/api/store-games/ubisoft/5266?title=FarCry6", headers: sam })).json();
    assert.equal(page.game, null);
    assert.equal(page.info.name, "Far Cry® 6");
    assert.equal(page.info.summary, "About Far Cry® 6");
    assert.equal(page.coverUrl, "https://cdn.cloudflare.steamstatic.com/steam/apps/2369390/library_600x900.jpg");
    assert.equal(page.backgroundUrl, "https://shots.example/2369390.jpg");

    const cover = await app.inject({ url: "/api/store-games/ubisoft/5266/cover?title=FarCry6", headers: sam });
    assert.equal(cover.statusCode, 302);
    assert.equal(cover.headers.location, page.coverUrl);
    assert.deepEqual(searches, ["Far Cry 6"], "matched once, then remembered for everyone");

    const none = await app.inject({ url: "/api/store-games/ubisoft/1/cover?title=Nothing%20Like%20It", headers: sam });
    assert.equal(none.statusCode, 404);
    assert.equal((await app.inject({ url: "/api/store-games/ubisoft/5266/cover?title=FarCry6" })).statusCode, 401, "signed-in people only");
  });

  it("looks a store game up again on Refresh, keeping its match when nothing is found", async () => {
    const { app, ctx, db } = await makeApp(root, {}, { fetchImpl: steamStore, addons: [fakeSteam], resolveHost: async () => ["93.184.216.34"] });
    const kim = await signIn(app, ctx, "kim");
    assert.equal((await app.inject({ url: "/api/store-games/ubisoft/5266?title=FarCry6", headers: kim })).json().info.name, "Far Cry® 6");
    db.prepare("UPDATE store_game_info SET info = ? WHERE provider = 'steam' AND provider_id = '2369390'").run(JSON.stringify({ name: "Stale", summary: null }));
    const before = searches.length;
    const fresh = await app.inject({ method: "POST", url: "/api/store-games/ubisoft/5266/refresh?title=FarCry6", headers: kim });
    assert.equal(fresh.statusCode, 200);
    assert.equal(fresh.json().info.name, "Far Cry® 6", "details fetched again, not the month-old copy");
    assert.equal(searches.length, before + 1, "matched by title again");

    // A title nothing matches now: the earlier match stays.
    const kept = await app.inject({ method: "POST", url: "/api/store-games/ubisoft/5266/refresh?title=Totally%20Different", headers: kim });
    assert.equal(kept.json().info.name, "Far Cry® 6");
  });

  it("lets each person rename a game, pick another match and set their own art", async () => {
    const { app, ctx } = await makeApp(root, {}, { fetchImpl: steamStore, addons: [fakeSteam], resolveHost: async () => ["93.184.216.34"] });
    const sam = await signIn(app, ctx, "sam");
    const kim = await signIn(app, ctx, "kim");
    for (const who of [sam, kim]) await app.inject({ method: "PUT", url: "/api/addons/steam/account", headers: who, payload: { config: { key: "k" } } });

    // A Steam game is matched straight by its app id.
    const page = (await app.inject({ url: "/api/store-games/steam/620", headers: sam })).json();
    assert.equal(page.game.title, "Portal 2");
    assert.equal(page.info.provider, "steam");
    assert.equal(page.coverUrl, "https://cdn.example/620.jpg", "the store's own cover first");

    const renamed = (await app.inject({ method: "PUT", url: "/api/store-games/steam/620", headers: sam, payload: { title: "Portal Two" } })).json();
    assert.equal(renamed.game.title, "Portal Two");
    const art = (await app.inject({ method: "PUT", url: "/api/store-games/steam/620/artwork/cover", headers: sam, payload: { url: "https://art.example/mine.png" } })).json();
    assert.equal(art.coverUrl, "https://art.example/mine.png");
    assert.equal((await app.inject({ method: "PUT", url: "/api/store-games/steam/620/artwork/cover", headers: sam, payload: { url: "javascript:alert(1)" } })).statusCode, 400);

    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const up = await app.inject({ method: "PUT", url: "/api/store-games/steam/620/artwork/background", headers: { ...sam, "content-type": "image/png" }, payload: png });
    assert.equal(up.statusCode, 200);
    assert.match(up.json().backgroundUrl, /^\/api\/store-games\/steam\/620\/background\?v=/);
    const served = await app.inject({ url: up.json().backgroundUrl, headers: sam });
    assert.equal(served.headers["content-type"], "image/png");
    assert.deepEqual(served.rawPayload, png);

    const list = (await app.inject({ url: "/api/store-games", headers: sam })).json();
    assert.equal(list[0].title, "Portal Two");
    assert.match(list[0].coverUrl, /^\/api\/store-games\/steam\/620\/cover\?v=/);
    assert.equal((await app.inject({ url: list[0].coverUrl, headers: sam })).headers.location, "https://art.example/mine.png");

    // Kim's copy is untouched.
    const theirs = (await app.inject({ url: "/api/store-games", headers: kim })).json();
    assert.equal(theirs[0].title, "Portal 2");
    assert.equal(theirs[0].coverUrl, "https://cdn.example/620.jpg");
    assert.equal(theirs[0].artUrl, "/api/store-games/steam/620/cover");

    // A different match, then back to the automatic one, and the store's title again.
    assert.equal((await app.inject({ method: "PUT", url: "/api/store-games/steam/620", headers: sam, payload: { match: { provider: "steam", providerId: "../etc" } } })).statusCode, 400);
    const other = (await app.inject({ method: "PUT", url: "/api/store-games/steam/620", headers: sam, payload: { match: { provider: "steam", providerId: "2369390" } } })).json();
    assert.equal(other.info.name, "Far Cry® 6");
    assert.deepEqual(other.custom.match, { provider: "steam", providerId: "2369390" });
    const back = (await app.inject({ method: "PUT", url: "/api/store-games/steam/620", headers: sam, payload: { match: null, title: null } })).json();
    assert.equal(back.info.name, "Portal 2");
    assert.equal(back.game.title, "Portal 2");
    const reset = (await app.inject({ method: "DELETE", url: "/api/store-games/steam/620/artwork/cover", headers: sam })).json();
    assert.equal(reset.coverUrl, "https://cdn.example/620.jpg");
  });
});

describe("store accounts' secrets", () => {
  it("encrypts them, and encrypts ones saved before encryption came in", async () => {
    const vault = Vault.fromSecret("test key");
    const sealed = vault.encrypt('{"apiKey":"abc"}');
    assert.ok(sealed.startsWith("enc:v1:") && !sealed.includes("abc"));
    assert.equal(vault.decrypt(sealed), '{"apiKey":"abc"}');
    assert.notEqual(vault.encrypt("same"), vault.encrypt("same"), "a fresh IV every time");
    assert.throws(() => Vault.fromSecret("another key").decrypt(sealed));
    assert.equal(vault.decrypt('{"plain":true}'), '{"plain":true}');

    const { ctx, db } = await makeApp(root, {}, { addons: [fakeSteam] });
    const user = await ctx.users.create({ username: "old", password: "password123", role: "user" });
    db.prepare("INSERT INTO addon_accounts (user_id, addon, config, connected_at) VALUES (?, 'steam', ?, '2026-01-01')").run(user.id, '{"key":"plain-secret"}');
    new AddonRegistry(db, ctx.library, undefined, [fakeSteam], undefined, vault);
    const raw = (db.prepare("SELECT config FROM addon_accounts WHERE user_id = ?").get(user.id) as { config: string }).config;
    assert.ok(raw.startsWith("enc:v1:") && !raw.includes("plain-secret"));
    assert.equal(vault.decrypt(raw), '{"key":"plain-secret"}');
  });
});

describe("pairing codes", () => {
  it("work once, for ten minutes", () => {
    const codes = new PairingCodes();
    const { code } = codes.issue(7, 0);
    assert.match(code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    assert.equal(codes.redeem(code.toLowerCase().replace("-", " "), 1000), 7);
    assert.equal(codes.redeem(code, 1000), null, "used up");
    const late = codes.issue(7, 0).code;
    assert.equal(codes.redeem(late, 10 * 60_000 + 1), null, "expired");
    const first = codes.issue(8, 0).code;
    const second = codes.issue(8, 0).code;
    assert.equal(codes.redeem(first, 1), null, "a new code replaces the old one");
    assert.equal(codes.redeem(second, 1), 8);
  });

  it("sign a new device in as the person who asked for the code", async () => {
    const { app, ctx } = await makeApp(root);
    const sam = await signIn(app, ctx, "sam");
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/pair" })).statusCode, 401, "only someone signed in gets a code");
    assert.equal((await app.inject({ url: "/api/auth/providers" })).json().pairing, true);

    const { code } = (await app.inject({ method: "POST", url: "/api/auth/pair", headers: sam })).json();
    const wrong = await app.inject({ method: "POST", url: "/api/auth/pair/redeem", payload: { code: "AAAA-AAAA" } });
    assert.equal(wrong.statusCode, 401);

    const browser = await app.inject({ method: "POST", url: "/api/auth/pair/redeem", payload: { code } });
    assert.equal(browser.json().user.username, "sam");
    const cookie = `gm_session=${browser.cookies.find((c) => c.name === "gm_session")!.value}`;
    assert.equal((await app.inject({ url: "/api/me", headers: { cookie } })).json().user.username, "sam");
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/pair/redeem", payload: { code } })).statusCode, 401, "a code works once");

    const { code: forApp } = (await app.inject({ method: "POST", url: "/api/auth/pair", headers: sam })).json();
    const token = (await app.inject({ method: "POST", url: "/api/auth/pair/redeem", payload: { code: forApp, client: true, device: "Ally" } })).json().token;
    assert.match(token, /\w+_/);
  });

  it("stops guessing after ten wrong codes", async () => {
    const { app } = await makeApp(root);
    for (let i = 0; i < 10; i++) await app.inject({ method: "POST", url: "/api/auth/pair/redeem", payload: { code: "BBBB-BBBB" } });
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/pair/redeem", payload: { code: "BBBB-BBBB" } })).statusCode, 429);
  });
});
