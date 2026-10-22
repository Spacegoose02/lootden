import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { saveConnectorSettings } from "../src/connectors/settings.js";
import { makeApp, makeLibrary, sessionCookie } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

describe("security", () => {
  it("doesn't let %-encoded paths skip sign-in", async () => {
    const { app } = await makeApp(root);
    for (const url of ["/%61pi/library/stats", "/ap%69/news/feeds", "/%61pi/clients", "/%61pi/videos/groups"]) {
      assert.equal((await app.inject(url)).statusCode, 401, url);
    }
    assert.equal((await app.inject("/api/avatars/abc.svg")).statusCode, 200, "avatars stay public");
    await app.close();
  });

  it("sends headers against sniffing, framing and referrer leaks", async () => {
    const { app } = await makeApp(root);
    const res = await app.inject("/api/health");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(res.headers["referrer-policy"], "strict-origin-when-cross-origin");
    await app.close();
  });

  it("holds the login limit against a burst of parallel guesses", async () => {
    const { app, ctx } = await makeApp(root);
    await ctx.users.create({ username: "sam", password: "password1" });
    const tries = await Promise.all(
      Array.from({ length: 25 }, () => app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "sam", password: "wrong" } })),
    );
    assert.equal(tries.filter((r) => r.statusCode === 401).length, 10);
    assert.equal(tries.filter((r) => r.statusCode === 429).length, 15);
    const right = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "sam", password: "password1" } });
    assert.equal(right.statusCode, 429, "still locked out after the burst");
    await app.close();
  });

  it("signs other browsers out when the password changes", async () => {
    const { app, ctx } = await makeApp(root);
    const sam = await ctx.users.create({ username: "sam", password: "password1" });
    const login = () => app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "sam", password: "password1" } }).then(sessionCookie);
    const here = await login();
    const elsewhere = await login();
    const changed = await app.inject({ method: "POST", url: "/api/me/password", headers: { cookie: here }, payload: { currentPassword: "password1", newPassword: "password2" } });
    assert.equal(changed.statusCode, 200);
    assert.equal((await app.inject({ url: "/api/me", headers: { cookie: here } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/me", headers: { cookie: elsewhere } })).statusCode, 401);

    // An admin resetting someone's password signs them out everywhere.
    const admin = await ctx.users.create({ username: "boss", password: "password1", role: "admin" });
    const bossCookie = sessionCookie(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: admin.username, password: "password1" } }));
    const samCookie = sessionCookie(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "sam", password: "password2" } }));
    await app.inject({ method: "PATCH", url: `/api/users/${sam.id}`, headers: { cookie: bossCookie }, payload: { password: "password3" } });
    assert.equal((await app.inject({ url: "/api/me", headers: { cookie: samCookie } })).statusCode, 401);
    await app.close();
  });

  it("replaces a game that sits in a subfolder (Updates/, Emulation/)", async () => {
    const lib = await mkdtemp(path.join(os.tmpdir(), "gm-sec-"));
    await mkdir(path.join(lib, "Updates"));
    await writeFile(path.join(lib, "Updates", "Some Game Update v1.2.zip"), "zip");
    const { app, ctx } = await makeApp(lib);
    const old = ctx.library.list({ kind: "all" }).find((g) => g.title.includes("Some Game"))!;
    await writeFile(path.join(lib, "Some Game v1.2.zip"), "new");
    const replaced = await ctx.library.replaceGame(old.id, "Some Game v1.2.zip");
    assert.equal(replaced.source, "Some Game v1.2.zip");
    assert.equal((await readdir(path.join(lib, ".replaced"))).length, 1);
    await app.close();
    await rm(lib, { recursive: true, force: true });
  });

  it("skips symlinks inside a download when importing it", async () => {
    const lib = await mkdtemp(path.join(os.tmpdir(), "gm-sec-"));
    const downloads = await mkdtemp(path.join(os.tmpdir(), "gm-dl-"));
    const secret = path.join(downloads, "..", `${path.basename(downloads)}-secret.txt`);
    await writeFile(secret, "secret");
    await mkdir(path.join(downloads, "Cool Game"));
    await writeFile(path.join(downloads, "Cool Game", "game.exe"), "exe");
    await symlink(secret, path.join(downloads, "Cool Game", "loot.txt"));
    const { app, ctx } = await makeApp(lib);
    saveConnectorSettings(ctx.db, { import: { ...ctx.downloads.settings().import, folder: downloads, mode: "copy", tidy: { stripJunk: false, extract: false, repack: "folder" } } });
    const target = await ctx.downloads.importFromFolder("Cool Game");
    const files = await readdir(target);
    assert.deepEqual(files, ["game.exe"]);
    await app.close();
    await rm(lib, { recursive: true, force: true });
    await rm(downloads, { recursive: true, force: true });
    await rm(secret, { force: true });
  });
});
