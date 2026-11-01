import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { isStoreLaunchUrl, parseRobloxPlace, robloxPlaceOf } from "@lootden/shared";
import { ageRatingOf } from "../src/roblox/catalog.js";
import { imageType, posterSvg, RobloxPosters, titleLines } from "../src/roblox/poster.js";
import { makeApp, makeLibrary, sessionCookie } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

type App = Awaited<ReturnType<typeof makeApp>>;

async function person(app: App["app"], ctx: App["ctx"], username: string, extra: { role?: "admin" | "user"; kidMode?: boolean } = {}) {
  const user = await ctx.users.create({ username, password: "password123", ...extra });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
  return { id: user.id, headers: { cookie: sessionCookie(login) } };
}

const ICON_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("icon")]);
const SHOT_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("shot")]);

/** Roblox's public APIs, as far as these tests need them: one experience, place 920587237 (start place) and 111 (a sub-place). */
const calls: string[] = [];
const roblox = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
  if (url.host === "apis.roblox.com" && url.pathname.startsWith("/universes/v1/places/")) {
    const place = url.pathname.split("/")[4];
    if (place === "920587237" || place === "111") return Response.json({ universeId: 383310974 });
    return new Response("{}", { status: 404 });
  }
  if (url.host === "games.roblox.com") {
    return Response.json({ data: [{ id: 383310974, rootPlaceId: 920587237, name: "Adopt Me!", description: "Raise pets", creator: { name: "Uplift Games", type: "Group" }, maxPlayers: 48, genre: "Town and City" }] });
  }
  if (url.host === "thumbnails.roblox.com" && url.pathname.endsWith("/icons")) return Response.json({ data: [{ targetId: 383310974, state: "Completed", imageUrl: "https://tr.rbxcdn.com/icon.png" }] });
  if (url.host === "thumbnails.roblox.com") return Response.json({ data: [{ universeId: 383310974, thumbnails: [{ imageUrl: "https://tr.rbxcdn.com/shot.png" }] }] });
  // Roblox's image servers don't always say image/*: the bytes decide.
  if (url.host === "tr.rbxcdn.com") return new Response(url.pathname === "/icon.png" ? ICON_PNG : SHOT_JPEG, { headers: { "content-type": "binary/octet-stream" } });
  if (url.pathname.endsWith("/get-age-recommendation")) {
    assert.deepEqual(JSON.parse(String(init?.body)), { universeId: "383310974" });
    return Response.json({ ageRecommendationDetails: { ageRecommendationSummary: { ageRecommendation: { displayName: "Ages 9+", minimumAge: 9 } } } });
  }
  throw new Error(`Unexpected network call in test: ${url}`);
}) as typeof fetch;

describe("Roblox games", () => {
  it("reads place ids from links and opens only Roblox links as Roblox", () => {
    assert.equal(parseRobloxPlace("920587237"), "920587237");
    assert.equal(parseRobloxPlace("https://www.roblox.com/games/920587237/Adopt-Me"), "920587237");
    assert.equal(parseRobloxPlace("https://www.roblox.com/de/games/920587237"), "920587237");
    assert.equal(parseRobloxPlace("https://www.roblox.com/games/start?placeId=920587237&launchData=x"), "920587237");
    assert.equal(parseRobloxPlace("roblox://placeId=920587237"), "920587237");
    assert.equal(parseRobloxPlace("https://example.com/games/920587237"), null);
    assert.equal(parseRobloxPlace("Adopt Me"), null);
    assert.equal(robloxPlaceOf("roblox://experiences/start?placeId=920587237"), "920587237");
    assert.equal(robloxPlaceOf("steam://rungameid/620"), null);
    assert.ok(isStoreLaunchUrl("roblox://experiences/start?placeId=1"));
    assert.equal(ageRatingOf({ ageRecommendationDetails: { summary: { ageRecommendation: { displayName: "All Ages" } } } }), "All Ages");
    assert.equal(ageRatingOf({}), null);
  });

  it("lets an admin add a game by link and shows it only to the profiles they picked", async () => {
    const { app, ctx } = await makeApp(root, {}, { fetchImpl: roblox });
    const admin = await person(app, ctx, "mum", { role: "admin" });
    const kid = await person(app, ctx, "sam", { kidMode: true });
    const other = await person(app, ctx, "max", { kidMode: true });

    // A link to one of the experience's other places still adds the experience and plays its start place.
    const added = await app.inject({ method: "POST", url: "/api/roblox", headers: admin.headers, payload: { input: "https://www.roblox.com/games/111/sub-place", userIds: [kid.id, 9999] } });
    assert.equal(added.statusCode, 200, added.body);
    const g = added.json();
    assert.equal(g.universeId, "383310974");
    assert.equal(g.placeId, "920587237");
    assert.equal(g.name, "Adopt Me!");
    assert.equal(g.creator, "Uplift Games");
    assert.equal(g.iconUrl, "https://tr.rbxcdn.com/icon.png");
    assert.equal(g.thumbnailUrl, "https://tr.rbxcdn.com/shot.png");
    assert.equal(g.ageRating, "Ages 9+");
    assert.deepEqual(g.userIds, [kid.id], "ids that aren't profiles are dropped");

    // The picked kid sees it with their other stores' games; the other kid doesn't.
    const mine = (await app.inject({ url: "/api/store-games", headers: kid.headers })).json();
    assert.equal(mine.length, 1);
    assert.equal(mine[0].addon, "roblox");
    assert.equal(mine[0].store, "Roblox");
    assert.equal(mine[0].launchUrl, "roblox://experiences/start?placeId=920587237");
    assert.equal(mine[0].storeUrl, "https://www.roblox.com/games/920587237");
    assert.equal((await app.inject({ url: "/api/store-games?addon=roblox", headers: kid.headers })).json().length, 1, "the Roblox filter");
    assert.equal((await app.inject({ url: "/api/store-games?addon=steam", headers: kid.headers })).json().length, 0);
    assert.deepEqual((await app.inject({ url: "/api/store-games", headers: other.headers })).json(), []);

    // Its page comes from Roblox, not a title search, and only for people it's shown to.
    const page = (await app.inject({ url: "/api/store-games/roblox/383310974", headers: kid.headers })).json();
    assert.equal(page.info.summary, "Raise pets");
    assert.deepEqual(page.info.developers, ["Uplift Games"]);
    assert.deepEqual(page.info.ageRatings, [{ organization: "Roblox", rating: "Ages 9+" }]);
    assert.equal(page.backgroundUrl, "https://tr.rbxcdn.com/shot.png");
    assert.equal((await app.inject({ url: "/api/store-games/roblox/383310974", headers: other.headers })).statusCode, 404);
    // The cover is a portrait poster with Roblox's square icon and wide screenshot inside it.
    assert.match(mine[0].coverUrl, /^\/api\/store-games\/roblox\/383310974\/cover\?v=[0-9a-f]{10}$/);
    assert.equal(page.coverUrl, mine[0].coverUrl);
    const cover = await app.inject({ url: mine[0].coverUrl, headers: kid.headers });
    assert.equal(cover.statusCode, 200);
    assert.match(String(cover.headers["content-type"]), /^image\/svg\+xml/);
    assert.match(cover.body, /viewBox="0 0 600 900"/);
    assert.ok(cover.body.includes(`href="data:image/png;base64,${ICON_PNG.toString("base64")}"`), "the icon, inlined");
    assert.ok(cover.body.includes(`href="data:image/jpeg;base64,${SHOT_JPEG.toString("base64")}"`), "the screenshot, inlined");
    assert.match(String(cover.headers["cache-control"]), /max-age=604800/);
    assert.match(cover.body, />Adopt Me!</);
    assert.ok(!cover.body.includes("rbxcdn.com"), "nothing for the browser to fetch");
    assert.equal((await app.inject({ url: mine[0].coverUrl, headers: other.headers })).statusCode, 404);
    const bg = await app.inject({ url: "/api/store-games/roblox/383310974/background", headers: kid.headers });
    assert.equal(bg.headers.location, "https://tr.rbxcdn.com/shot.png");

    // An admin's own cover replaces the poster, for everyone who sees the game; removing it brings the poster back.
    const png = Buffer.concat([ICON_PNG, Buffer.from("custom")]);
    assert.equal((await app.inject({ method: "PUT", url: "/api/roblox/383310974/cover", headers: { ...kid.headers, "content-type": "image/png" }, payload: png })).statusCode, 403);
    assert.equal((await app.inject({ method: "PUT", url: "/api/roblox/383310974/cover", headers: { ...admin.headers, "content-type": "text/plain" }, payload: "nope" })).statusCode, 400);
    const up = await app.inject({ method: "PUT", url: "/api/roblox/383310974/cover", headers: { ...admin.headers, "content-type": "image/png" }, payload: png });
    assert.equal(up.statusCode, 200, up.body);
    assert.ok(up.json().customCover);
    const after = (await app.inject({ url: "/api/store-games", headers: kid.headers })).json()[0];
    assert.notEqual(after.coverUrl, mine[0].coverUrl, "a new address, so browsers drop the poster");
    const own = await app.inject({ url: after.coverUrl, headers: kid.headers });
    assert.equal(own.headers["content-type"], "image/png");
    assert.deepEqual(own.rawPayload, png);
    const cleared = await app.inject({ method: "DELETE", url: "/api/roblox/383310974/cover", headers: admin.headers });
    assert.equal(cleared.json().customCover, null);
    assert.match(String((await app.inject({ url: (await app.inject({ url: "/api/store-games", headers: kid.headers })).json()[0].coverUrl, headers: kid.headers })).headers["content-type"]), /svg/);
    assert.equal((await app.inject({ method: "PUT", url: "/api/store-games/roblox/383310974", headers: kid.headers, payload: { title: "Mine" } })).statusCode, 400, "nothing to rematch");

    // Everyone, then removed.
    const all = await app.inject({ method: "PUT", url: "/api/roblox/383310974", headers: admin.headers, payload: { everyone: true } });
    assert.equal(all.json().everyone, true);
    assert.equal((await app.inject({ url: "/api/store-games", headers: other.headers })).json().length, 1);
    await app.inject({ method: "DELETE", url: "/api/roblox/383310974", headers: admin.headers });
    assert.deepEqual((await app.inject({ url: "/api/store-games", headers: kid.headers })).json(), []);
  });

  it("is admins only, and says when a place doesn't exist", async () => {
    const { app, ctx } = await makeApp(root, {}, { fetchImpl: roblox });
    const admin = await person(app, ctx, "dad", { role: "admin" });
    const kid = await person(app, ctx, "ash", { kidMode: true });
    assert.equal((await app.inject({ method: "POST", url: "/api/roblox", headers: kid.headers, payload: { input: "920587237" } })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/roblox", headers: kid.headers })).statusCode, 403);
    const missing = await app.inject({ method: "POST", url: "/api/roblox", headers: admin.headers, payload: { input: "5" } });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().error, /no game with that place ID/);
    const junk = await app.inject({ method: "POST", url: "/api/roblox", headers: admin.headers, payload: { input: "Adopt Me" } });
    assert.match(junk.json().error, /Paste a Roblox game link/);
    const looked = (await app.inject({ method: "POST", url: "/api/roblox/lookup", headers: admin.headers, payload: { input: "920587237" } })).json();
    assert.equal(looked.name, "Adopt Me!");
    assert.deepEqual((await app.inject({ url: "/api/roblox", headers: admin.headers })).json(), [], "looking up doesn't add");
  });
});

describe("Roblox posters", () => {
  it("wraps long names, escapes them, and only fetches from Roblox's image servers", async () => {
    assert.deepEqual(titleLines("Adopt Me!", 16), ["Adopt Me!"]);
    assert.deepEqual(titleLines("Work at a Pizza Place", 12), ["Work at a", "Pizza Place"]);
    assert.equal(titleLines("one two three four five six seven", 5).length, 3);
    assert.match(titleLines("one two three four five six seven", 5)[2]!, /…$/);
    const svg = posterSvg({ universeId: "1", name: `<script>"x"</script> & co` }, null, null);
    assert.ok(!svg.includes("<script>"));
    assert.match(svg, /&#60;script&#62;/);

    const fetched: string[] = [];
    const posters = new RobloxPosters((async (u: string | URL | Request) => {
      fetched.push(String(u));
      return new Response(ICON_PNG, { headers: { "content-type": "image/png" } });
    }) as typeof fetch);
    const g = { universeId: "2", placeId: "3", name: "Test", description: null, creator: null, iconUrl: "https://evil.example/icon.png", thumbnailUrl: "https://t1.rbxcdn.com/shot.png", ageRating: null, genre: null, maxPlayers: null, customCover: null, everyone: true, userIds: [], addedAt: "", refreshedAt: "" };
    const out = await posters.poster(g);
    assert.deepEqual(fetched, ["https://t1.rbxcdn.com/shot.png"]);
    assert.ok(out.pictures);
    assert.equal((out.svg.match(/data:image\/png/g) ?? []).length, 2, "the screenshot (href and xlink:href); no icon");

    // An error page instead of a picture: no pictures, so the route falls back.
    const broken = new RobloxPosters((async () => new Response("<html>denied</html>", { headers: { "content-type": "image/png" } })) as typeof fetch);
    assert.equal((await broken.poster({ ...g, iconUrl: "https://tr.rbxcdn.com/a.png" })).pictures, false);
    assert.equal(imageType(Buffer.from("RIFF0000WEBPVP8 ")), "image/webp");
    assert.equal(imageType(Buffer.from("GIF89a..")), "image/gif");
    assert.equal(imageType(Buffer.from("<html>")), null);
  });
});
