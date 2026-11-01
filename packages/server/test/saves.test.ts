import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { KEEP_SAVES, pcgwPathToTemplate } from "../src/saves/store.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

describe("save sync", () => {
  it("keeps each player's backups private and prunes old ones", async () => {
    const { app, ctx } = await makeApp(root);
    const [game] = ctx.library.list({});
    const token = async (name: string, role: "admin" | "user" = "user") => {
      const u = await ctx.users.create({ username: name, password: "password1", role });
      return { authorization: `Bearer ${ctx.auth.createApiToken(u.id, "t").token}` };
    };
    const alice = await token("alice");
    const bob = await token("bob");
    const admin = await token("boss", "admin");
    const url = `/api/games/${game!.id}/saves`;
    const upload = (headers: object, body: string) =>
      app.inject({ method: "POST", url: `${url}?device=Ally`, headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from(body) });

    const first = await upload(alice, "PK-save-1");
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().device, "Ally");
    assert.equal(first.json().size, 9);

    const got = await app.inject({ url: `${url}/${first.json().id}`, headers: alice });
    assert.equal(got.body, "PK-save-1");
    assert.equal(got.headers["content-type"], "application/zip");

    // Bob can't see or delete Alice's saves.
    assert.deepEqual((await app.inject({ url, headers: bob })).json(), []);
    assert.equal((await app.inject({ url: `${url}/${first.json().id}`, headers: bob })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: `${url}/${first.json().id}`, headers: bob })).statusCode, 404);

    assert.equal((await upload(alice, "")).statusCode, 400);
    for (let i = 2; i <= KEEP_SAVES + 2; i++) await upload(alice, `PK-save-${i}`);
    const list = (await app.inject({ url, headers: alice })).json();
    assert.equal(list.length, KEEP_SAVES);
    assert.equal((await app.inject({ url: `${url}/${first.json().id}`, headers: alice })).statusCode, 404);
    assert.equal((await app.inject({ url: "/api/saves", headers: alice })).json().length, 1);

    // A recomp's saves are marked and pruned on their own, so they never push out the emulator's.
    const recomp = (body: string, runner = "recomp:zelda64recomp") =>
      app.inject({ method: "POST", url: `${url}?device=Ally&runner=${encodeURIComponent(runner)}`, headers: { ...alice, "content-type": "application/octet-stream" }, payload: Buffer.from(body) });
    assert.equal((await recomp("PK-recomp", "../../etc")).statusCode, 400);
    for (let i = 1; i <= KEEP_SAVES + 1; i++) assert.equal((await recomp(`PK-recomp-${i}`)).json().runner, "recomp:zelda64recomp");
    const both = (await app.inject({ url, headers: alice })).json() as Array<{ runner: string | null }>;
    assert.equal(both.filter((b) => b.runner === "recomp:zelda64recomp").length, KEEP_SAVES);
    assert.equal(both.filter((b) => b.runner === null).length, KEEP_SAVES);

    // Save locations are set by admins.
    const body = { path: "%APPDATA%/Studio/Game" };
    assert.equal((await app.inject({ method: "PUT", url: `/api/games/${game!.id}/save-path`, headers: alice, payload: body })).statusCode, 403);
    const set = await app.inject({ method: "PUT", url: `/api/games/${game!.id}/save-path`, headers: admin, payload: body });
    assert.equal(set.json().savePath, "%APPDATA%/Studio/Game");
    assert.equal((await app.inject({ method: "PUT", url: `/api/games/${game!.id}/save-path`, headers: admin, payload: { path: "saves" } })).statusCode, 400);
    await app.close();
  });

  it("turns PCGamingWiki save paths into client templates", () => {
    assert.equal(pcgwPathToTemplate("{{p|appdata}}\\Studio\\Game\\"), "%APPDATA%/Studio/Game");
    assert.equal(pcgwPathToTemplate("{{p|game}}\\saves"), "{game}/saves");
    assert.equal(pcgwPathToTemplate("{{p|userprofile\\Documents}}\\My Games\\X"), "%DOCUMENTS%/My Games/X");
    assert.equal(pcgwPathToTemplate("{{p|steam}}\\userdata\\{{p|uid}}\\123"), null);
    assert.equal(pcgwPathToTemplate("HKEY_CURRENT_USER\\Software\\X"), null);
  });
});
