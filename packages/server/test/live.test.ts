import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

/** Opens /api/events and collects the event names it sends. */
async function listen(base: string, token: string) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
  const events: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        for (const m of decoder.decode(value).matchAll(/^event: (\w+)$/gm)) events.push(m[1]!);
      }
    } catch {
      // aborted
    }
  })();
  return { res, events, close: async () => (ctl.abort(), await done) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("live events", () => {
  it("needs a sign-in", async () => {
    const { app } = await makeApp(root);
    assert.equal((await app.inject("/api/events")).statusCode, 401);
    await app.close();
  });

  it("tells pages about library changes, and only admins about alerts and downloads", async () => {
    const { app, ctx } = await makeApp(root);
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const admin = await ctx.users.create({ username: "boss", password: "password1", role: "admin" });
    const sam = await ctx.users.create({ username: "sam", password: "password1" });
    const a = await listen(base, ctx.auth.createApiToken(admin.id, "t").token);
    const s = await listen(base, ctx.auth.createApiToken(sam.id, "t").token);
    assert.equal(a.res.headers.get("content-type"), "text/event-stream; charset=utf-8");

    await ctx.library.rescan();
    await ctx.notifier.send("test", "Hello");
    ctx.live.publish("downloads", true);
    await wait(2300);
    assert.deepEqual(a.events.sort(), ["alerts", "downloads", "library"]);
    assert.deepEqual(s.events, ["library"]);

    await Promise.all([a.close(), s.close()]);
    await app.close();
  });

  it("sends a burst as one event", async () => {
    const { app, ctx } = await makeApp(root);
    const seen: string[] = [];
    ctx.live.subscribe((e) => seen.push(e.topic));
    for (let i = 0; i < 20; i++) ctx.live.publish("alerts", true);
    await wait(400);
    assert.deepEqual(seen, ["alerts"]);
    await app.close();
  });

  it("doesn't hold up shutdown", async () => {
    const { app, ctx } = await makeApp(root);
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const admin = await ctx.users.create({ username: "boss", password: "password1", role: "admin" });
    const a = await listen(base, ctx.auth.createApiToken(admin.id, "t").token);
    const started = Date.now();
    await app.close();
    assert.ok(Date.now() - started < 2000);
    await a.close();
  });
});
