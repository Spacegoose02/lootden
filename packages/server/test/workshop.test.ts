import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { workshopId } from "../src/workshop/steam.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

/** Steam's Workshop API, as far as these tests need it. */
const calls: string[] = [];
const steam = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  calls.push(url.pathname);
  if (url.pathname === "/ISteamRemoteStorage/GetPublishedFileDetails/v1/") {
    const body = new URLSearchParams(String(init?.body));
    const ids = [...body.entries()].filter(([k]) => k.startsWith("publishedfileids")).map(([, v]) => v);
    return Response.json({
      response: {
        publishedfiledetails: ids.map((id) =>
          id === "999999"
            ? { publishedfileid: id, result: 9 }
            : { publishedfileid: id, result: 1, title: `Item ${id}`, consumer_app_id: id === "777777" ? 400 : 620, file_size: "2048", lifetime_subscriptions: 12, short_description: "[b]Bold[/b] hats" },
        ),
      },
    });
  }
  throw new Error(`Unexpected network call in test: ${url}`);
}) as typeof fetch;

async function signIn(app: Awaited<ReturnType<typeof makeApp>>["app"], ctx: Awaited<ReturnType<typeof makeApp>>["ctx"], username: string, extra: { role?: "admin" | "user"; kidMode?: boolean } = {}) {
  await ctx.users.create({ username, password: "password123", ...extra });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
  return { cookie: `gm_session=${login.cookies.find((c) => c.name === "gm_session")!.value}` };
}

describe("Steam Workshop", () => {
  it("reads Workshop links and ids", () => {
    assert.equal(workshopId("https://steamcommunity.com/sharedfiles/filedetails/?id=1234567&searchtext=x"), "1234567");
    assert.equal(workshopId(" 1234567 "), "1234567");
    assert.equal(workshopId("https://example.com/"), null);
  });

  it("lets admins set the app id and mods folder, and looks up pasted items for that game", async () => {
    const { app, ctx } = await makeApp(root, {}, { fetchImpl: steam });
    const game = ctx.library.get(ctx.library.list().find((g) => g.title.startsWith("Portal"))!.id)!;
    const admin = await signIn(app, ctx, "boss", { role: "admin" });
    const sam = await signIn(app, ctx, "sam");
    const kid = await signIn(app, ctx, "kiddo", { kidMode: true });
    const url = `/api/games/${game.id}/workshop`;

    assert.deepEqual((await app.inject({ url, headers: sam })).json(), { appId: game.metadata?.steamAppId ?? null, modsPath: "", canBrowse: false });
    assert.equal((await app.inject({ url, headers: kid })).statusCode, 403);
    assert.equal((await app.inject({ method: "PUT", url, headers: sam, payload: { appId: "620", modsPath: "Mods" } })).statusCode, 403);

    for (const modsPath of ["../Windows", "C:/Games", "/etc", "Mods/../.."]) {
      assert.equal((await app.inject({ method: "PUT", url, headers: admin, payload: { appId: "620", modsPath } })).statusCode, 400, modsPath);
    }
    assert.equal((await app.inject({ method: "PUT", url, headers: admin, payload: { appId: "abc", modsPath: "" } })).statusCode, 400);
    const saved = (await app.inject({ method: "PUT", url, headers: admin, payload: { appId: "620", modsPath: "Content\\Workshop\\" } })).json();
    assert.deepEqual(saved, { appId: "620", modsPath: "Content/Workshop", canBrowse: false });

    const found = (await app.inject({ url: `${url}/items?ids=${encodeURIComponent("https://steamcommunity.com/sharedfiles/filedetails/?id=1234567 999999")}`, headers: sam })).json();
    assert.equal(found.total, 1);
    assert.deepEqual(found.items[0], {
      id: "1234567",
      appId: "620",
      title: "Item 1234567",
      previewUrl: null,
      sizeBytes: 2048,
      updatedAt: null,
      subscriptions: 12,
      summary: "Bold hats",
      url: "https://steamcommunity.com/sharedfiles/filedetails/?id=1234567",
    });
    const other = await app.inject({ url: `${url}/items?ids=777777`, headers: sam });
    assert.equal(other.statusCode, 400);
    assert.match(other.json().error ?? other.body, /different game/);
    assert.equal((await app.inject({ url: `${url}/items?ids=nope`, headers: sam })).statusCode, 400);

    // Browsing needs a Steam Web API key, which nobody has saved here.
    assert.equal((await app.inject({ url: `${url}/items?q=hats`, headers: sam })).statusCode, 502);
    assert.ok(!calls.some((c) => c.includes("QueryFiles")));
  });
});

describe("Steam Workshop for games bought on Steam", () => {
  it("looks items up by the game's Steam app id, with no mods folder", async () => {
    const { app, ctx } = await makeApp(root, {}, { fetchImpl: steam });
    const sam = await signIn(app, ctx, "sam2");
    const kid = await signIn(app, ctx, "kiddo2", { kidMode: true });

    assert.deepEqual((await app.inject({ url: "/api/store-games/steam/620/workshop", headers: sam })).json(), { appId: "620", modsPath: "", canBrowse: false });
    assert.equal((await app.inject({ url: "/api/store-games/steam/620/workshop", headers: kid })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/store-games/steam/abc/workshop", headers: sam })).statusCode, 404);
    const found = (await app.inject({ url: "/api/store-games/steam/620/workshop/items?ids=111111", headers: sam })).json();
    assert.deepEqual(found.items.map((i: { id: string }) => i.id), ["111111"]);
    assert.equal((await app.inject({ url: "/api/store-games/steam/620/workshop/items?ids=777777", headers: sam })).statusCode, 400, "another game's item");
    await app.close();
  });
});
