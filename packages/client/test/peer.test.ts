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
import { checkTicket, installFromPeer, PeerShare } from "../src/peer.js";
import { verifyGame } from "../src/verify.js";

describe("LAN copies between PCs", () => {
  let work: string;
  let app: FastifyInstance;
  let pcA: GameServerClient;
  let pcB: GameServerClient;
  let share: PeerShare;
  let key = "";
  let installedOnA = "";

  before(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), "gm-peer-"));
    const games = path.join(work, "games");
    const staging = path.join(work, "staging", "Big Game");
    await mkdir(path.join(staging, "Data"), { recursive: true });
    await writeFile(path.join(staging, "Big.exe"), "b".repeat(250_000));
    await writeFile(path.join(staging, "Data", "world.pak"), "w".repeat(80_000));
    const sevenZip = (await findSevenZip(""))!.path;
    await mkdir(games, { recursive: true });
    execFileSync(sevenZip, ["a", "-tzip", path.join(games, "Big Game.zip"), staging], { stdio: "ignore" });
    const built = buildApp({ ...loadConfig({}), gamesDir: games, dataDir: path.join(work, "data"), logLevel: "silent" }, openDatabase(":memory:"));
    app = built.app;
    await built.ctx.library.rescan();
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const u = await built.ctx.users.create({ username: "dad", password: "password1", role: "admin" });
    pcA = new GameServerClient({ serverUrl: base, apiToken: built.ctx.auth.createApiToken(u.id, "A").token });
    pcB = new GameServerClient({ serverUrl: base, apiToken: built.ctx.auth.createApiToken(u.id, "B").token });
  });
  after(async () => {
    await share?.stop();
    await app.close();
    await rm(work, { recursive: true, force: true });
  });

  it("copies an installed game from another PC, already unpacked, with a ticket for that game only", async () => {
    const game = pickGame(await pcA.listGames(), "Big Game");
    installedOnA = await installGame(pcA, game.id, { installDir: path.join(work, "A"), keepArchives: false, sevenZipPath: "", device: "Den-PC" });

    // No PC shares it yet.
    assert.equal(await pcB.peerSource(game.id, "Kid-PC"), null);

    share = new PeerShare({ key: () => key, gameDir: async (id) => (id === game.id ? installedOnA : null), port: 0 });
    const port = await share.start();
    const answer = await pcA.presence({ device: "Den-PC", playing: [], pc: { addresses: ["127.0.0.1"], copies: [{ gameId: game.id, version: "1.0" }], peerPort: port } });
    key = answer.peerKey!;
    assert.ok(key, "the server hands the PC its key");

    // A PC doesn't copy from itself.
    assert.equal(await pcA.peerSource(game.id, "Den-PC"), null);
    const source = await pcB.peerSource(game.id, "Kid-PC");
    assert.ok(source);
    assert.equal(source.device, "Den-PC");
    assert.deepEqual(source.urls, [`http://127.0.0.1:${port}`]);
    assert.ok(checkTicket(source.ticket, key, game.id));
    assert.ok(!checkTicket(source.ticket, key, "another-game"), "for this game only");
    assert.ok(!checkTicket(source.ticket, key, game.id, Date.now() + 7 * 3600_000), "expires");
    assert.ok(!checkTicket(source.ticket.replace(/.$/, (c) => (c === "A" ? "B" : "A")), key, game.id), "can't be changed");

    const refused = await fetch(`${source.urls[0]}/lootden-peer/v1/games/${game.id}/files?t=nope`);
    assert.equal(refused.status, 403);

    const events: string[] = [];
    const dir = await installFromPeer(pcB, game.id, source, { installDir: path.join(work, "B"), device: "Kid-PC", onEvent: (e) => events.push(e.type) });
    assert.ok(events.includes("peer") && events.at(-1) === "done");
    assert.deepEqual((await readdir(dir)).filter((n) => !n.startsWith(".")).sort(), ["Big.exe", "Data"], "unpacked, nothing to extract");
    assert.equal(await readFile(path.join(dir, "Big.exe"), "utf8"), "b".repeat(250_000));
    assert.equal(JSON.parse(await readFile(path.join(dir, MANIFEST_NAME), "utf8")).gameId, game.id);
    const v = await verifyGame(pcB, game.id, dir);
    assert.deepEqual([v.basis, v.missing, v.changed], ["install", [], []]);
  });

  it("throws (so the app downloads from the server) when the PC can't be reached, and leaves no half copy", async () => {
    const game = pickGame(await pcB.listGames(), "Big Game");
    const target = path.join(work, "C");
    await assert.rejects(
      installFromPeer(pcB, game.id, { device: "Gone-PC", urls: ["http://127.0.0.1:1"], ticket: "x.y", version: null }, { installDir: target }),
      /Couldn't reach Gone-PC/,
    );
    await assert.rejects(readdir(path.join(target, "Big Game")));
  });
});
