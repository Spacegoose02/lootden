import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

describe("recomps list", () => {
  it("lets only admins add and remove recomps, and every player read the list", async () => {
    const { app, ctx } = await makeApp(root);
    const token = async (name: string, role: "admin" | "user") => {
      const u = await ctx.users.create({ username: name, password: "password1", role });
      return { authorization: `Bearer ${ctx.auth.createApiToken(u.id, "t").token}` };
    };
    const admin = await token("boss", "admin");
    const kid = await token("kid", "user");
    const body = { repo: "https://github.com/luckvj/streetball-revival", platform: "ps2", titles: ["NBA Street Vol. 2"] };

    assert.equal((await app.inject({ url: "/api/recomps" })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/recomps", headers: kid, payload: body })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/recomps", headers: admin, payload: { ...body, platform: "pc" } })).statusCode, 400);
    const added = await app.inject({ method: "POST", url: "/api/recomps", headers: admin, payload: body });
    assert.equal(added.statusCode, 200);
    // Adding the same repo again replaces it rather than listing it twice.
    await app.inject({ method: "POST", url: "/api/recomps", headers: admin, payload: { ...body, name: "Streetball Revival" } });
    const list = (await app.inject({ url: "/api/recomps", headers: kid })).json();
    assert.deepEqual(list.added.map((r: { name: string }) => r.name), ["Streetball Revival"]);
    assert.ok(list.builtIn.length >= 2);

    assert.equal((await app.inject({ method: "DELETE", url: "/api/recomps/streetballrevival", headers: kid })).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/recomps/streetballrevival", headers: admin })).statusCode, 200);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/recomps/streetballrevival", headers: admin })).statusCode, 404);
    await app.close();
  });
});
