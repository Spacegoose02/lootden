import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { helperCost } from "@lootden/shared";
import type { HelperAi, HelperPrompt } from "../src/helper/service.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

/** A stand-in AI that answers in two pieces and reports some tokens, and remembers what it was asked. */
function fakeAi() {
  const asked: HelperPrompt[] = [];
  const ai: HelperAi = async function* (p) {
    asked.push(p);
    yield { text: "Try the " };
    yield { text: "left door!" };
    yield { model: p.model, usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 } };
  };
  return { ai, asked };
}

async function setup() {
  const fake = fakeAi();
  const made = await makeApp(root, {}, { helperAi: fake.ai });
  const { ctx } = made;
  const token = (id: number) => ({ authorization: `Bearer ${ctx.auth.createApiToken(id, "t").token}` });
  const admin = await ctx.users.create({ username: "boss", password: "password1", role: "admin" });
  const sam = await ctx.users.create({ username: "sam", password: "password1" });
  const kid = await ctx.users.create({ username: "kiddo", password: "password1", kidMode: true });
  return { ...made, ...fake, token, admin, sam, kid, asAdmin: token(admin.id) };
}

const ask = (text: string, game?: unknown) => ({ messages: [{ role: "assistant", content: "Hi, I'm Bandit!" }, { role: "user", content: text }], game });

describe("Bandit, the AI helper", () => {
  it("needs an admin to set it up, keeps the key secret, and checks the settings", async () => {
    const { app, db, token, sam, asAdmin } = await setup();
    assert.deepEqual((await app.inject({ url: "/api/me/helper", headers: token(sam.id) })).json(), {
      configured: false,
      allowed: true,
      enabled: true,
      available: false,
      kid: false,
      remaining: 50,
      paused: false,
    });
    assert.equal((await app.inject({ method: "POST", url: "/api/helper/chat", headers: token(sam.id), payload: ask("hi") })).statusCode, 503);
    assert.equal((await app.inject({ url: "/api/helper/settings", headers: token(sam.id) })).statusCode, 403);

    const saved = await app.inject({ method: "PUT", url: "/api/helper/settings", headers: asAdmin, payload: { apiKey: "sk-ant-test-0123456789abcdefghij", model: "claude-haiku-5-5", monthlyBudget: 5 } });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().settings.apiKey, "********");
    assert.equal(saved.json().settings.model, "claude-haiku-5-5");
    assert.equal(saved.json().ready, true);
    // The masked key sent back unchanged keeps the key.
    await app.inject({ method: "PUT", url: "/api/helper/settings", headers: asAdmin, payload: { apiKey: "********", answerLength: "short" } });
    assert.equal((await app.inject({ url: "/api/helper/settings", headers: asAdmin })).json().ready, true);
    // The key is encrypted at rest.
    const raw = (db.prepare("SELECT value FROM settings WHERE key = 'helper'").get() as { value: string }).value;
    assert.ok(raw.includes("enc:v1:") && !raw.includes("sk-ant-test"));

    for (const bad of [{ model: "gpt-9" }, { effort: "max" }, { answerLength: "huge" }, { dailyLimit: -1 }, { monthlyBudget: "lots" }, { apiKey: "short" }]) {
      assert.equal((await app.inject({ method: "PUT", url: "/api/helper/settings", headers: asAdmin, payload: bad })).statusCode, 400, JSON.stringify(bad));
    }
    await app.close();
  });

  it("streams answers, tells the AI about the game, and counts messages and cost", async () => {
    const { app, ctx, token, sam, asAdmin, asked } = await setup();
    await app.inject({ method: "PUT", url: "/api/helper/settings", headers: asAdmin, payload: { apiKey: "sk-ant-test-0123456789abcdefghij", model: "claude-sonnet-5-5", effort: "medium", answerLength: "long" } });
    const game = ctx.library.list({})[0]!;
    const res = await app.inject({ method: "POST", url: "/api/helper/chat", headers: token(sam.id), payload: ask("How do I get past the gate?", { gameId: game.id }) });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] as string, /^text\/plain/);
    assert.equal(res.body, "Try the left door!");

    const p = asked[0]!;
    assert.equal(p.model, "claude-sonnet-5-5");
    assert.equal(p.effort, "medium");
    assert.equal(p.maxTokens, 16000);
    assert.match(p.context, new RegExp(`Title: ${game.title}`));
    assert.doesNotMatch(p.context, /kid profile/);
    // Bandit's greeting came first; the AI only gets the chat from the person's first message.
    assert.deepEqual(p.messages, [{ role: "user", content: "How do I get past the gate?" }]);

    const usage = (await app.inject({ url: "/api/helper/usage", headers: asAdmin })).json();
    assert.equal(usage.messages, 1);
    const mine = usage.people.find((x: { userId: number }) => x.userId === sam.id);
    assert.equal(mine.messages, 1);
    assert.equal(mine.inputTokens, 1000);
    assert.equal(mine.outputTokens, 200);
    assert.ok(Math.abs(mine.cost - helperCost("claude-sonnet-5-5", { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 })) < 1e-9);
    assert.equal((await app.inject({ url: "/api/helper/usage", headers: token(sam.id) })).statusCode, 403);

    // Bad chats are refused before anything reaches the AI.
    for (const bad of [{ messages: "hi" }, { messages: [] }, { messages: [{ role: "system", content: "x" }] }, { messages: [{ role: "user", content: "x".repeat(2001) }] }]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/helper/chat", headers: token(sam.id), payload: bad })).statusCode, 400);
    }
    assert.equal(asked.length, 1);
    await app.close();
  });

  it("is off for kids until a parent switches it on, and uses kid-safe instructions", async () => {
    const { app, ctx, token, kid, asAdmin, asked } = await setup();
    await app.inject({ method: "PUT", url: "/api/helper/settings", headers: asAdmin, payload: { apiKey: "sk-ant-test-0123456789abcdefghij" } });
    const me = (await app.inject({ url: "/api/me/helper", headers: token(kid.id) })).json();
    assert.equal(me.allowed, false);
    assert.equal(me.remaining, 20);
    assert.equal((await app.inject({ method: "POST", url: "/api/helper/chat", headers: token(kid.id), payload: ask("hi") })).statusCode, 403);
    // A kid's own switch doesn't get round the parent's.
    await app.inject({ method: "PUT", url: "/api/me/helper", headers: token(kid.id), payload: { enabled: true } });
    assert.equal((await app.inject({ method: "POST", url: "/api/helper/chat", headers: token(kid.id), payload: ask("hi") })).statusCode, 403);
    assert.equal((await app.inject({ method: "PUT", url: `/api/users/${kid.id}/helper`, headers: token(kid.id), payload: { allowed: true } })).statusCode, 403);

    assert.deepEqual((await app.inject({ method: "PUT", url: `/api/users/${kid.id}/helper`, headers: asAdmin, payload: { allowed: true } })).json(), { allowed: true, isDefault: false, dailyLimit: null });
    // A game a kid can't open isn't passed on.
    const game = ctx.library.list({})[0]!;
    const res = await app.inject({ method: "POST", url: "/api/helper/chat", headers: token(kid.id), payload: ask("help", { gameId: game.id }) });
    assert.equal(res.statusCode, 200);
    assert.match(asked[0]!.context, /child using a kid profile/);
    assert.doesNotMatch(asked[0]!.context, /Title:/);

    // Back to the default: off again for a kid.
    await app.inject({ method: "PUT", url: `/api/users/${kid.id}/helper`, headers: asAdmin, payload: { allowed: null } });
    assert.equal((await app.inject({ url: `/api/users/${kid.id}/helper`, headers: asAdmin })).json().allowed, false);
    await app.close();
  });

  it("stops at the daily limit, the person's own switch, and the monthly budget", async () => {
    const { app, token, sam, admin, asAdmin } = await setup();
    await app.inject({ method: "PUT", url: "/api/helper/settings", headers: asAdmin, payload: { apiKey: "sk-ant-test-0123456789abcdefghij", model: "claude-opus-5-5" } });
    await app.inject({ method: "PUT", url: `/api/users/${sam.id}/helper`, headers: asAdmin, payload: { dailyLimit: 2 } });
    const chat = (h: Record<string, string>) => app.inject({ method: "POST", url: "/api/helper/chat", headers: h, payload: ask("tip?") });
    assert.equal((await chat(token(sam.id))).statusCode, 200);
    assert.equal((await chat(token(sam.id))).statusCode, 200);
    const third = await chat(token(sam.id));
    assert.equal(third.statusCode, 429);
    assert.match(third.json().error, /today/);
    assert.equal((await app.inject({ url: "/api/me/helper", headers: token(sam.id) })).json().remaining, 0);

    // Switched off by the person: nothing goes out.
    await app.inject({ method: "PUT", url: "/api/me/helper", headers: token(admin.id), payload: { enabled: false } });
    assert.equal((await chat(token(admin.id))).statusCode, 403);
    await app.inject({ method: "PUT", url: "/api/me/helper", headers: token(admin.id), payload: { enabled: true } });

    // Two Opus answers cost about 2 × (1000 × $4 + 200 × $20) / 1M = $0.016; a $0.01 budget is used up.
    await app.inject({ method: "PUT", url: "/api/helper/settings", headers: asAdmin, payload: { monthlyBudget: 0.01 } });
    const paused = await chat(token(admin.id));
    assert.equal(paused.statusCode, 429);
    assert.match(paused.json().error, /next month/);
    assert.equal((await app.inject({ url: "/api/helper/usage", headers: asAdmin })).json().paused, true);
    await app.inject({ method: "PUT", url: "/api/helper/settings", headers: asAdmin, payload: { monthlyBudget: 0 } });
    assert.equal((await chat(token(admin.id))).statusCode, 200);
    await app.close();
  });
});
