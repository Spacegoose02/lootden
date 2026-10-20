import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setupKindOf } from "@lootden/shared";
import { makeApp } from "./helpers.js";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gm-prepare-"));
  await mkdir(path.join(root, "Old Game (Disc)"));
  await writeFile(path.join(root, "Old Game (Disc)", "OLDGAME.iso"), "iso");
  await mkdir(path.join(root, "Repack Game"));
  await writeFile(path.join(root, "Repack Game", "setup.exe"), "exe");
  await writeFile(path.join(root, "Repack Game", "data-01.bin"), "bin");
});
after(() => rm(root, { recursive: true, force: true }));

describe("disc and installer games", () => {
  it("spots discs and installers", () => {
    assert.equal(setupKindOf([{ path: "game.iso" }]), "disc");
    assert.equal(setupKindOf([{ path: "Game/setup.exe" }, { path: "Game/setup-1.bin" }]), "installer");
    assert.equal(setupKindOf([{ path: "setup_game_1.0.exe" }]), "installer");
    assert.equal(setupKindOf([{ path: "bin/game.exe" }, { path: "data/a.pak" }, { path: "readme.txt" }]), null);
  });

  it("spots repacks, GOG offline installers, MSIs and other disc formats, but not installed games", () => {
    const repack = ["setup.exe", "fg-01.bin", "fg-02.bin", "fg-optional-bonus-content.bin", "Verify BIN files before installation.bat", "MD5/fitgirl-bins.md5", ".game-manager.json"];
    assert.equal(setupKindOf(repack.map((path) => ({ path }))), "installer");
    assert.equal(setupKindOf([{ path: "setup_occupy_mars_1.0.exe" }, { path: "setup_occupy_mars_1.0-1.bin" }, { path: "setup_occupy_mars_1.0-2.bin" }]), "installer");
    assert.equal(setupKindOf([{ path: "Game Installer.msi" }, { path: "readme.txt" }]), "installer");
    assert.equal(setupKindOf([{ path: "Disc/setup.exe" }, { path: "Disc/data1.cab" }, { path: "Disc/data1.hdr" }]), "installer");
    assert.equal(setupKindOf([{ path: "game.mdf" }, { path: "game.mds" }]), "disc");
    assert.equal(setupKindOf([{ path: "game.cue" }, { path: "game.bin" }]), "disc");
    // Installed games: their own executable beside an uninstaller or a settings program.
    assert.equal(setupKindOf([{ path: "OccupyMars.exe" }, { path: "unins000.exe" }, { path: "unins000.dat" }]), null);
    assert.equal(setupKindOf([{ path: "Game.exe" }, { path: "Setup.exe" }, { path: "data.pak" }]), null);
    assert.equal(setupKindOf([{ path: "Game.exe" }, { path: "_CommonRedist/vcredist/setup.exe" }]), null);
    assert.equal(setupKindOf([{ path: "game.exe" }, { path: "resources.bin" }]), null);
  });

  it("replaces a disc game with the uploaded install and keeps its data", async () => {
    const { app, ctx } = await makeApp(root, { apiToken: "svc" });
    const headers = { authorization: "Bearer svc" };
    const disc = ctx.library.list({}).find((g) => g.needsSetup === "disc")!;
    assert.equal(ctx.library.list({}).find((g) => g.source === "Repack Game")!.needsSetup, "installer");
    ctx.library.setOverrides(disc.id, { title: "Old Game" });
    const user = await ctx.users.create({ username: "player", password: "password1" });
    const asUser = { authorization: `Bearer ${ctx.auth.createApiToken(user.id, "t").token}` };
    const upload = (h: object, body = "PK-installed") =>
      app.inject({ method: "PUT", url: `/api/games/${disc.id}/prepared?version=1.1`, headers: { ...h, "content-type": "application/octet-stream" }, payload: Buffer.from(body) });

    assert.equal((await upload(asUser)).statusCode, 403);
    const res = await upload(headers);
    assert.equal(res.statusCode, 200, res.body);
    const game = res.json();
    assert.equal(game.source, "Old Game v1.1.zip");
    assert.equal(game.title, "Old Game", "title override carried over");
    assert.equal(game.needsSetup, null);
    assert.equal(ctx.library.get(disc.id), undefined);
    assert.deepEqual((await readdir(path.join(root, ".replaced"))).map((n) => n.replace(/^\d+-/, "")), ["Old Game (Disc)"]);
    assert.equal((await upload(headers)).statusCode, 404, "the old id is gone");
    await app.close();
  });
});

describe("installed games uploaded in parts", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gm-parts-"));
    await mkdir(path.join(dir, "Big Game"));
    await writeFile(path.join(dir, "Big Game", "setup.exe"), "exe");
    await writeFile(path.join(dir, "Big Game", "data-01.bin"), "bin");
    // Left behind by an earlier try that failed after the zip landed.
    await writeFile(path.join(dir, "Big Game.zip"), "PK-old");
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("appends the parts in order, resumes after a lost part and swaps the game in", async () => {
    const { app, ctx } = await makeApp(dir, { apiToken: "svc" });
    const headers = { authorization: "Bearer svc", "content-type": "application/octet-stream" };
    const game = ctx.library.list({}).find((g) => g.source === "Big Game")!;
    const url = `/api/games/${game.id}/prepared/parts/upload-1234`;
    const part = (offset: number, body: string) => app.inject({ method: "PUT", url: `${url}?offset=${offset}`, headers, payload: Buffer.from(body) });

    assert.equal((await part(0, "PK-ins")).json().size, 6);
    assert.equal((await part(10, "lost")).statusCode, 409, "a gap is refused");
    assert.equal((await app.inject({ method: "GET", url, headers: { authorization: "Bearer svc" } })).json().size, 6);
    assert.equal((await part(6, "talled")).json().size, 12);
    assert.equal((await app.inject({ method: "PUT", url: `/api/games/${game.id}/prepared/parts/x?offset=0`, headers, payload: "x" })).statusCode, 400, "bad upload ids are refused");

    const res = await app.inject({ method: "POST", url: `${url}/finish`, headers: { authorization: "Bearer svc" } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().source, "Big Game (2).zip", "the taken name gets a number instead of failing");
    assert.equal(await readFile(path.join(dir, "Big Game (2).zip"), "utf8"), "PK-installed");
    assert.ok(!(await readdir(dir)).some((n) => n.endsWith(".part")), "no part file left behind");
    await app.close();
  });
});

describe("deleting games", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gm-delete-"));
    for (const name of ["Keep Me", "Bin Me", "Gone For Good"]) {
      await mkdir(path.join(dir, name));
      await writeFile(path.join(dir, name, "game.exe"), "exe");
    }
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("moves the files to .deleted, or removes them for good, and only for admins", async () => {
    const { app, ctx } = await makeApp(dir, { apiToken: "svc" });
    const id = (source: string) => ctx.library.list({}).find((g) => g.source === source)!.id;
    const user = await ctx.users.create({ username: "player", password: "password1" });
    const asUser = { authorization: `Bearer ${ctx.auth.createApiToken(user.id, "t").token}` };
    const admin = { authorization: "Bearer svc" };

    assert.equal((await app.inject({ method: "DELETE", url: `/api/games/${id("Bin Me")}`, headers: asUser })).statusCode, 403);
    const binned = id("Bin Me");
    assert.equal((await app.inject({ method: "DELETE", url: `/api/games/${binned}`, headers: admin })).statusCode, 200);
    assert.equal(ctx.library.get(binned), undefined);
    assert.deepEqual((await readdir(path.join(dir, ".deleted"))).map((n) => n.replace(/^\d+-/, "")), ["Bin Me"]);

    assert.equal((await app.inject({ method: "DELETE", url: `/api/games/${id("Gone For Good")}?permanent=true`, headers: admin })).statusCode, 200);
    assert.deepEqual((await readdir(dir)).sort(), [".deleted", "Keep Me"]);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/games/${binned}`, headers: admin })).statusCode, 404);
    assert.deepEqual(ctx.library.list({}).map((g) => g.source), ["Keep Me"]);
    await app.close();
  });
});
