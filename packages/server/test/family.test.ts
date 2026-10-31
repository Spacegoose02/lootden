import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { cleanLimits, computeAllowance, levelFor, lockedPart, parseRaccoonSeed, raccoonSeed, secondsLeft, togetherFromMetadata, zonedParts } from "@lootden/shared";
import { avatarSvg } from "../src/users/avatars.js";
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

const gameId = (ctx: App["ctx"], title: RegExp) => ctx.library.list({}).find((g) => title.test(g.title))!.id;

describe("play time limits", () => {
  it("works out what's left today from the daily limit, bonus time and bedtime", () => {
    const limits = cleanLimits({ weekdayMinutes: 60, weekendMinutes: "120", bedtime: { from: "21:00", to: "7:00" }, hardStop: true, junk: 1 });
    assert.deepEqual(limits, { weekdayMinutes: 60, weekendMinutes: 120, bedtime: { from: "21:00", to: "07:00" }, hardStop: true });
    assert.equal(cleanLimits({ bedtime: { from: "25:00", to: "07:00" } }).bedtime, null, "nonsense times are dropped");

    // Wednesday 2026-10-28, 18:30 UTC.
    const wed = new Date("2026-10-28T18:30:00Z");
    const a = computeAllowance(limits, 50 * 60, 0, wed, "UTC");
    assert.equal(a.date, "2026-10-28");
    assert.equal(a.remainingSeconds, 10 * 60);
    assert.equal(a.canPlay, true);
    assert.equal(a.bedtimeInSeconds, 150 * 60);
    assert.equal(secondsLeft(a), 10 * 60, "the daily time runs out before bedtime");
    const over = computeAllowance(limits, 61 * 60, 0, wed, "UTC");
    assert.equal(over.canPlay, false);
    assert.match(over.reason!, /all the play time/);
    assert.equal(computeAllowance(limits, 61 * 60, 15 * 60, wed, "UTC").remainingSeconds, 14 * 60, "bonus time adds to today");
    // Saturday gets the weekend limit; 22:00 is bedtime, and so is 06:59 the next morning.
    assert.equal(computeAllowance(limits, 0, 0, new Date("2026-10-31T12:00:00Z"), "UTC").allowedSeconds, 120 * 60);
    assert.equal(computeAllowance(limits, 0, 0, new Date("2026-10-28T22:00:00Z"), "UTC").bedtimeNow, true);
    assert.equal(computeAllowance(limits, 0, 0, new Date("2026-10-29T06:59:00Z"), "UTC").bedtimeNow, true);
    assert.equal(computeAllowance(limits, 0, 0, new Date("2026-10-29T07:00:00Z"), "UTC").bedtimeNow, false);
    // Days follow the household's time zone.
    assert.equal(zonedParts(new Date("2026-10-29T02:00:00Z"), "America/New_York").date, "2026-10-28");
  });

  it("keeps games in the browser to play time too", async () => {
    const { app, ctx } = await makeApp(root);
    const admin = await person(app, ctx, "papa", { role: "admin" });
    const kid = await person(app, ctx, "lea");
    ctx.family.saveSettings({ timeZone: "UTC" });
    const portal = gameId(ctx, /portal/i);
    await app.inject({ method: "PUT", url: `/api/users/${kid.id}/limits`, headers: admin.headers, payload: { weekdayMinutes: 10, weekendMinutes: 10 } });
    assert.equal((await app.inject({ url: `/api/games/${portal}/play`, headers: kid.headers })).statusCode, 400, "time left: Portal just isn't a browser game");
    await app.inject({ method: "POST", url: "/api/me/activity", headers: kid.headers, payload: { gameId: portal, device: "PC", event: "played", seconds: 10 * 60 } });
    const blocked = await app.inject({ url: `/api/games/${portal}/play`, headers: kid.headers });
    assert.equal(blocked.statusCode, 403);
    assert.match(blocked.json().error, /play time/);
  });

  it("counts sessions, lets kids ask for bonus time and admins grant it", async () => {
    const { app, ctx } = await makeApp(root);
    const admin = await person(app, ctx, "mum", { role: "admin" });
    const kid = await person(app, ctx, "sam", { kidMode: true });
    ctx.family.saveSettings({ timeZone: "UTC" });
    const portal = gameId(ctx, /portal/i);

    assert.equal((await app.inject({ method: "PUT", url: `/api/users/${kid.id}/limits`, headers: kid.headers, payload: { weekdayMinutes: 30 } })).statusCode, 403);
    const set = await app.inject({ method: "PUT", url: `/api/users/${kid.id}/limits`, headers: admin.headers, payload: { weekdayMinutes: 30, weekendMinutes: 30 } });
    assert.equal(set.json().limits.weekdayMinutes, 30);

    const played = await app.inject({ method: "POST", url: "/api/me/activity", headers: kid.headers, payload: { gameId: portal, device: "PC", event: "played", seconds: 20 * 60 } });
    assert.equal(played.statusCode, 200);
    let allowance = (await app.inject({ url: "/api/me/allowance", headers: kid.headers })).json();
    assert.equal(allowance.usedSeconds, 20 * 60);
    assert.equal(allowance.remainingSeconds, 10 * 60);
    assert.equal(allowance.separateSaves, true);
    // A session reported late (the PC was offline) counts on the day it happened.
    await app.inject({ method: "POST", url: "/api/me/activity", headers: kid.headers, payload: { gameId: portal, device: "PC", event: "played", seconds: 600, endedAt: new Date(Date.now() - 3 * 86400_000).toISOString() } });
    assert.equal((await app.inject({ url: "/api/me/allowance", headers: kid.headers })).json().usedSeconds, 20 * 60);

    const ask = await app.inject({ method: "POST", url: "/api/time-requests", headers: kid.headers, payload: { minutes: 15, note: "one more level" } });
    assert.equal(ask.statusCode, 200);
    assert.equal(ask.json().state, "pending");
    assert.equal((await app.inject({ method: "POST", url: "/api/time-requests", headers: kid.headers, payload: { minutes: 15 } })).statusCode, 400, "one open ask at a time");
    assert.equal((await app.inject({ method: "POST", url: "/api/time-requests", headers: admin.headers, payload: { minutes: 1 } })).statusCode, 400, "5 minutes at least");
    const alert = ctx.db.prepare("SELECT title FROM notifications WHERE kind = 'requests'").get() as { title: string };
    assert.equal(alert.title, "Sam asked for 15 more minutes");

    assert.equal((await app.inject({ method: "POST", url: `/api/time-requests/${ask.json().id}/approve`, headers: kid.headers })).statusCode, 403);
    const yes = await app.inject({ method: "POST", url: `/api/time-requests/${ask.json().id}/approve`, headers: admin.headers, payload: { minutes: 20 } });
    assert.equal(yes.json().state, "approved");
    assert.equal(yes.json().minutes, 20, "admins can grant a different amount");
    allowance = (await app.inject({ url: "/api/me/allowance", headers: kid.headers })).json();
    assert.equal(allowance.remainingSeconds, 30 * 60);

    const given = await app.inject({ method: "POST", url: `/api/users/${kid.id}/bonus`, headers: admin.headers, payload: { minutes: 10 } });
    assert.equal(given.json().allowance.bonusSeconds, 30 * 60);
    const party = (await app.inject({ url: "/api/me/celebrations", headers: kid.headers })).json();
    assert.deepEqual(party.bonus.map((b: { minutes: number }) => b.minutes).sort(), [10, 20]);
    assert.equal((await app.inject({ url: "/api/time-requests", headers: kid.headers })).json().length, 2, "kids see their own");
    await app.close();
  });
});

describe("achievements and levels", () => {
  it("unlocks badges from play, celebrates them once, and gates raccoon parts by level", async () => {
    const { app, ctx } = await makeApp(root);
    const ana = await person(app, ctx, "ana");
    const portal = gameId(ctx, /portal/i);

    let progress = (await app.inject({ url: "/api/me/progress", headers: ana.headers })).json();
    assert.equal(progress.level.level, 1);
    assert.equal(progress.achievements.find((a: { id: string }) => a.id === "first-play").unlockedAt, null);

    await app.inject({ method: "POST", url: "/api/me/activity", headers: ana.headers, payload: { gameId: portal, device: "PC", event: "installed" } });
    await app.inject({ method: "POST", url: "/api/me/activity", headers: ana.headers, payload: { gameId: portal, device: "PC", event: "played", seconds: 3 * 3600 + 60 } });
    for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/api/me/roulette", headers: ana.headers });
    progress = (await app.inject({ url: "/api/me/progress", headers: ana.headers })).json();
    const unlocked = progress.achievements.filter((a: { unlockedAt: string | null }) => a.unlockedAt).map((a: { id: string }) => a.id);
    for (const id of ["first-install", "first-play", "marathon", "lucky"]) assert.ok(unlocked.includes(id), `${id} unlocked`);
    assert.equal(progress.level.xp, 50 + 50 + 100 + 50 + 3 * 10 + 15, "badges, hours and games played add up");
    assert.equal(progress.level.level, 2);

    const party = (await app.inject({ url: "/api/me/celebrations", headers: ana.headers })).json();
    assert.ok(party.achievements.length >= 4);
    // The screen showed only the first badge: the rest still get their moment.
    const [first] = party.achievements as Array<{ id: string }>;
    await app.inject({ method: "POST", url: "/api/me/celebrations/seen", headers: ana.headers, payload: { achievements: [first!.id], wishes: [], bonus: [] } });
    const rest = (await app.inject({ url: "/api/me/celebrations", headers: ana.headers })).json().achievements as Array<{ id: string }>;
    assert.equal(rest.length, party.achievements.length - 1);
    assert.ok(!rest.some((a) => a.id === first!.id));
    await app.inject({ method: "POST", url: "/api/me/celebrations/seen", headers: ana.headers });
    assert.equal((await app.inject({ url: "/api/me/celebrations", headers: ana.headers })).json().achievements.length, 0, "celebrated once");

    // Built raccoons: starter parts for anyone, the Flame crown at level 11.
    const starter = raccoonSeed({ fur: 3, palette: 2, eyes: 1, mouth: 0, accessory: 5 });
    assert.equal((await app.inject({ method: "PATCH", url: "/api/me", headers: ana.headers, payload: { avatar: starter } })).json().avatar, starter);
    const crown = raccoonSeed({ fur: 0, palette: 0, eyes: 0, mouth: 0, accessory: 18 });
    const no = await app.inject({ method: "PATCH", url: "/api/me", headers: ana.headers, payload: { avatar: crown } });
    assert.equal(no.statusCode, 403);
    assert.match(no.json().error, /Flame crown unlocks at level 11/);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/me", headers: ana.headers, payload: { avatar: "b-99-0-0-0-0" } })).statusCode, 400);

    const card = (await app.inject({ url: `/api/users/${ana.id}/card`, headers: ana.headers })).json();
    assert.equal(card.avatar, starter);
    assert.ok(card.achievements.every((a: { unlockedAt: string | null }) => a.unlockedAt));
    await app.close();
  });

  it("draws built raccoons and keeps random ones stable", () => {
    assert.equal(levelFor(0).level, 1);
    assert.equal(levelFor(100).level, 2);
    assert.equal(levelFor(299).level, 2);
    assert.equal(levelFor(300).rank, "Den Explorer");
    assert.deepEqual(parseRaccoonSeed("b-1-2-3-4-5"), { fur: 1, palette: 2, eyes: 3, mouth: 4, accessory: 5 });
    assert.equal(parseRaccoonSeed("b-1-2-3-4-99"), null);
    assert.deepEqual(lockedPart({ fur: 11, palette: 0, eyes: 0, mouth: 0, accessory: 0 }, 5), { part: "fur", name: "Neon", level: 12 });
    assert.equal(avatarSvg("abc123"), avatarSvg("abc123"));
    assert.match(avatarSvg("b-9-11-0-0-17"), /^<svg/);
    // A random seed never shows an unlockable part.
    for (let i = 0; i < 200; i++) assert.doesNotMatch(avatarSvg(`seed${i}`), /#ff7a1a|#ffe27a/);
  });
});

describe("wish granted", () => {
  it("celebrates a requested game once it's in the library, but not ones from before", async () => {
    const { app, ctx } = await makeApp(root);
    const kid = await person(app, ctx, "sam", { kidMode: true });
    // A request from an older LootDen: already in the library, so no party.
    await app.inject({ method: "POST", url: "/api/requests", headers: kid.headers, payload: { title: "Portal 2" } });
    ctx.db.prepare("UPDATE game_requests SET celebrated_at = 'legacy'").run();
    assert.equal((await app.inject({ url: "/api/me/celebrations", headers: kid.headers })).json().wishes.length, 0);
    // A new one that's ready: one party.
    ctx.db.prepare("DELETE FROM game_requests").run();
    await app.inject({ method: "POST", url: "/api/requests", headers: kid.headers, payload: { title: "Portal 2" } });
    const party = (await app.inject({ url: "/api/me/celebrations", headers: kid.headers })).json();
    assert.equal(party.wishes.length, 1);
    assert.equal(party.wishes[0].title, "Portal 2");
    assert.ok(party.wishes[0].gameId);
    await app.inject({ method: "POST", url: "/api/me/celebrations/seen", headers: kid.headers });
    assert.equal((await app.inject({ url: "/api/me/celebrations", headers: kid.headers })).json().wishes.length, 0);
    await app.close();
  });
});

describe("play together", () => {
  it("tags games from metadata, lets admins correct them, and keeps the tags when filtering", async () => {
    assert.deepEqual(togetherFromMetadata(["Single player", "Split screen", "Co-operative"], ["Platform"]), ["couch", "split", "coop"]);
    assert.deepEqual(togetherFromMetadata(["Multiplayer"], ["Fighting"]), ["online", "party"]);
    assert.deepEqual(togetherFromMetadata(["Single player"], []), []);

    const { app, ctx } = await makeApp(root, { apiToken: "svc" });
    const portal = gameId(ctx, /portal/i);
    const svc = { authorization: "Bearer svc" };
    const set = await app.inject({ method: "PATCH", url: `/api/games/${portal}`, headers: svc, payload: { together: ["couch", "nonsense", "coop"] } });
    assert.deepEqual(set.json().together, ["couch", "coop"]);
    assert.deepEqual(set.json().overrides.together, ["couch", "coop"]);
    assert.deepEqual(ctx.library.list({}).find((g) => g.id === portal)!.together, ["couch", "coop"]);
    const auto = await app.inject({ method: "PATCH", url: `/api/games/${portal}`, headers: svc, payload: { together: null } });
    assert.deepEqual(auto.json().together, []);
    assert.equal(auto.json().overrides.together, null);
    await app.close();
  });
});

describe("shelves", () => {
  it("keeps personal shelves private, household shelves for everyone, and kid shelves kid-safe", async () => {
    const { app, ctx } = await makeApp(root);
    const admin = await person(app, ctx, "mum", { role: "admin" });
    const kid = await person(app, ctx, "sam", { kidMode: true });
    const portal = gameId(ctx, /portal/i);
    const gta = gameId(ctx, /grand theft/i);
    ctx.library.setOverrides(portal, { kidSafe: true });

    assert.equal((await app.inject({ method: "POST", url: "/api/shelves", headers: kid.headers, payload: { name: "Family", household: true } })).statusCode, 400, "only admins make household shelves");
    const mine = (await app.inject({ method: "POST", url: "/api/shelves", headers: kid.headers, payload: { name: "My faves", emoji: "🦝" } })).json();
    assert.equal(mine.emoji, "🦝");
    assert.equal((await app.inject({ method: "PUT", url: `/api/shelves/${mine.id}/games/${portal}`, headers: kid.headers })).json().games.length, 1);
    assert.equal((await app.inject({ method: "PUT", url: `/api/shelves/${mine.id}/games/${gta}`, headers: kid.headers })).statusCode, 404, "kids can't shelve games they can't see");

    const family = (await app.inject({ method: "POST", url: "/api/shelves", headers: admin.headers, payload: { name: "Halloween picks", household: true, emoji: "<b>" } })).json();
    assert.equal(family.emoji, null, "icons are emoji, not markup");
    await app.inject({ method: "PUT", url: `/api/shelves/${family.id}/games/${portal}`, headers: admin.headers });
    await app.inject({ method: "PUT", url: `/api/shelves/${family.id}/games/${gta}`, headers: admin.headers });

    const seen = (await app.inject({ url: "/api/shelves", headers: kid.headers })).json();
    assert.deepEqual(seen.map((s: { name: string }) => s.name), ["Halloween picks", "My faves"]);
    assert.deepEqual(seen[0].games.map((g: { id: string }) => g.id), [portal], "kids only see kid-safe games on shelves");
    assert.deepEqual((await app.inject({ url: "/api/shelves", headers: admin.headers })).json().map((s: { name: string }) => s.name), ["Halloween picks"], "someone else's shelf is theirs alone");
    assert.equal((await app.inject({ method: "DELETE", url: `/api/shelves/${family.id}`, headers: kid.headers })).statusCode, 400);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/shelves/${mine.id}`, headers: admin.headers })).statusCode, 400);
    assert.deepEqual((await app.inject({ url: `/api/games/${portal}/shelves`, headers: kid.headers })).json().sort(), [mine.id, family.id].sort());
    await app.close();
  });
});

describe("weekly recap", () => {
  it("ranks the household by this week's play and hides grown-up games from kids", async () => {
    const { app, ctx } = await makeApp(root);
    const admin = await person(app, ctx, "mum", { role: "admin" });
    const kid = await person(app, ctx, "sam", { kidMode: true });
    ctx.family.saveSettings({ timeZone: "UTC" });
    const portal = gameId(ctx, /portal/i);
    const gta = gameId(ctx, /grand theft/i);
    ctx.library.setOverrides(portal, { kidSafe: true });
    await app.inject({ method: "POST", url: "/api/me/activity", headers: admin.headers, payload: { gameId: gta, device: "PC", event: "played", seconds: 7200 } });
    await app.inject({ method: "POST", url: "/api/me/activity", headers: kid.headers, payload: { gameId: portal, device: "PC", event: "played", seconds: 3600 } });

    const recap = (await app.inject({ url: "/api/family/recap", headers: admin.headers })).json();
    assert.deepEqual(recap.players.map((p: { name: string }) => p.name), ["Mum", "Sam"]);
    assert.equal(recap.totalSeconds, 10800);
    assert.equal(recap.topGame.id, gta);
    assert.equal(recap.players[1].topGame.id, portal);
    const forKid = (await app.inject({ url: "/api/family/recap", headers: kid.headers })).json();
    assert.equal(forKid.topGame.title, "A grown-up game");
    assert.equal(forKid.players[0].topGame.title, "A grown-up game");
    assert.equal(forKid.players[1].topGame.id, portal);
    const last = (await app.inject({ url: "/api/family/recap?weeksAgo=1", headers: admin.headers })).json();
    assert.equal(last.totalSeconds, 0);
    assert.ok(last.to < recap.from);
    await app.close();
  });
});
