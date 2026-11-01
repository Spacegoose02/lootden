import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

describe("truck mods", () => {
  it("keeps mods for every PC, replaces updates and lets only their owner or an admin delete them", async () => {
    const { app, ctx } = await makeApp(root);
    const token = async (name: string, role: "admin" | "user" = "user", kid = false) => {
      const u = await ctx.users.create({ username: name, password: "password1", role });
      if (kid) ctx.db.prepare("UPDATE users SET kid_mode = 1 WHERE id = ?").run(u.id);
      return { authorization: `Bearer ${ctx.auth.createApiToken(u.id, "t").token}` };
    };
    const alice = await token("alice");
    const bob = await token("bob");
    const admin = await token("boss", "admin");
    const kid = await token("kiddo", "user", true);
    const upload = (headers: object, qs: string, body: string) =>
      app.inject({ method: "POST", url: `/api/truck-mods?${qs}`, headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from(body) });

    const first = await upload(alice, "game=ats&name=w900.scs&source=https%3A%2F%2Ftruckymods.io%2Fats%2Fw900&version=2.4&compat=1.53.*,bogus", "w900 v1");
    assert.equal(first.statusCode, 200);
    const mod = first.json();
    assert.equal(mod.title, "w900");
    assert.equal(mod.sizeBytes, 7);
    assert.equal(mod.sourceUrl, "https://truckymods.io/ats/w900");
    assert.equal(mod.canDelete, true);
    assert.equal(mod.modVersion, "2.4");
    assert.deepEqual(mod.compatibleVersions, ["1.53.*"]);

    // Everyone sees it; only for its own game.
    const list = (await app.inject({ url: "/api/truck-mods?game=ats", headers: bob })).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].addedBy, "alice");
    assert.equal(list[0].canDelete, false);
    assert.deepEqual((await app.inject({ url: "/api/truck-mods?game=ets2", headers: bob })).json(), []);
    assert.equal((await app.inject({ url: "/api/truck-mods?game=portal", headers: bob })).statusCode, 400);

    const file = await app.inject({ url: `/api/truck-mods/${mod.id}/file`, headers: bob });
    assert.equal(file.body, "w900 v1");
    assert.match(String(file.headers["content-disposition"]), /w900\.scs/);

    // The same file name again is a newer version of the same mod.
    const again = await upload(bob, "game=ats&name=W900.scs&title=Kenworth%20W900", "w900 v2!");
    assert.equal(again.json().id, mod.id);
    assert.equal(again.json().title, "Kenworth W900");
    assert.equal((await app.inject({ url: `/api/truck-mods/${mod.id}/file`, headers: alice })).body, "w900 v2!");
    assert.equal((await app.inject({ url: "/api/truck-mods?game=ats", headers: alice })).json().length, 1);

    // Not mods, empty files and kid profiles are turned away.
    assert.equal((await upload(alice, "game=ats&name=setup.exe", "exe")).statusCode, 400);
    assert.equal((await upload(alice, "game=ats&name=empty.scs", "")).statusCode, 400);
    assert.equal((await upload(kid, "game=ats&name=x.scs", "x")).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/truck-mods?game=ats", headers: kid })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/truck-mods?game=ats" })).statusCode, 401);

    // Bob didn't add it (he only updated it), so he can't delete or rename it; Alice and admins can.
    assert.equal((await app.inject({ method: "DELETE", url: `/api/truck-mods/${mod.id}`, headers: bob })).statusCode, 404);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/truck-mods/${mod.id}`, headers: bob, payload: { title: "Mine" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/truck-mods/${mod.id}`, headers: alice, payload: { title: "W900 classic" } })).json().title, "W900 classic");
    const other = (await upload(bob, "game=ets2&name=promods.zip", "zip")).json();
    assert.equal((await app.inject({ method: "DELETE", url: `/api/truck-mods/${other.id}`, headers: admin })).statusCode, 200);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/truck-mods/${mod.id}`, headers: alice })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/truck-mods/${mod.id}/file`, headers: alice })).statusCode, 404);
    await app.close();
  });
});
