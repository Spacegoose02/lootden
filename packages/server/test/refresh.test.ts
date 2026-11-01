import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { PcCommand } from "@lootden/shared";
import { makeApp } from "./helpers.js";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gm-refresh-"));
  await mkdir(path.join(root, "Stardew Valley v1.5"));
  await writeFile(path.join(root, "Stardew Valley v1.5", "Stardew Valley.exe"), Buffer.alloc(20_000));
  await mkdir(path.join(root, "Updates"));
  await writeFile(path.join(root, "Updates", "Stardew Valley Update v1.6.zip"), Buffer.alloc(500));
  await writeFile(path.join(root, "Updates", "Stardew Valley Update v1.7.zip"), Buffer.alloc(500));
  await mkdir(path.join(root, "DLC"));
  await writeFile(path.join(root, "DLC", "Stardew Valley DLC Soundtrack.zip"), Buffer.alloc(500));
  await mkdir(path.join(root, "Celeste v1.0"));
  await writeFile(path.join(root, "Celeste v1.0", "Celeste.exe"), Buffer.alloc(20_000));
});
after(() => rm(root, { recursive: true, force: true }));

describe("refreshing the library copy from a PC", () => {
  it("spots a PC with a newer copy, has it upload with a one-time ticket, and moves out the old copy and its updates", async () => {
    const { app, ctx } = await makeApp(root, { apiToken: "svc" });
    const admin = { authorization: "Bearer svc" };
    const player = await ctx.users.create({ username: "player", password: "password1" });
    const asPlayer = { authorization: `Bearer ${ctx.auth.createApiToken(player.id, "t").token}` };
    const stardew = ctx.library.list({}).find((g) => g.title.startsWith("Stardew"))!;
    const celeste = ctx.library.list({}).find((g) => g.title.startsWith("Celeste"))!;
    assert.equal(stardew.latestVersion, "1.7");

    const beat = (copies: Array<{ gameId: string; version: string; fromExe?: boolean }>) =>
      app.inject({ method: "POST", url: "/api/me/presence", headers: asPlayer, payload: { device: "KIDS-PC", playing: [], pc: { copies } } });
    // Behind the newest update, and level with the library: nothing to refresh.
    await beat([
      { gameId: stardew.id, version: "1.6" },
      { gameId: celeste.id, version: "1.0" },
    ]);
    assert.deepEqual((await app.inject({ url: "/api/library/refresh", headers: admin })).json().candidates, []);

    await beat([
      { gameId: stardew.id, version: "1.7.1", fromExe: true },
      { gameId: celeste.id, version: "1.0" },
    ]);
    assert.equal((await app.inject({ url: "/api/library/refresh", headers: asPlayer })).statusCode, 403);
    const { candidates } = (await app.inject({ url: "/api/library/refresh", headers: admin })).json();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].gameId, stardew.id);
    assert.deepEqual(candidates[0].pcs, [{ device: "KIDS-PC", version: "1.7.1", fromExe: true, online: true }]);
    assert.deepEqual(candidates[0].updates.map((u: { version: string }) => u.version).sort(), ["1.6", "1.7"]);

    assert.equal((await app.inject({ method: "POST", url: `/api/games/${stardew.id}/refresh`, headers: admin, payload: { device: "OTHER-PC" } })).statusCode, 400);
    const start = await app.inject({ method: "POST", url: `/api/games/${stardew.id}/refresh`, headers: admin, payload: { device: "KIDS-PC" } });
    assert.equal(start.statusCode, 200, start.body);
    assert.equal((await app.inject({ method: "POST", url: `/api/games/${stardew.id}/refresh`, headers: admin, payload: { device: "KIDS-PC" } })).statusCode, 400, "one at a time");

    // The PC hears about it with its next heartbeat.
    const commands = (await beat([{ gameId: stardew.id, version: "1.7.1", fromExe: true }])).json().commands as PcCommand[];
    const cmd = commands.find((c) => c.kind === "refresh-copy");
    assert.ok(cmd && cmd.kind === "refresh-copy");
    assert.equal(cmd.version, "1.7.1");

    const part = (h: object, upload = "upload-1234") =>
      app.inject({ method: "PUT", url: `/api/games/${stardew.id}/prepared/parts/${upload}?offset=0`, headers: { ...h, "content-type": "application/octet-stream" }, payload: Buffer.alloc(20_000, "PK") });
    assert.equal((await part(asPlayer)).statusCode, 403, "a player needs the ticket");
    assert.equal((await part({ ...asPlayer, "x-lootden-ticket": "wrong" })).statusCode, 403);
    const withTicket = { ...asPlayer, "x-lootden-ticket": cmd.ticket };
    assert.equal((await part(withTicket)).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/library/refresh", headers: admin })).json().jobs[0].state, "uploading");
    const done = await app.inject({ method: "POST", url: `/api/games/${stardew.id}/prepared/parts/upload-1234/finish?version=9`, headers: withTicket });
    assert.equal(done.statusCode, 200, done.body);
    const game = done.json();
    assert.equal(game.source, "Stardew Valley v1.7.1.zip", "the ticket's version, not the query's");
    assert.equal(game.version, "1.7.1");
    assert.deepEqual(game.addons.map((a: { kind: string }) => a.kind), ["dlc"], "DLC stays, the updates are gone");

    const replaced = (await readdir(path.join(root, ".replaced"))).map((n) => n.replace(/^\d+-/, "")).sort();
    assert.deepEqual(replaced, ["Stardew Valley v1.5", "Updates - Stardew Valley Update v1.6.zip", "Updates - Stardew Valley Update v1.7.zip"]);
    const { jobs, candidates: after } = (await app.inject({ url: "/api/library/refresh", headers: admin })).json();
    assert.equal(jobs[0].state, "done");
    assert.equal(jobs[0].newGameId, game.id);
    assert.deepEqual(after, []);
    assert.equal((await part(withTicket, "upload-5678")).statusCode, 403, "the ticket works once");
    await app.close();
  });

  it("records a PC that couldn't do it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gm-refresh-fail-"));
    await mkdir(path.join(dir, "Hades v1.0"));
    await writeFile(path.join(dir, "Hades v1.0", "Hades.exe"), Buffer.alloc(1000));
    const { app, ctx } = await makeApp(dir, { apiToken: "svc" });
    const admin = { authorization: "Bearer svc" };
    const hades = ctx.library.list({})[0]!;
    await app.inject({ method: "POST", url: "/api/me/presence", headers: admin, payload: { device: "DEN-PC", playing: [], pc: { copies: [{ gameId: hades.id, version: "1.1" }] } } }).catch(() => null);
    const player = await ctx.users.create({ username: "p2", password: "password1" });
    const asPlayer = { authorization: `Bearer ${ctx.auth.createApiToken(player.id, "t").token}` };
    await app.inject({ method: "POST", url: "/api/me/presence", headers: asPlayer, payload: { device: "DEN-PC", playing: [], pc: { copies: [{ gameId: hades.id, version: "1.1" }] } } });
    const job = (await app.inject({ method: "POST", url: `/api/games/${hades.id}/refresh`, headers: admin, payload: { device: "DEN-PC" } })).json();
    await app.inject({ method: "POST", url: `/api/library/refresh/${job.ticket}/fail`, headers: asPlayer, payload: { message: "Hades is being played on this PC." } });
    const jobs = (await app.inject({ url: "/api/library/refresh", headers: admin })).json().jobs;
    assert.equal(jobs[0].state, "failed");
    assert.equal(jobs[0].message, "Hades is being played on this PC.");
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
});
