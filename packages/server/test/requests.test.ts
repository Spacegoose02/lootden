import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { makeApp, makeLibrary, sessionCookie } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

async function person(app: Awaited<ReturnType<typeof makeApp>>["app"], ctx: Awaited<ReturnType<typeof makeApp>>["ctx"], username: string, extra: { role?: "admin" | "user"; kidMode?: boolean } = {}) {
  await ctx.users.create({ username, password: "password123", displayName: username[0]!.toUpperCase() + username.slice(1), ...extra });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
  return { cookie: sessionCookie(login) };
}

describe("game requests", () => {
  it("lets anyone ask, admins approve onto the wanted list or decline, and shows when it's ready", async () => {
    const { app, ctx } = await makeApp(root, { apiToken: "svc" });
    const sam = await person(app, ctx, "sam", { kidMode: true });
    const ana = await person(app, ctx, "ana");
    const admin = await person(app, ctx, "boss", { role: "admin" });

    const ask = await app.inject({ method: "POST", url: "/api/requests", headers: sam, payload: { title: "Hollow Knight", note: "pleeease" } });
    assert.equal(ask.statusCode, 200, "kid profiles can ask too");
    assert.equal(ask.json().status, "pending");
    assert.equal(ask.json().requestedBy.name, "Sam");
    const again = await app.inject({ method: "POST", url: "/api/requests", headers: sam, payload: { title: "hollow knight" } });
    assert.equal(again.json().id, ask.json().id, "asking twice is one request");
    await app.inject({ method: "POST", url: "/api/requests", headers: ana, payload: { title: "Celeste" } });
    assert.equal((await app.inject({ method: "POST", url: "/api/requests", headers: ana, payload: { title: " " } })).statusCode, 400);

    assert.deepEqual((await app.inject({ url: "/api/requests", headers: sam })).json().map((r: { title: string }) => r.title), ["Hollow Knight"], "people see their own");
    assert.equal((await app.inject({ url: "/api/requests", headers: admin })).json().length, 2, "admins see everyone's");
    const alerts = ctx.db.prepare("SELECT title FROM notifications WHERE kind = 'requests'").all() as Array<{ title: string }>;
    assert.deepEqual(alerts.map((a) => a.title).sort(), ["Ana asked for Celeste", "Sam asked for Hollow Knight"]);

    assert.equal((await app.inject({ method: "POST", url: `/api/requests/${ask.json().id}/approve`, headers: sam })).statusCode, 403);
    const ok = await app.inject({ method: "POST", url: `/api/requests/${ask.json().id}/approve`, headers: admin });
    assert.equal(ok.json().status, "searching");
    const wish = ctx.wishlist.list().find((w) => w.title === "Hollow Knight")!;
    assert.ok(wish.monitored, "on the wanted list");
    assert.equal(wish.sources[0]!.name, "Requested by Sam");
    assert.equal((await app.inject({ method: "DELETE", url: `/api/requests/${ask.json().id}`, headers: sam })).statusCode, 400, "decided requests stay");

    const celeste = (await app.inject({ url: "/api/requests", headers: ana })).json()[0];
    const no = await app.inject({ method: "POST", url: `/api/requests/${celeste.id}/decline`, headers: admin, payload: { reason: "Already on Steam" } });
    assert.equal(no.json().status, "declined");
    assert.equal(no.json().reason, "Already on Steam");

    // A game with the title arrives: the request is ready and links to it.
    const portal = await app.inject({ method: "POST", url: "/api/requests", headers: ana, payload: { title: "Portal 2" } });
    assert.equal(portal.json().status, "ready");
    assert.ok(portal.json().libraryId);
    const mine = await app.inject({ method: "POST", url: "/api/requests", headers: ana, payload: { title: "Hades" } });
    assert.equal((await app.inject({ method: "DELETE", url: `/api/requests/${mine.json().id}`, headers: ana })).statusCode, 200, "withdrawn while waiting");
    await app.close();
  });
});
