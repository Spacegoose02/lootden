import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import type { Allowance, PresenceAnswer } from "@lootden/shared";
import type { DenDutyView } from "../src/users/denduty.js";
import { makeApp, makeLibrary, offlineFetch, sessionCookie } from "./helpers.js";

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

/** A stand-in for Den Duty's /api/v1 gaming endpoints. */
function fakeDenDuty() {
  const inAnHour = new Date(Date.now() + 3600_000).toISOString();
  const state = {
    today: "2026-11-01",
    kids: [
      { id: "kid-ava", name: "Ava", chores: { due: 3, done: 1, left: 2 }, locks: [] as unknown[], gameTime: [{ orderId: "o1", title: "30 min game time", icon: "🎮", minutes: 30, boughtAt: "2026-11-01T09:00:00Z" }] },
      { id: "kid-ben", name: "Ben", chores: { due: 1, done: 1, left: 0 }, locks: [{ id: "t1", what: "No Roblox", games: "roblox", endsAt: inAnHour }], gameTime: [] },
    ],
    familyGoalsReached: [{ id: "g1", title: "Trip to the zoo", icon: "🦁", reward: "Game night", reachedAt: "2026-10-31T18:00:00Z", done: false }],
  };
  const claimed = new Set<string>();
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("http://den.local:8081/")) return offlineFetch(input, init);
    calls.push(`${init?.method ?? "GET"} ${url.replace("http://den.local:8081", "")}`);
    if ((init?.headers as Record<string, string>).authorization !== "Bearer dnk_good") return new Response("{}", { status: 403 });
    if (url.endsWith("/api/v1/homes/home1/gaming")) return Response.json(state);
    const m = /\/gaming\/orders\/(\w+)\/claim$/.exec(url);
    if (m) {
      const already = claimed.has(m[1]!);
      claimed.add(m[1]!);
      for (const k of state.kids) k.gameTime = k.gameTime.filter((g) => g.orderId !== m[1]);
      return Response.json({ ok: true, already });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { state, fetchImpl, calls };
}

describe("Den Duty link", () => {
  it("locks games during time-outs, keeps them closed until chores are done, and hands out game time", async () => {
    const den = fakeDenDuty();
    const { app, ctx } = await makeApp(root, {}, { fetchImpl: den.fetchImpl });
    const admin = await person(app, ctx, "mom", { role: "admin" });
    const ava = await person(app, ctx, "ava", { kidMode: true });
    const ben = await person(app, ctx, "ben", { kidMode: true });
    ctx.family.saveSettings({ timeZone: "UTC" });
    // Ava plays while the link is set up, so her game time comes with a note on her PC.
    await app.inject({ method: "POST", url: "/api/me/presence", headers: ava.headers, payload: { device: "DEN", playing: [{ gameId: "store:steam:1", title: "Celeste", source: "store", startedAt: new Date().toISOString() }] } });

    assert.equal((await app.inject({ method: "PUT", url: "/api/denduty", headers: ava.headers, payload: {} })).statusCode, 403);
    const bad = await app.inject({ method: "PUT", url: "/api/denduty", headers: admin.headers, payload: { url: "http://den.local:8081/homes/home1/settings", homeId: "https://den.local/homes/home1", token: "dnk_bad" } });
    assert.equal(bad.statusCode, 200);
    const badView = bad.json() as DenDutyView;
    assert.equal(badView.url, "http://den.local:8081", "a pasted page address keeps the server part");
    assert.equal(badView.homeId, "home1");
    assert.match(badView.error!, /refused the token/);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/denduty",
      headers: admin.headers,
      payload: { token: "dnk_good", kids: { [ava.id]: "kid-ava", [ben.id]: "kid-ben", 999: "kid-ghost" }, choresFirst: true },
    });
    const view = saved.json() as DenDutyView;
    assert.equal(view.connected, true);
    assert.equal(view.hasToken, true);
    assert.equal((view as unknown as { token?: string }).token, undefined, "the token never comes back");
    assert.deepEqual(view.kids, { [ava.id]: "kid-ava", [ben.id]: "kid-ben" }, "profiles that don't exist are dropped");
    assert.deepEqual(view.denKids.map((k) => k.name), ["Ava", "Ben"]);
    assert.equal(view.goals[0]!.title, "Trip to the zoo");

    // Ava bought 30 minutes in Den Duty's shop: claimed there, given here, once.
    await ctx.denDuty.sync();
    assert.equal(ctx.family.allowance(ava.id).bonusSeconds, 30 * 60);
    assert.equal(den.calls.filter((c) => c.startsWith("POST")).length, 1);
    const beat = (await app.inject({ method: "POST", url: "/api/me/presence", headers: ava.headers, payload: { device: "DEN", playing: [] } })).json() as PresenceAnswer;
    assert.ok(beat.commands.some((c) => c.kind === "message" && /30 minutes of game time/.test(c.text)));

    // Chores first: Ava has two left, so no games yet. Ben's Roblox is locked, the rest isn't.
    const a = (await app.inject({ url: "/api/me/allowance", headers: ava.headers })).json() as Allowance;
    assert.equal(a.canPlay, false);
    assert.match(a.reason!, /2 chores left/);
    const b = (await app.inject({ url: "/api/me/allowance", headers: ben.headers })).json() as Allowance;
    assert.equal(b.canPlay, true);
    assert.match(b.robloxLock!, /No Roblox/);

    // Ben starts Roblox anyway (an older app): the next sync closes it, once.
    await app.inject({ method: "POST", url: "/api/me/presence", headers: ben.headers, payload: { device: "KIDS", playing: [{ gameId: "roblox:9", title: "Roblox", source: "roblox", startedAt: new Date().toISOString() }] } });
    await ctx.denDuty.sync();
    await ctx.denDuty.sync();
    const close = ((await app.inject({ method: "POST", url: "/api/me/presence", headers: ben.headers, payload: { device: "KIDS", playing: [] } })).json() as PresenceAnswer).commands;
    assert.deepEqual(close.map((c) => c.kind), ["close"]);

    // Chores done, time-out over: games are back.
    den.state.kids[0]!.chores = { due: 3, done: 3, left: 0 };
    den.state.kids[1]!.locks = [];
    await ctx.denDuty.sync();
    assert.equal(ctx.family.allowance(ava.id).canPlay, true);
    assert.equal(ctx.family.allowance(ben.id).robloxLock, undefined);

    // Switching chores first off, or unlinking, lifts it right away.
    den.state.kids[0]!.chores = { due: 3, done: 0, left: 3 };
    await ctx.denDuty.sync();
    assert.equal(ctx.family.allowance(ava.id).canPlay, false);
    await app.inject({ method: "PUT", url: "/api/denduty", headers: admin.headers, payload: { choresFirst: false } });
    assert.equal(ctx.family.allowance(ava.id).canPlay, true);
  });
});
