import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { LocalStoreGame } from "@lootden/shared";
import { ActivityBoard, type ActivityItem } from "../src/activity.js";
import { StoreGamesCache } from "../src/stores/cache.js";

let work: string;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "gm-background-"));
});
after(() => rm(work, { recursive: true, force: true }));

const game = (id: string): LocalStoreGame => ({ addon: "steam", externalId: id, title: `Game ${id}`, installDir: `C:\\Steam\\${id}` }) as LocalStoreGame;

describe("store games cache", () => {
  it("answers from the last scan and rescans in the background once it's old", async () => {
    let now = 0;
    let scans = 0;
    let result = [game("1")];
    const updates: LocalStoreGame[][] = [];
    const cache = new StoreGamesCache({ file: null, maxAgeMs: 1000, clock: () => now, onUpdate: (g) => updates.push(g), scan: async () => (scans++, result) });
    assert.deepEqual(await cache.get({}), [game("1")]);
    assert.equal(scans, 1);
    // Fresh: no scan at all.
    now = 500;
    assert.deepEqual(await cache.get({}), [game("1")]);
    assert.equal(scans, 1);
    // Old: the old list comes back at once and a background scan reports the new game.
    now = 2000;
    result = [game("1"), game("2")];
    assert.deepEqual(await cache.get({}), [game("1")]);
    await cache.refresh({}); // joins the background scan
    assert.equal(scans, 2);
    assert.deepEqual(updates, [[game("1"), game("2")]]);
    assert.deepEqual(await cache.get({}), [game("1"), game("2")]);
  });

  it("keeps the scan on disk so the next start of the app doesn't wait", async () => {
    const file = path.join(work, "store-games.json");
    const first = new StoreGamesCache({ file, scan: async () => [game("7")] });
    await first.get({ folders: ["D:\\Games"] });
    let scanned = false;
    const second = new StoreGamesCache({ file, maxAgeMs: Infinity, scan: async () => ((scanned = true), []) });
    assert.deepEqual(await second.get({ folders: ["D:\\Games"] }), [game("7")]);
    assert.equal(scanned, false);
    // Other settings (a launcher switched off) don't use that scan.
    assert.deepEqual(await second.get({ disabled: ["steam"], folders: ["D:\\Games"] }), []);
    assert.equal(scanned, true);
  });

  it("runs one scan at a time and survives a damaged file", async () => {
    const file = path.join(work, "broken.json");
    await writeFile(file, "{not json");
    let scans = 0;
    const cache = new StoreGamesCache({ file, scan: async () => (scans++, await new Promise((r) => setTimeout(r, 20)), [game("3")]) });
    const [a, b] = await Promise.all([cache.get({}), cache.get({})]);
    assert.deepEqual(a, [game("3")]);
    assert.deepEqual(b, [game("3")]);
    assert.equal(scans, 1);
  });
});

describe("background activity", () => {
  it("tracks a job from start to end and reports each change", () => {
    const seen: ActivityItem[][] = [];
    const board = new ActivityBoard((items) => seen.push(items), () => new Date("2026-01-01T00:00:00Z"));
    board.start("u1", { kind: "update", title: "Patch 1.1", gameId: "g1", gameTitle: "Game" });
    board.update("u1", { message: "Downloading", received: 5, total: 10 });
    assert.deepEqual(board.get("u1"), {
      id: "u1",
      kind: "update",
      title: "Patch 1.1",
      gameId: "g1",
      gameTitle: "Game",
      message: "Downloading",
      received: 5,
      total: 10,
      unit: "bytes",
      rate: null,
      etaSeconds: null,
      cancellable: true,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    board.update("missing", { message: "ignored" });
    board.end("u1");
    assert.deepEqual(board.list(), []);
    assert.equal(seen.length, 3);
    assert.equal(seen[2]!.length, 0);
  });
});

describe("background job speed", () => {
  it("works out the speed and time left as a job counts up, and starts afresh on a new step", () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const board = new ActivityBoard(undefined, () => new Date(now));
    board.start("upload:g1", { kind: "upload", title: "Big Game", gameId: "g1", gameTitle: "Big Game" });
    board.update("upload:g1", { message: "Zipping", received: 0, total: 1000 });
    assert.equal(board.get("upload:g1")!.rate, null);
    now += 1000;
    board.update("upload:g1", { received: 100 });
    assert.equal(board.get("upload:g1")!.rate, 100);
    assert.equal(board.get("upload:g1")!.etaSeconds, 9);
    // The upload has a different total: its speed is measured from scratch.
    board.update("upload:g1", { message: "Uploading", received: 0, total: 900 });
    assert.equal(board.get("upload:g1")!.rate, null);
    assert.equal(board.get("upload:g1")!.etaSeconds, null);
    // A step with nothing to count clears them.
    board.update("upload:g1", { message: "Finishing", received: null, total: null });
    assert.equal(board.get("upload:g1")!.rate, null);
  });
});
