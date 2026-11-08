import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import type { HelperAi } from "../src/helper/service.js";
import type { SocketFactory } from "../src/integrations/chat.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

const DENDROP = "https://chat.test";

/** A stand-in Dendrop: records posts, edits and replies, and knows two text channels. */
function fakeDendrop() {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  let nextId = 100;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(DENDROP)) throw new Error(`Unexpected network call in test: ${url}`);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url: url.slice(DENDROP.length), body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/bot/v1/me")) return json({ id: 9 });
    if (url.endsWith("/api/bot/v1/servers"))
      return json([
        {
          id: 1,
          name: "Family",
          channels: [
            { id: 11, kind: "text", name: "general", conversationId: 211 },
            { id: 12, kind: "text", name: "grown-ups", conversationId: 212 },
            { id: 13, kind: "text", name: "game-help", conversationId: 213 },
            { id: 14, kind: "voice", name: "lounge", conversationId: 214 },
          ],
        },
      ]);
    if (/\/channels\/11\/messages\?limit=\d+$/.test(url) && method === "GET")
      return json([
        { id: 2, body: "dinner in 10", createdAt: "2026-01-01T18:01:00Z", deletedAt: null, keyVersion: null, author: { id: 4, username: "mom", displayName: "Mom" } },
        { id: 1, body: "secret", createdAt: "2026-01-01T18:00:00Z", deletedAt: null, keyVersion: 2, author: { id: 4, username: "mom", displayName: "Mom" } },
      ]);
    if (/\/channels\/\d+\/messages$/.test(url) && method === "POST") return json({ id: nextId++ });
    if (url.includes("/api/hooks/")) return new Response(null, { status: 204 });
    return json({ ok: true });
  }) as typeof fetch;
  const sockets: Array<{ url: string; headers: Record<string, string>; emit: (e: unknown) => void }> = [];
  const makeSocket: SocketFactory = (url, headers) => {
    const s = { onopen: null as any, onclose: null as any, onerror: null as any, onmessage: null as any, send() {}, close() {} };
    sockets.push({ url, headers, emit: (e) => s.onmessage?.({ data: JSON.stringify(e) }) });
    queueMicrotask(() => s.onopen?.({}));
    return s;
  };
  const posts = (channel: number) => calls.filter((c) => c.method === "POST" && c.url === `/api/bot/v1/channels/${channel}/messages`).map((c) => c.body);
  return { calls, fetchImpl, makeSocket, sockets, posts };
}

const fakeAi: HelperAi = async function* (p) {
  yield { text: p.context.includes("(a kid)") ? "Kid-safe tip: " : "Tip: " };
  yield { text: "jump twice." };
  yield { model: p.model, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, searches: 0 } };
};

async function setup() {
  const d = fakeDendrop();
  const made = await makeApp(root, {}, { fetchImpl: d.fetchImpl, chatSocket: d.makeSocket, helperAi: fakeAi });
  const { ctx, app } = made;
  const admin = await ctx.users.create({ username: "mom", password: "password1", role: "admin", displayName: "Mom" });
  const kid = await ctx.users.create({ username: "kit", password: "password1", kidMode: true, displayName: "Kit" });
  const token = (id: number) => ({ authorization: `Bearer ${ctx.auth.createApiToken(id, "t").token}` });
  return { ...made, ...d, app, admin, kid, asAdmin: token(admin.id), asKid: token(kid.id) };
}

describe("Dendrop chat link", () => {
  it("lists the OIDC subject for linked apps, to admins only", async () => {
    const { app, ctx, asAdmin, asKid } = await setup();
    await ctx.users.create({ username: "ana", password: "password1", oidcSubject: "tinyauth|ana" });
    const list = (await app.inject({ url: "/api/users", headers: asAdmin })).json() as Array<{ username: string; oidcSubject: string | null }>;
    assert.equal(list.find((u) => u.username === "ana")!.oidcSubject, "tinyauth|ana");
    assert.equal((await app.inject({ url: "/api/users", headers: asKid })).statusCode, 403);
    await app.close();
  });

  it("shares a game through a webhook when there's no bot", async () => {
    const { app, calls, asAdmin, asKid, ctx } = await setup();
    assert.equal((await app.inject({ url: "/api/chat/status", headers: asKid })).json().ready, false);
    const bad = await app.inject({ method: "PUT", url: "/api/chat", headers: asAdmin, payload: { enabled: true, webhookUrl: "https://nope" } });
    assert.equal(bad.statusCode, 400);
    const saved = await app.inject({ method: "PUT", url: "/api/chat", headers: asAdmin, payload: { enabled: true, webhookUrl: `${DENDROP}/api/hooks/3/secret` } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().webhookUrl, "********", "the webhook address is a secret");
    assert.equal((await app.inject({ url: "/api/chat", headers: asKid })).statusCode, 403);
    assert.deepEqual((await app.inject({ url: "/api/chat/status", headers: asKid })).json(), { ready: true, buttons: false });

    const game = ctx.library.list().find((g) => g.title.includes("Portal"))!;
    ctx.db.prepare("UPDATE games SET kid_safe_override = 1 WHERE id = ?").run(game.id);
    const share = await app.inject({ method: "POST", url: "/api/chat/share", headers: asKid, payload: { gameId: game.id } });
    assert.equal(share.statusCode, 200, share.body);
    const hook = calls.find((c) => c.url === "/api/hooks/3/secret")!;
    assert.match(hook.body.content, /Kit shared Portal/);
    assert.match(hook.body.content, new RegExp(`/games/${game.id}`));
    assert.equal(hook.body.username, "LootDen");
    await app.close();
  });

  it("posts requests and time asks with buttons, and answers clicks from grown-ups only", async () => {
    const { app, ctx, asAdmin, asKid, sockets, posts, calls } = await setup();
    const saved = await app.inject({
      method: "PUT",
      url: "/api/chat",
      headers: asAdmin,
      payload: { enabled: true, url: `${DENDROP}/`, botToken: "bot-token", familyChannelId: 11, grownupsChannelId: 12 },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().botToken, "********");
    assert.equal(sockets.length, 1, "the bot connects to the gateway");
    assert.equal(sockets[0]!.url, "wss://chat.test/api/bot/v1/gateway");
    assert.equal(sockets[0]!.headers.authorization, "Bot bot-token");
    const channels = (await app.inject({ url: "/api/chat/channels", headers: asAdmin })).json() as Array<{ id: number; name: string }>;
    assert.deepEqual(channels.map((c) => c.name), ["general", "grown-ups", "game-help"], "text channels only");

    // A kid asks for a game: the grown-ups channel gets Approve / Decline.
    const ask = await app.inject({ method: "POST", url: "/api/requests", headers: asKid, payload: { title: "Hollow Knight" } });
    await new Promise((r) => setTimeout(r, 20));
    const reqPost = posts(12).find((p) => /asked for \*\*Hollow Knight/.test(p.content))!;
    assert.ok(reqPost, "posted to the grown-ups channel");
    assert.deepEqual(reqPost.buttons.slice(0, 2).map((b: { id: string }) => b.id), [`req:approve:${ask.json().id}`, `req:decline:${ask.json().id}`]);
    assert.equal(posts(11).filter((p) => /Hollow/.test(p.content)).length, 0, "not in the family channel");

    // The kid clicking Approve is refused; Mom's click approves it and clears the buttons.
    const no = await ctx.chat.handleClick({ id: 1, messageId: 100, channelId: 12, buttonId: `req:approve:${ask.json().id}`, role: "member", user: { id: 5, username: "kit", displayName: "Kit" } });
    assert.match(no.reply!, /Only LootDen admins/);
    sockets[0]!.emit({ type: "interaction.created", interaction: { id: 2, messageId: 100, channelId: 12, buttonId: `req:approve:${ask.json().id}`, role: "owner", user: { id: 4, username: "mom", displayName: "Mom" } } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctx.requests.get(ask.json().id)!.status, "searching", "approved onto the wanted list");
    const edit = calls.find((c) => c.method === "PATCH" && c.url === "/api/bot/v1/messages/100")!;
    assert.match(edit.body.content, /approved by Mom/);
    assert.deepEqual(edit.body.buttons, []);

    // More time: +15, +30 and the asked 20, then Not now.
    const t = await app.inject({ method: "POST", url: "/api/time-requests", headers: asKid, payload: { minutes: 20, note: "boss fight" } });
    assert.equal(t.statusCode, 200, t.body);
    await new Promise((r) => setTimeout(r, 20));
    const timePost = posts(12).find((p) => /20 more minutes/.test(p.content))!;
    assert.deepEqual(timePost.buttons.map((b: { label: string }) => b.label), ["+15 min", "+20 min", "+30 min", "Not now"]);
    const yes = await ctx.chat.handleClick({ id: 3, messageId: 101, channelId: 12, buttonId: `time:yes:${t.json().id}:30`, role: "admin", user: { id: 4, username: "mom", displayName: "Mom" } });
    assert.match(yes.update!.content!, /Kit got 30 more minutes from Mom/);
    const decided = ctx.family.timeRequests(null).find((x) => x.id === t.json().id)!;
    assert.equal(decided.state, "approved");
    assert.equal(decided.minutes, 30);

    // Other alerts go to the grown-ups channel too.
    await ctx.notifier.send("deals", "Hades is 80% off", null, "/wishlist");
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(posts(12).some((p) => /Hades is 80% off/.test(p.content)));
    await app.close();
  });

  it("looks for a group, installs on the clicker's PC and lets Bandit answer in his channel", async () => {
    const { app, ctx, asAdmin, asKid, sockets, posts, kid } = await setup();
    await app.inject({ method: "PUT", url: "/api/helper/settings", headers: asAdmin, payload: { apiKey: "sk-ant-test-0123456789abcdefghij" } });
    const saved = await app.inject({
      method: "PUT",
      url: "/api/chat",
      headers: asAdmin,
      payload: { enabled: true, url: DENDROP, botToken: "bot-token", familyChannelId: 11, grownupsChannelId: 12, helperChannelId: 13, helperUserId: 1 },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    await new Promise((r) => setTimeout(r, 20));
    const game = ctx.library.list().find((g) => g.title.includes("Portal"))!;
    ctx.db.prepare("UPDATE games SET kid_safe_override = 1 WHERE id = ?").run(game.id);

    const lfg = await app.inject({ method: "POST", url: "/api/chat/lfg", headers: asKid, payload: { gameId: game.id, note: "after dinner" } });
    assert.equal(lfg.statusCode, 200, lfg.body);
    const post = posts(11).find((p) => /Kit wants to play \*\*Portal/.test(p.content))!;
    assert.match(post.content, /after dinner/);
    assert.deepEqual(post.buttons.map((b: { id: string }) => b.id), ["lfg:join", `install:${game.id}`]);
    const join = await ctx.chat.handleClick({ id: 4, messageId: 100, channelId: 11, buttonId: "lfg:join", role: "member", user: { id: 4, username: "mom", displayName: "Mom" } });
    assert.match(join.update!.content!, /In: Kit, Mom/);

    // Install on my PC: the kid's PC gets the game.
    ctx.presence.report(kid.id, { device: "Kit-PC", playing: [] });
    const inst = await ctx.chat.handleClick({ id: 5, messageId: 100, channelId: 11, buttonId: `install:${game.id}`, role: "member", user: { id: 5, username: "kit", displayName: "Kit" } });
    assert.match(inst.reply!, /downloading on Kit-PC|install when Kit-PC/);
    const stranger = await ctx.chat.handleClick({ id: 6, messageId: 100, channelId: 11, buttonId: `install:${game.id}`, role: "member", user: { id: 7, username: "zed", displayName: "Zed" } });
    assert.match(stranger.reply!, /doesn't match a LootDen profile/);

    // Bandit answers in his channel, kid-safe, and not to his own messages.
    sockets.at(-1)!.emit({ type: "message.created", message: { id: 50, conversationId: 213, authorId: 4, body: "How do I beat the boss?", keyVersion: null, webhook: null } });
    sockets.at(-1)!.emit({ type: "message.created", message: { id: 51, conversationId: 213, authorId: 9, body: "🦝 earlier answer", keyVersion: null, webhook: null } });
    sockets.at(-1)!.emit({ type: "message.created", message: { id: 52, conversationId: 211, authorId: 4, body: "not for Bandit", keyVersion: null, webhook: null } });
    await new Promise((r) => setTimeout(r, 50));
    const answers = posts(13);
    assert.equal(answers.length, 1);
    assert.match(answers[0].content, /🦝 Kid-safe tip: jump twice/, "kid-safe by default");
    await app.close();
  });

  it("shows family chat in the in-game menu and lets grown-ups reply", async () => {
    const { app, asAdmin, asKid, posts } = await setup();
    await app.inject({ method: "PUT", url: "/api/chat", headers: asAdmin, payload: { enabled: true, url: DENDROP, botToken: "bot-token", familyChannelId: 11 } });
    await new Promise((r) => setTimeout(r, 20));
    const read = await app.inject({ method: "GET", url: "/api/chat/family", headers: asKid });
    assert.equal(read.statusCode, 200, read.body);
    const lines = read.json().messages ?? read.json();
    assert.equal(lines.length, 1, "encrypted messages are left out");
    assert.match(lines[0].text, /dinner in 10/);
    assert.equal(lines[0].from, "Mom");
    const kidSay = await app.inject({ method: "POST", url: "/api/chat/family", headers: asKid, payload: { text: "hi" } });
    assert.equal(kidSay.statusCode, 403);
    const say = await app.inject({ method: "POST", url: "/api/chat/family", headers: asAdmin, payload: { text: "brb" } });
    assert.equal(say.statusCode, 200, say.body);
    assert.ok(posts(11).some((p) => p.content === "🎮 Mom: brb"));
    await app.close();
  });
});
