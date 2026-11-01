import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import type { LibraryAddon } from "../src/addons/types.js";
import { looseTitle } from "../src/users/achievements.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

const fake = (id: string, keys: string[]): LibraryAddon => ({
  id,
  name: id,
  description: "For tests",
  fields: keys.map((key) => ({ key, label: key, required: true })),
  games: async () => [],
});

const calls: string[] = [];
const web = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  calls.push(url.pathname);
  if (url.pathname.endsWith("/GetSchemaForGame/v2/")) {
    return Response.json({
      game: {
        gameName: "Portal 2",
        availableGameStats: {
          achievements: [
            { name: "WAKE_UP", displayName: "Wake Up Call", description: "Survive the manual", icon: "https://i/wake.jpg", icongray: "https://i/wake-g.jpg" },
            { name: "SECRET", displayName: "Secret", description: "Spoiler", icon: "https://i/s.jpg", icongray: "https://i/s-g.jpg", hidden: 1 },
          ],
        },
      },
    });
  }
  if (url.pathname.endsWith("/GetPlayerAchievements/v1/")) {
    return Response.json({ playerstats: { success: true, achievements: [{ apiname: "WAKE_UP", achieved: 1, unlocktime: 1_700_000_000 }, { apiname: "SECRET", achieved: 0, unlocktime: 0 }] } });
  }
  if (url.pathname.endsWith("/GetGlobalAchievementPercentagesForApp/v2/")) {
    return Response.json({ achievementpercentages: { achievements: [{ name: "WAKE_UP", percent: "91.23" }, { name: "SECRET", percent: 3.4 }] } });
  }
  if (url.pathname.endsWith("/API_GetUserCompletionProgress.php")) {
    return Response.json({ Results: [{ GameID: 228, Title: "Super Mario World", ConsoleName: "SNES" }] });
  }
  if (url.pathname.endsWith("/API_GetGameInfoAndUserProgress.php")) {
    return Response.json({
      Title: "Super Mario World",
      NumDistinctPlayers: 200,
      Achievements: {
        "1": { ID: 1, Title: "Yoshi!", Description: "Find Yoshi", Points: 5, BadgeName: "100", DateEarned: "2026-10-01 18:20:00", NumAwarded: 150 },
        "2": { ID: 2, Title: "Star Road", Description: "Find it", Points: 10, BadgeName: "101", NumAwarded: 20 },
      },
    });
  }
  throw new Error(`Unexpected network call in test: ${url}`);
}) as typeof fetch;

async function person(app: Awaited<ReturnType<typeof makeApp>>["app"], ctx: Awaited<ReturnType<typeof makeApp>>["ctx"], username: string) {
  const user = await ctx.users.create({ username, password: "password123", role: "user" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
  return { user, headers: { cookie: `gm_session=${login.cookies.find((c) => c.name === "gm_session")!.value}` } };
}

describe("game achievements", () => {
  it("matches titles loosely", () => {
    assert.equal(looseTitle("Super Mario World (USA) [!]"), looseTitle("Super Mario World"));
    assert.equal(looseTitle("Legend of Zelda, The"), looseTitle("The Legend of Zelda"));
  });

  it("shows Steam achievements with rarity, keeps hidden ones secret and caches them", async () => {
    const { app, ctx } = await makeApp(root, {}, { fetchImpl: web, addons: [fake("steam", ["steamId", "apiKey"])], resolveHost: async () => ["93.184.216.34"] });
    const sam = await person(app, ctx, "sam");
    const before = (await app.inject({ url: "/api/store-games/steam/620/achievements", headers: sam.headers })).json();
    assert.equal(before.achievements, null);
    assert.equal(before.wants, "steam", "asks for Steam to be connected");

    await ctx.addons.connect(sam.user.id, "steam", { steamId: "76561197960287930", apiKey: "k" });
    const res = (await app.inject({ url: "/api/store-games/steam/620/achievements", headers: sam.headers })).json();
    assert.equal(res.error, null);
    assert.equal(res.achievements.unlocked, 1);
    assert.equal(res.achievements.total, 2);
    const [first, second] = res.achievements.items;
    assert.equal(first.name, "Wake Up Call");
    assert.equal(first.rarity, 91.2);
    assert.equal(first.unlockedAt, new Date(1_700_000_000_000).toISOString());
    assert.equal(second.description, "Hidden achievement");
    assert.equal(second.iconUrl, "https://i/s-g.jpg");

    const n = calls.length;
    await app.inject({ url: "/api/store-games/steam/620/achievements", headers: sam.headers });
    assert.equal(calls.length, n, "kept for a while");
    await app.inject({ url: "/api/store-games/steam/620/achievements?refresh=1", headers: sam.headers });
    assert.ok(calls.length > n, "Refresh asks again");

    const summary = (await app.inject({ url: "/api/me/achievements", headers: sam.headers })).json();
    assert.deepEqual(summary.connected, ["steam"]);
    assert.equal(summary.unlocked, 1);
    assert.equal(summary.recent[0].name, "Wake Up Call");
    assert.equal(summary.games[0].link, "/store/steam/620");
    const board = (await app.inject({ url: "/api/family/achievements", headers: sam.headers })).json();
    assert.equal(board[0].name, "sam");
    assert.equal(board[0].unlocked, 1);
  });

  it("finds an emulated game's RetroAchievements by title", async () => {
    const { app, ctx } = await makeApp(root, {}, { fetchImpl: web, addons: [fake("retroachievements", ["username", "apiKey"])], resolveHost: async () => ["93.184.216.34"] });
    const kim = await person(app, ctx, "kim");
    await ctx.addons.connect(kim.user.id, "retroachievements", { username: "kim", apiKey: "k" });
    const a = await ctx.achievements.retro(kim.user.id, "Super Mario World (USA)", "/games/x");
    assert.equal(a?.source, "retroachievements");
    assert.equal(a?.unlocked, 1);
    const yoshi = a?.items.find((i) => i.name === "Yoshi!");
    assert.equal(yoshi?.unlockedAt, "2026-10-01T18:20:00.000Z");
    assert.equal(yoshi?.points, 5);
    assert.equal(yoshi?.rarity, 75);
    assert.equal(a?.items.find((i) => i.name === "Star Road")?.iconUrl, "https://media.retroachievements.org/Badge/101_lock.png");
    assert.equal(await ctx.achievements.retro(kim.user.id, "Some Other Game", null), null);
  });
});

describe("play history, ratings and completion", () => {
  it("lists a game's sessions and the person's play over time", async () => {
    const { app, ctx } = await makeApp(root);
    const lee = await person(app, ctx, "lee");
    const game = ctx.library.list({})[0]!;
    ctx.family.recordSession(lee.user.id, game.id, "DEN-PC", 3600);
    ctx.family.recordSession(lee.user.id, game.id, "ALLY", 1800);
    const s = (await app.inject({ url: `/api/games/${game.id}/sessions`, headers: lee.headers })).json();
    assert.equal(s.count, 2);
    assert.equal(s.totalSeconds, 5400);
    assert.equal(s.averageSeconds, 2700);
    assert.equal(s.longestSeconds, 3600);
    const h = (await app.inject({ url: "/api/me/play-history?days=7&tz=Europe/London", headers: lee.headers })).json();
    assert.equal(h.perDay.length, 7);
    assert.equal(h.totalSeconds, 5400);
    assert.equal(h.perDay.reduce((n: number, d: { seconds: number }) => n + d.seconds, 0), 5400);
    assert.deepEqual(
      h.devices.map((d: { name: string }) => d.name),
      ["DEN-PC", "ALLY"],
    );
    assert.equal(h.games[0].title, game.title);
  });

  it("rates other stores' games and knows Completed 100%", async () => {
    const { app, ctx } = await makeApp(root);
    const ash = await person(app, ctx, "ash");
    const put = await app.inject({ method: "PUT", url: `/api/games/${encodeURIComponent("store:steam:620")}/journal`, headers: ash.headers, payload: { status: "completed", rating: 5 } });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().status, "completed");
    assert.equal(put.json().rating, 5);
    const bad = await app.inject({ method: "PUT", url: `/api/games/not-a-game/journal`, headers: ash.headers, payload: { rating: 3 } });
    assert.equal(bad.statusCode, 404, "library ids still have to exist");
  });
});
