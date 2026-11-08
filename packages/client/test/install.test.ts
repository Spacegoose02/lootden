import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp, loadConfig, openDatabase } from "@lootden/server/lib";
import { GameServerClient } from "../src/api.js";
import { findSevenZip } from "../src/extractor.js";
import { installGame, MANIFEST_NAME, pickGame } from "../src/installer.js";
import { FILES_NAME } from "../src/verify.js";

let work: string;
let app: FastifyInstance;
let api: GameServerClient;
let sevenZip: string;
let ctx: ReturnType<typeof buildApp>["ctx"];

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "gm-e2e-"));
  const games = path.join(work, "games");
  const staging = path.join(work, "staging", "Sims Repack");
  await mkdir(path.join(staging, "Game"), { recursive: true });
  await writeFile(path.join(staging, "Game", "TS4.exe"), "pretend exe");
  await writeFile(path.join(staging, "readme.txt"), "hello");
  await mkdir(path.join(games, "Loose Game", "bin"), { recursive: true });
  await writeFile(path.join(games, "Loose Game", "bin", "game.exe"), "x".repeat(200_000));

  sevenZip = (await findSevenZip(""))!.path;
  // A root-level zip whose contents sit in one wrapper folder, like most repacks.
  execFileSync(sevenZip, ["a", "-tzip", path.join(games, "The Sims 4.zip"), staging], { stdio: "ignore" });
  // A folder game holding a split 7z archive.
  await mkdir(path.join(games, "Split Game"));
  execFileSync(sevenZip, ["a", "-t7z", "-v1k", "-mx0", path.join(games, "Split Game", "data.7z"), path.join(staging, "..", "..", "games", "Loose Game")], {
    stdio: "ignore",
  });

  // What a broken import left behind: a folder holding an empty archive.
  await mkdir(path.join(games, "Empty Game"));
  await writeFile(path.join(games, "Empty Game", "Empty.Game.rar"), "");

  const built = buildApp({ ...loadConfig({}), gamesDir: games, dataDir: path.join(work, "data"), apiToken: "t0ken", logLevel: "silent" }, openDatabase(":memory:"));
  app = built.app;
  ctx = built.ctx;
  await built.ctx.library.rescan();
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  api = new GameServerClient({ serverUrl: address, apiToken: "t0ken" });
});

after(async () => {
  await app.close();
  await rm(work, { recursive: true, force: true });
});

describe("install end to end", () => {
  it("downloads a zip, unpacks it, removes the archive and flattens the wrapper folder", async () => {
    const game = pickGame(await api.listGames(), "sims");
    const dir = await installGame(api, game.id, { installDir: path.join(work, "client"), keepArchives: false, sevenZipPath: "" });
    assert.equal(path.basename(dir), "The Sims 4");
    const entries = (await readdir(dir)).sort();
    assert.deepEqual(entries, [FILES_NAME, MANIFEST_NAME, "Game", "readme.txt"].sort());
    assert.equal(await readFile(path.join(dir, "Game", "TS4.exe"), "utf8"), "pretend exe");
    const manifest = JSON.parse(await readFile(path.join(dir, MANIFEST_NAME), "utf8"));
    assert.equal(manifest.gameId, game.id);
  });

  it("refuses a game whose archive is empty on the server, before downloading anything", async () => {
    const game = pickGame(await api.listGames(), "Empty Game");
    await assert.rejects(installGame(api, game.id, { installDir: path.join(work, "client3"), keepArchives: false, sevenZipPath: "" }), /Empty\.Game\.rar is empty \(0 bytes\) on the server/);
  });

  it("unpacks split 7z volumes once and deletes every volume", async () => {
    const game = pickGame(await api.listGames(), "Split Game");
    const detail = await api.getGame(game.id);
    assert.ok(detail.fileCount > 1, "expected several volumes");
    const dir = await installGame(api, game.id, { installDir: path.join(work, "client"), keepArchives: false, sevenZipPath: "" });
    const entries = await readdir(dir, { recursive: true });
    assert.ok(!entries.some((e) => /\.7z\.\d{3}$/.test(e)), `volumes left behind: ${entries.join(", ")}`);
    assert.equal((await readFile(path.join(dir, "bin", "game.exe"), "utf8")).length, 200_000);
  });

  it("keeps archives when asked and resumes a partial download", async () => {
    const game = pickGame(await api.listGames(), "Loose Game");
    const target = path.join(work, "client2", "Loose Game", "bin");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "game.exe.part"), "x".repeat(50_000));
    const dir = await installGame(api, game.id, { installDir: path.join(work, "client2"), keepArchives: true, sevenZipPath: "" });
    assert.equal((await readFile(path.join(dir, "bin", "game.exe"), "utf8")).length, 200_000);
    assert.ok(!(await readdir(target)).includes("game.exe.part"));
  });

  it("signs in with a password and reports the install to the player's profile", async () => {
    const user = await ctx.users.create({ username: "player1", password: "password1" });
    const base = api.fileUrl("x", 0).split("/api/")[0]!;
    const { token } = await new GameServerClient({ serverUrl: base, apiToken: "" }).login("player1", "password1", "Ally");
    const mine = new GameServerClient({ serverUrl: base, apiToken: token });
    const game = pickGame(await mine.listGames(), "sims");
    const dir = await installGame(mine, game.id, { installDir: path.join(work, "client3"), keepArchives: false, sevenZipPath: "", device: "Ally" });
    const [state] = ctx.users.gameStates(user.id);
    assert.equal(state?.gameId, game.id);
    assert.equal(state?.device, "Ally");
    assert.equal(state?.installPath, dir);
  });

  it("rejects requests without the token", async () => {
    const anon = new GameServerClient({ serverUrl: api.fileUrl("x", 0).split("/api/")[0]!, apiToken: "" });
    await assert.rejects(anon.listGames(), /401/);
  });
});
