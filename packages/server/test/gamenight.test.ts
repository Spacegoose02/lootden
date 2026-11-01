import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import type { GameNight, GameNightPick } from "@lootden/shared";
import { makeApp, makeLibrary, sessionCookie } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

type App = Awaited<ReturnType<typeof makeApp>>;

async function person(app: App["app"], ctx: App["ctx"], username: string, extra: { role?: "admin" | "user"; kidMode?: boolean } = {}) {
  const user = await ctx.users.create({ username, password: "password123", displayName: username[0]!.toUpperCase() + username.slice(1), ...extra });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
  return { id: user.id, headers: { cookie: sessionCookie(login) } };
}

const nextWeek = () => new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

describe("game night", () => {
  it("suggests games to play together, installed ones first, kid-safe when kids play", async () => {
    const { app, ctx } = await makeApp(root);
    const mom = await person(app, ctx, "mom", { role: "admin" });
    const kid = await person(app, ctx, "max", { kidMode: true });
    ctx.family.saveSettings({ timeZone: "UTC" });
    const games = ctx.library.list({});
    const [a, b] = [games[0]!, games[1]!];
    // Make two games co-op; one installed for both players, one kid-safe.
    await app.inject({ method: "PATCH", url: `/api/games/${a.id}`, headers: mom.headers, payload: { together: ["couch"], kidSafe: true } });
    await app.inject({ method: "PATCH", url: `/api/games/${b.id}`, headers: mom.headers, payload: { together: ["online"], kidSafe: false } });
    for (const who of [mom, kid]) await app.inject({ method: "POST", url: "/api/me/activity", headers: who.headers, payload: { gameId: a.id, device: "PC", event: "installed" } });

    assert.equal((await app.inject({ method: "POST", url: "/api/game-nights/suggest", headers: mom.headers, payload: { players: [] } })).statusCode, 400);
    const grownUps = (await app.inject({ method: "POST", url: "/api/game-nights/suggest", headers: mom.headers, payload: { players: [mom.id] } })).json() as GameNightPick[];
    assert.ok(grownUps.length >= 2, "one player: anything goes");
    const withKid = (await app.inject({ method: "POST", url: "/api/game-nights/suggest", headers: mom.headers, payload: { players: [mom.id, kid.id] } })).json() as GameNightPick[];
    assert.deepEqual(withKid.map((g) => g.id), [a.id], "together games only, kid-safe with a kid playing");
    assert.ok(withKid[0]!.reasons.includes("Installed for everyone"));
    assert.ok(withKid[0]!.reasons.includes("Everyone on one screen"));
  });

  it("plans nights, and shares them as a calendar feed", async () => {
    const { app, ctx } = await makeApp(root);
    const mom = await person(app, ctx, "mama", { role: "admin" });
    const kid = await person(app, ctx, "lily", { kidMode: true });
    ctx.family.saveSettings({ timeZone: "UTC" });
    const game = ctx.library.list({})[0]!;
    assert.equal((await app.inject({ method: "POST", url: "/api/game-nights", headers: kid.headers, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/game-nights", headers: mom.headers, payload: { date: "2020-01-01", players: [kid.id] } })).statusCode, 400);
    const made = await app.inject({ method: "POST", url: "/api/game-nights", headers: mom.headers, payload: { date: nextWeek(), time: "18:30", players: [mom.id, kid.id], gameId: game.id, note: "Pizza!" } });
    assert.equal(made.statusCode, 200);
    const night = made.json() as GameNight;
    assert.equal(night.title, "🎮 Family game night");
    assert.deepEqual(night.players.map((p) => p.name), ["Mama", "Lily"]);

    const seen = (await app.inject({ url: "/api/game-nights", headers: kid.headers })).json() as { upcoming: GameNight[]; feed: string | null; canPlan: boolean };
    assert.equal(seen.upcoming.length, 1);
    assert.equal(seen.feed, null);
    assert.equal(seen.canPlan, false);
    const admin = (await app.inject({ url: "/api/game-nights", headers: mom.headers })).json() as { feed: string };
    const ics = await app.inject({ url: admin.feed });
    assert.equal(ics.statusCode, 200, "the feed needs no sign-in");
    assert.match(ics.body, /SUMMARY:🎮 Family game night/);
    assert.match(ics.body, new RegExp(`DTSTART;TZID=UTC:${nextWeek().replace(/-/g, "")}T183000`));
    assert.match(ics.body, /Pizza!/);
    assert.equal((await app.inject({ url: "/api/game-nights/feed/wrong/game-nights.ics" })).statusCode, 404);
    const reset = (await app.inject({ method: "POST", url: "/api/game-nights/feed/reset", headers: mom.headers })).json() as { feed: string };
    assert.equal((await app.inject({ url: admin.feed })).statusCode, 404, "an old address stops working");
    assert.equal((await app.inject({ url: reset.feed })).statusCode, 200);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/game-nights/${night.id}`, headers: mom.headers })).statusCode, 200);
  });
});
