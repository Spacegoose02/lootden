import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

describe("web browser rules per person", () => {
  it("makes kid profiles kid-safe and lets admins block and allow sites per person", async () => {
    const { app, ctx } = await makeApp(root);
    const token = (id: number) => ({ authorization: `Bearer ${ctx.auth.createApiToken(id, "t").token}` });
    const admin = await ctx.users.create({ username: "boss", password: "password1", role: "admin" });
    const sam = await ctx.users.create({ username: "sam", password: "password1" });
    const kid = await ctx.users.create({ username: "kiddo", password: "password1", kidMode: true });
    const asAdmin = token(admin.id);

    assert.deepEqual((await app.inject({ url: "/api/me/browser", headers: token(sam.id) })).json(), { mode: "open", allowed: [], blocked: [] });
    assert.deepEqual((await app.inject({ url: "/api/me/browser", headers: token(kid.id) })).json(), { mode: "kids", allowed: [], blocked: [] });

    // Only admins change it.
    assert.equal((await app.inject({ method: "PUT", url: `/api/users/${sam.id}/browser`, headers: token(sam.id), payload: { blocked: [] } })).statusCode, 403);
    assert.equal((await app.inject({ url: `/api/users/${kid.id}/browser`, headers: token(kid.id) })).statusCode, 403);

    const saved = await app.inject({ method: "PUT", url: `/api/users/${sam.id}/browser`, headers: asAdmin, payload: { blocked: ["https://www.Twitch.tv/somebody", "*.roblox.com", "twitch.tv"] } });
    assert.deepEqual(saved.json(), { mode: "open", allowed: [], blocked: ["twitch.tv", "roblox.com"] });
    assert.deepEqual((await app.inject({ url: "/api/me/browser", headers: token(sam.id) })).json().blocked, ["twitch.tv", "roblox.com"]);

    assert.equal((await app.inject({ method: "PUT", url: `/api/users/${kid.id}/browser`, headers: asAdmin, payload: { allowed: ["not a site"] } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url: `/api/users/${kid.id}/browser`, headers: asAdmin, payload: { mode: "anything" } })).statusCode, 400);
    await app.inject({ method: "PUT", url: `/api/users/${kid.id}/browser`, headers: asAdmin, payload: { allowed: ["minecraft.net"] } });
    assert.deepEqual((await app.inject({ url: "/api/me/browser", headers: token(kid.id) })).json(), { mode: "kids", allowed: ["minecraft.net"], blocked: [] });
    await app.inject({ method: "PUT", url: `/api/users/${kid.id}/browser`, headers: asAdmin, payload: { mode: "open" } });
    assert.deepEqual((await app.inject({ url: `/api/users/${kid.id}/browser`, headers: asAdmin })).json(), { mode: "open", allowed: ["minecraft.net"], blocked: [] });
    assert.equal((await app.inject({ url: "/api/users/9999/browser", headers: asAdmin })).statusCode, 404);
    await app.close();
  });
});
