import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import type { PresenceAnswer, StreamHost } from "@lootden/shared";
import { cleanAction, houseContext } from "../src/helper/actions.js";
import type { HelperAi } from "../src/helper/service.js";
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

const alerts = (ctx: App["ctx"], kind: string) => (ctx.db.prepare("SELECT title, body FROM notifications WHERE kind = ? ORDER BY id").all(kind) as Array<{ title: string; body: string | null }>);

describe("Den Duty both ways", () => {
  it("reports play time, keeps an earned game locked until a reward unlocks it", async () => {
    const reports: unknown[] = [];
    const claimed = new Set<string>();
    let unlocks: unknown[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("http://den.local/")) return offlineFetch(input, init);
      if (url.endsWith("/gaming")) {
        return Response.json({ today: "2026-11-08", familyGoalsReached: [], kids: [{ id: "kid-ava", name: "Ava", chores: null, locks: [], gameTime: [], gameUnlocks: unlocks }] });
      }
      if (url.endsWith("/gaming/report")) {
        reports.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      }
      const m = /\/gaming\/orders\/(\w+)\/claim$/.exec(url);
      if (m) {
        const already = claimed.has(m[1]!);
        claimed.add(m[1]!);
        unlocks = [];
        return Response.json({ ok: true, already });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, {}, { fetchImpl });
    const admin = await person(app, ctx, "mom", { role: "admin" });
    const ava = await person(app, ctx, "ava", { kidMode: true });
    const game = ctx.library.list()[0]!;
    // Kids only see kid-safe games.
    ctx.library.setOverrides(game.id, { kidSafe: true });

    assert.equal((await app.inject({ method: "PUT", url: `/api/games/${game.id}/earners`, headers: ava.headers, payload: { userIds: [ava.id] } })).statusCode, 403);
    const set = await app.inject({ method: "PUT", url: `/api/games/${game.id}/earners`, headers: admin.headers, payload: { userIds: [ava.id, 9999] } });
    assert.deepEqual(set.json().userIds, [ava.id], "profiles that don't exist are dropped");
    const lock = (await app.inject({ url: `/api/games/${game.id}/lock`, headers: ava.headers })).json();
    assert.match(lock.reason, /Den Duty/);

    // She starts it anyway (the app was offline): the next heartbeat closes it, once.
    const play = { device: "KIDS", playing: [{ gameId: game.id, title: game.title, source: "lootden", startedAt: new Date(Date.now() - 10 * 60_000).toISOString() }] };
    const first = (await app.inject({ method: "POST", url: "/api/me/presence", headers: ava.headers, payload: play })).json() as PresenceAnswer;
    const second = (await app.inject({ method: "POST", url: "/api/me/presence", headers: ava.headers, payload: play })).json() as PresenceAnswer;
    assert.equal([...first.commands, ...second.commands].filter((c) => c.kind === "close").length, 1);

    await app.inject({ method: "PUT", url: "/api/denduty", headers: admin.headers, payload: { url: "http://den.local", homeId: "home1", token: "dnk_good", kids: { [ava.id]: "kid-ava" } } });
    await ctx.denDuty.sync();
    // The report: ten minutes of play so far, the game she's on, and the game a reward can unlock.
    const report = reports.at(-1) as { kids: Array<{ kidId: string; minutes: number; playing: string | null }>; games: Array<{ id: string; title: string }> };
    assert.equal(report.kids[0]!.kidId, "kid-ava");
    assert.equal(report.kids[0]!.minutes, 10);
    assert.equal(report.kids[0]!.playing, game.title);
    assert.deepEqual(report.games, [{ id: game.id, title: game.title }]);

    // She buys "the game for a day" in Den Duty: claimed there, unlocked here.
    unlocks = [{ orderId: "o7", title: "Game day", icon: "🎮", gameId: game.id, gameTitle: game.title, hours: 24, boughtAt: new Date().toISOString() }];
    await ctx.denDuty.sync();
    assert.ok(claimed.has("o7"));
    const open = (await app.inject({ url: `/api/games/${game.id}/lock`, headers: ava.headers })).json();
    assert.equal(open.reason, null);
    assert.ok(Date.parse(open.unlockedUntil) > Date.now() + 23 * 3600_000);
  });
});

describe("Pausing, alerts and Discord", () => {
  it("pauses a kid's games, alerts on installs, failed save backups and time limits, and posts to Discord", async () => {
    const posts: Array<{ url: string; body: { embeds: Array<{ title: string; description?: string }> } }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://discord.com/api/webhooks/")) return offlineFetch(input, init);
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ id: "1" });
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, { publicUrl: "https://den.example" }, { fetchImpl });
    const admin = await person(app, ctx, "mom", { role: "admin" });
    const ben = await person(app, ctx, "ben", { kidMode: true });
    ctx.family.saveSettings({ timeZone: "UTC" });
    const game = ctx.library.list()[0]!;

    // Pause: the running game gets closed and the allowance says why.
    await app.inject({ method: "POST", url: "/api/me/presence", headers: ben.headers, payload: { device: "KIDS", playing: [{ gameId: game.id, title: game.title, source: "lootden", startedAt: new Date().toISOString() }] } });
    assert.equal((await app.inject({ method: "PUT", url: `/api/users/${ben.id}/paused`, headers: ben.headers, payload: { paused: true } })).statusCode, 403);
    const paused = await app.inject({ method: "PUT", url: `/api/users/${ben.id}/paused`, headers: admin.headers, payload: { paused: true } });
    assert.equal(paused.json().paused, true);
    assert.equal(paused.json().allowance.canPlay, false);
    const beat = (await app.inject({ method: "POST", url: "/api/me/presence", headers: ben.headers, payload: { device: "KIDS", playing: [] } })).json() as PresenceAnswer;
    assert.ok(beat.commands.some((c) => c.kind === "close"));
    await app.inject({ method: "PUT", url: `/api/users/${ben.id}/paused`, headers: admin.headers, payload: { paused: false } });
    assert.equal(ctx.family.allowance(ben.id).canPlay, true);

    // Installed, and a save backup that failed.
    await app.inject({ method: "POST", url: "/api/me/activity", headers: ben.headers, payload: { gameId: game.id, device: "KIDS", event: "installed" } });
    assert.match(alerts(ctx, "installed")[0]!.title, /was installed on KIDS/);
    await app.inject({ method: "POST", url: `/api/games/${game.id}/saves/failed`, headers: ben.headers, payload: { device: "KIDS", error: "Disk full" } });
    assert.match(alerts(ctx, "saveFailed")[0]!.body!, /Ben on KIDS: Disk full/);

    // Time's up while playing: said once.
    await app.inject({ method: "PUT", url: `/api/users/${ben.id}/limits`, headers: admin.headers, payload: { weekdayMinutes: 30, weekendMinutes: 30 } });
    ctx.family.recordSession(ben.id, game.id, "KIDS", 45 * 60);
    await app.inject({ method: "POST", url: "/api/me/presence", headers: ben.headers, payload: { device: "KIDS", playing: [{ gameId: game.id, title: game.title, source: "lootden", startedAt: new Date().toISOString() }] } });
    await ctx.houseWatch.tick();
    await ctx.houseWatch.tick();
    assert.equal(alerts(ctx, "timeLimit").length, 1);
    assert.match(alerts(ctx, "timeLimit")[0]!.title, /Ben reached today's play time/);

    // Discord: a bad webhook is refused, a good one is masked and gets game nights and reminders.
    assert.equal((await app.inject({ method: "PUT", url: "/api/discord", headers: admin.headers, payload: { webhookUrl: "https://evil.example/hook" } })).statusCode, 400);
    const saved = await app.inject({ method: "PUT", url: "/api/discord", headers: admin.headers, payload: { webhookUrl: "https://discord.com/api/webhooks/123/abc-DEF" } });
    assert.equal(saved.json().webhookUrl, "********");
    assert.equal((await app.inject({ method: "POST", url: "/api/discord/test", headers: admin.headers })).statusCode, 200);
    assert.match(posts.at(-1)!.url, /\/123\/abc-DEF\?wait=true$/);

    const soon = new Date(Date.now() + 30 * 60_000);
    const night = await app.inject({
      method: "POST",
      url: "/api/game-nights",
      headers: admin.headers,
      payload: { title: "Mario night", date: soon.toISOString().slice(0, 10), time: soon.toISOString().slice(11, 16), players: [ben.id] },
    });
    assert.equal(night.statusCode, 200, night.body);
    await new Promise((r) => setImmediate(r));
    assert.ok(posts.some((p) => p.body.embeds[0]!.title === "📅 Mario night"));
    await ctx.houseWatch.tick();
    await ctx.houseWatch.tick();
    assert.equal(alerts(ctx, "gameNight").length, 1, "one reminder");
    assert.equal(posts.filter((p) => /Mario night starts in/.test(p.body.embeds[0]!.title)).length, 1);

    // Rare achievements only, by default.
    await ctx.discord.achievements("Ben", { title: "Portal 2", kidSafe: true }, [{ name: "Common", rarity: 60 }, { name: "Tricky", rarity: 4.2 }]);
    assert.match(posts.at(-1)!.body.embeds[0]!.title, /Ben unlocked "Tricky" in Portal 2/);
    await ctx.discord.save({ kidSafeOnly: true });
    const before = posts.length;
    await ctx.discord.finished("Ben", { id: "x", title: "Grown-up game", kidSafe: null }, "done");
    assert.equal(posts.length, before, "kid-safe only leaves unknown games out");
  });
});

describe("Bandit actions and streaming", () => {
  it("offers actions that only run when asked, as the person", async () => {
    const seen: string[] = [];
    const ai: HelperAi = async function* (p) {
      seen.push(p.context);
      yield { text: 'Sure! [[action {"type":"wake","pc":"DEN"}]]' };
      yield { model: "claude-haiku-5-5", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } };
    };
    const { app, ctx } = await makeApp(root, {}, { helperAi: ai });
    const admin = await person(app, ctx, "mom", { role: "admin" });
    const kid = await person(app, ctx, "ava", { kidMode: true });
    await app.inject({ method: "PUT", url: "/api/helper/settings", headers: admin.headers, payload: { apiKey: "sk-ant-test-0123456789abcdefghij", model: "claude-haiku-5-5" } });
    const game = ctx.library.list()[0]!;
    // Two PCs: DEN has the game installed.
    await app.inject({ method: "POST", url: "/api/me/presence", headers: admin.headers, payload: { device: "DEN", playing: [], pc: { copies: [{ gameId: game.id, version: "1" }] } } });
    await app.inject({ method: "POST", url: "/api/me/presence", headers: kid.headers, payload: { device: "KIDS", playing: [] } });

    const answer = await app.inject({ method: "POST", url: "/api/helper/chat", headers: admin.headers, payload: { messages: [{ role: "user", content: "Switch on the den PC" }] } });
    assert.match(answer.body, /\[\[action/);
    assert.match(seen[0]!, /DEN: on, used by Mom/);
    assert.match(seen[0]!, new RegExp(`${game.id} \\| ${game.title}`));

    assert.throws(() => cleanAction({ type: "format-disk" }), /can't do that/);
    assert.throws(() => cleanAction({ type: "shelf", name: "x" }), /games or rules/);
    assert.deepEqual(cleanAction({ type: "shelf", name: "Co-op", rules: { together: true, installed: true, junk: 1 } }), { type: "shelf", name: "Co-op", emoji: undefined, gameIds: undefined, rules: { together: true, installed: true }, household: false });

    // Install on a PC: kids only on PCs they use.
    const kidSend = () => app.inject({ method: "POST", url: "/api/helper/action", headers: kid.headers, payload: { action: { type: "install", gameId: game.id, pc: "DEN" } } });
    assert.equal((await kidSend()).statusCode, 403, "Bandit is off for kids until a parent switches him on");
    await app.inject({ method: "PUT", url: `/api/users/${kid.id}/helper`, headers: admin.headers, payload: { allowed: true } });
    const sendKid = await kidSend();
    assert.equal(sendKid.statusCode, 400);
    assert.match(sendKid.json().error, /PCs you use/);
    const sent = await app.inject({ method: "POST", url: "/api/helper/action", headers: admin.headers, payload: { action: { type: "install", gameId: game.id, pc: "KIDS" } } });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.match(sent.json().text, /on its way to KIDS/);
    const cmds = ((await app.inject({ method: "POST", url: "/api/me/presence", headers: kid.headers, payload: { device: "KIDS", playing: [] } })).json() as PresenceAnswer).commands;
    assert.ok(cmds.some((c) => c.kind === "install" && c.gameId === game.id));

    // A shelf from a sentence.
    const shelf = await app.inject({ method: "POST", url: "/api/helper/action", headers: admin.headers, payload: { action: { type: "shelf", name: "Weekend picks", emoji: "🎉", gameIds: [game.id, "nope"] } } });
    assert.match(shelf.json().text, /with 1 game/);
    const shelves = (await app.inject({ url: "/api/shelves", headers: admin.headers })).json() as Array<{ name: string; games: Array<{ id: string }> }>;
    assert.deepEqual(shelves.find((s) => s.name === "Weekend picks")!.games.map((g) => g.id), [game.id]);

    assert.ok(houseContext(ctx, (await ctx.users.byId(kid.id))!).includes("KIDS"));
  });

  it("streams from the free PC first, and wakes one that's off", async () => {
    const woken: string[] = [];
    const { app, ctx } = await makeApp(root, {}, { wake: async (packet: Buffer) => void woken.push(packet.subarray(6, 12).toString("hex")) } as never);
    const admin = await person(app, ctx, "mom", { role: "admin" });
    const ben = await person(app, ctx, "ben");
    const game = ctx.library.list()[0]!;
    const host = (device: string, macs: string[], playing: unknown[] = []) => ({ device, playing, pc: { macs, addresses: ["192.168.1.20"], sunshine: true, streamGames: [game.id] } });
    await app.inject({ method: "POST", url: "/api/me/presence", headers: ben.headers, payload: host("BUSY-PC", [], [{ gameId: game.id, title: game.title, source: "lootden", startedAt: new Date().toISOString() }]) });
    await app.inject({ method: "POST", url: "/api/me/presence", headers: admin.headers, payload: host("FREE-PC", []) });

    const hosts = (await app.inject({ url: `/api/games/${game.id}/stream-hosts`, headers: admin.headers })).json() as StreamHost[];
    assert.deepEqual(hosts.map((h) => [h.name, !!h.busy]), [["FREE-PC", false], ["BUSY-PC", true]]);
    const pick = (await app.inject({ method: "POST", url: `/api/games/${game.id}/stream-pick`, headers: admin.headers, payload: {} })).json();
    assert.deepEqual([pick.host.name, pick.waking], ["FREE-PC", false]);

    // FREE-PC goes off: an off PC that can be woken beats the busy one.
    ctx.db.prepare("UPDATE pcs SET last_seen = ?, macs = ? WHERE name = 'FREE-PC'").run(new Date(Date.now() - 3600_000).toISOString(), JSON.stringify(["aa:bb:cc:dd:ee:ff"]));
    const wake = (await app.inject({ method: "POST", url: `/api/games/${game.id}/stream-pick`, headers: admin.headers, payload: {} })).json();
    assert.deepEqual([wake.host.name, wake.waking], ["FREE-PC", true]);
    assert.ok(woken.length >= 1);
  });
});
