import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp, loadConfig, openDatabase } from "@lootden/server/lib";
import { GameServerClient } from "../src/api.js";
import { findSevenZip } from "../src/extractor.js";
import { installGame, pickGame } from "../src/installer.js";
import { DownloadQueue, QueueHold } from "../src/queue.js";
import { inWindow, RateLimiter } from "../src/throttle.js";
import { repairGame, verifyGame } from "../src/verify.js";

describe("download speed limit", () => {
  it("holds bytes back to the limit, shared by everything that takes from it", async () => {
    let t = 0;
    const slept: number[] = [];
    const lim = new RateLimiter(
      () => 1000,
      () => t,
      async (ms) => {
        slept.push(ms);
        t += ms;
      },
    );
    for (let i = 0; i < 5; i++) await lim.take(500);
    // 2,500 bytes at 1,000 a second, starting empty: about 2.5 seconds.
    assert.ok(t >= 2400 && t <= 2600, `took ${t}ms`);
    const free = new RateLimiter(() => 0);
    await free.take(10_000_000);
    assert.equal(free.limit(), 0, "0 is no limit");
  });

  it("knows overnight windows", () => {
    const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
    const night = { from: "23:00", to: "07:00" };
    assert.equal(inWindow(night, at(23, 30)), true);
    assert.equal(inWindow(night, at(3)), true);
    assert.equal(inWindow(night, at(7)), false);
    assert.equal(inWindow(night, at(12)), false);
    assert.equal(inWindow({ from: "09:00", to: "17:00" }, at(12)), true);
    assert.equal(inWindow(null, at(12)), true);
    assert.equal(inWindow({ from: "bad", to: "07:00" }, at(12)), true, "a broken window doesn't block downloads");
  });
});

describe("download queue", () => {
  /** A job that runs until released (or stopped), counting its starts. */
  function job() {
    const j = { starts: 0, release: () => {}, signal: null as AbortSignal | null };
    const run = (signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        j.starts++;
        j.signal = signal;
        j.release = () => resolve("done");
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    return { j, run };
  }
  const tick = () => new Promise((r) => setImmediate(r));

  it("runs one at a time in order, moves, pauses and resumes", async () => {
    const q = new DownloadQueue({ maxConcurrent: () => 1, window: () => null });
    const a = job();
    const b = job();
    const c = job();
    const pa = q.add("a", "A", a.run);
    const pb = q.add("b", "B", b.run);
    const pc = q.add("c", "C", c.run);
    assert.deepEqual(q.list().map((i) => `${i.id}:${i.state}`), ["a:running", "b:queued", "c:queued"]);
    await assert.rejects(q.add("a", "A", a.run), /Already in the download queue/);

    // C to the top: it takes A's place and A waits (resuming later).
    q.move("c", "top");
    await tick();
    assert.deepEqual(q.list().map((i) => `${i.id}:${i.state}`), ["c:running", "a:queued", "b:queued"]);
    assert.ok(a.j.signal!.aborted && a.j.signal!.reason instanceof QueueHold);

    q.pause("c");
    await tick();
    assert.deepEqual(q.list().map((i) => `${i.id}:${i.state}`), ["c:paused", "a:running", "b:queued"]);
    assert.equal(a.j.starts, 2, "A started again");
    assert.equal(q.list()[0]!.note, "Paused");

    a.j.release();
    assert.equal(await pa, "done");
    await tick();
    assert.deepEqual(q.list().map((i) => `${i.id}:${i.state}`), ["c:paused", "b:running"]);
    q.resume("c");
    await tick();
    assert.deepEqual(q.list().map((i) => `${i.id}:${i.state}`), ["c:running", "b:queued"]);
    q.cancel("b");
    await assert.rejects(pb, /Cancelled/);
    c.j.release();
    assert.equal(await pc, "done");
    assert.deepEqual(q.list(), []);
    q.close();
  });

  it("waits for the download window, and stops when it closes", async () => {
    let hour = 12;
    const q = new DownloadQueue({ maxConcurrent: () => 2, window: () => ({ from: "01:00", to: "06:00" }), clock: () => new Date(2026, 0, 1, hour) });
    const a = job();
    const b = job();
    const pa = q.add("a", "A", a.run);
    void q.add("b", "B", b.run).catch(() => {});
    assert.deepEqual(q.list().map((i) => `${i.state}:${i.note}`), ["waiting:Waits for 01:00", "waiting:Waits for 01:00"]);
    assert.equal(a.j.starts, 0);
    hour = 2;
    q.pump();
    assert.deepEqual(q.list().map((i) => i.state), ["running", "running"], "two at once");
    hour = 7;
    q.pump();
    await tick();
    assert.deepEqual(q.list().map((i) => i.state), ["waiting", "waiting"]);
    hour = 3;
    q.pump();
    a.j.release();
    assert.equal(await pa, "done");
    q.cancel("b");
    q.close();
  });
});

describe("verify and repair", () => {
  let work: string;
  let app: FastifyInstance;
  let api: GameServerClient;

  before(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), "gm-verify-"));
    const games = path.join(work, "games");
    await mkdir(path.join(games, "Folder Game", "bin"), { recursive: true });
    await writeFile(path.join(games, "Folder Game", "bin", "game.exe"), "x".repeat(300_000));
    await writeFile(path.join(games, "Folder Game", "data.pak"), "pak".repeat(1000));
    await writeFile(path.join(games, "Folder Game", "settings.ini"), "volume=5");
    const staging = path.join(work, "staging", "Packed Game");
    await mkdir(path.join(staging, "Data"), { recursive: true });
    await writeFile(path.join(staging, "Packed.exe"), "y".repeat(100_000));
    await writeFile(path.join(staging, "Data", "level1.bin"), "level one");
    const sevenZip = (await findSevenZip(""))!.path;
    execFileSync(sevenZip, ["a", "-tzip", path.join(games, "Packed Game.zip"), staging], { stdio: "ignore" });
    const built = buildApp({ ...loadConfig({}), gamesDir: games, dataDir: path.join(work, "data"), apiToken: "t0ken", logLevel: "silent" }, openDatabase(":memory:"));
    app = built.app;
    await built.ctx.library.rescan();
    api = new GameServerClient({ serverUrl: await app.listen({ host: "127.0.0.1", port: 0 }), apiToken: "t0ken" });
  });
  after(async () => {
    await app.close();
    await rm(work, { recursive: true, force: true });
  });

  it("finds missing and damaged files in a folder game and downloads just those again, under a speed limit", async () => {
    const game = pickGame(await api.listGames(), "Folder Game");
    const dir = await installGame(api, game.id, { installDir: path.join(work, "pc"), keepArchives: false, sevenZipPath: "" });
    assert.deepEqual(await verifyGame(api, game.id, dir), { basis: "install", checked: 3, missing: [], changed: [] });

    await rm(path.join(dir, "data.pak"));
    await writeFile(path.join(dir, "bin", "game.exe"), "z".repeat(300_000));
    await writeFile(path.join(dir, "settings.ini"), "volume=10 and more settings");
    const found = await verifyGame(api, game.id, dir);
    assert.deepEqual(found.missing, ["data.pak"]);
    assert.deepEqual(found.changed, ["bin/game.exe"], "settings files may change");

    const fixed = await repairGame(api, game.id, dir, [...found.missing, ...found.changed], { sevenZipPath: "", limiter: new RateLimiter(() => 50 * 1024 * 1024) });
    assert.equal(fixed, 2);
    assert.equal(await readFile(path.join(dir, "bin", "game.exe"), "utf8"), "x".repeat(300_000));
    assert.equal(await readFile(path.join(dir, "settings.ini"), "utf8"), "volume=10 and more settings", "left alone");
    assert.deepEqual((await verifyGame(api, game.id, dir)).changed, []);
  });

  it("repairs a game that came as an archive by unpacking to one side", async () => {
    const game = pickGame(await api.listGames(), "Packed Game");
    const dir = await installGame(api, game.id, { installDir: path.join(work, "pc"), keepArchives: false, sevenZipPath: "" });
    await rm(path.join(dir, "Data", "level1.bin"));
    await writeFile(path.join(dir, "mod.txt"), "my own mod");
    const found = await verifyGame(api, game.id, dir);
    assert.deepEqual(found.missing, ["Data/level1.bin"]);
    assert.equal(await repairGame(api, game.id, dir, found.missing, { sevenZipPath: "" }), 1);
    assert.equal(await readFile(path.join(dir, "Data", "level1.bin"), "utf8"), "level one");
    assert.equal(await readFile(path.join(dir, "mod.txt"), "utf8"), "my own mod", "the person's own files stay");
    assert.deepEqual(await verifyGame(api, game.id, dir), { basis: "install", checked: 3, missing: [], changed: [] });
  });

  it("checks older folder-game installs against the server", async () => {
    const game = pickGame(await api.listGames(), "Folder Game");
    const dir = path.join(work, "old", "Folder Game");
    await mkdir(path.join(dir, "bin"), { recursive: true });
    await writeFile(path.join(dir, "bin", "game.exe"), "x".repeat(300_000));
    const r = await verifyGame(api, game.id, dir);
    assert.equal(r.basis, "server");
    assert.deepEqual(r.missing.sort(), ["data.pak", "settings.ini"]);
  });
});
