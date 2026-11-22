import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { findSevenZip, type SevenZip } from "../src/extractor.js";
import { MANIFEST_NAME } from "../src/installer.js";
import { uninstallGame } from "../src/installed.js";
import { measureFolder, parseSevenZipProgress, zipFolder, type ZipProgress } from "../src/prepare.js";
import { formatEta, progressLine, RateMeter } from "../src/rate.js";

let work: string;
let sevenZip: SevenZip;

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "gm-progress-"));
  sevenZip = (await findSevenZip(""))!;
});
after(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("progress for long jobs", () => {
  it("reads 7-Zip's in-place progress lines", () => {
    const b = "\b".repeat(12);
    assert.deepEqual(parseSevenZipProgress(`  0M Scan${b}  0%${b} 12% 4 + Data\\f4.bin${b}`), { percent: 12, files: 4, current: "Data\\f4.bin" });
    assert.deepEqual(parseSevenZipProgress(" 75%"), { percent: 75, files: undefined, current: undefined });
    assert.equal(parseSevenZipProgress("Everything is Ok"), null);
  });

  it("measures speed and time left", () => {
    let t = 0;
    const m = new RateMeter(() => t);
    assert.equal(m.sample(0), null);
    t = 200;
    assert.equal(m.sample(50), null, "too soon after the first reading");
    t = 2000;
    assert.equal(m.sample(400), 200);
    assert.equal(m.eta(400, 1000), 3);
    assert.equal(formatEta(3), "3 s");
    assert.equal(formatEta(600), "10 min");
    assert.equal(formatEta(3900), "1 h 5 min");
  });

  it("writes one status line with percent, amounts, speed and time left", () => {
    const gb = 1024 ** 3;
    assert.equal(
      progressLine("Zipping the installed game", { done: 55.7 * gb, total: 123.8 * gb, files: 1234, totalFiles: 20000, rate: 200 * 1024 ** 2, etaSeconds: 360 }),
      "Zipping the installed game: 44% (55.7 GB of 123.8 GB, 1,234 of 20,000 files) · 200.0 MB/s · about 6 min left",
    );
    assert.equal(progressLine("Checking files", { done: 10, total: 40, unit: "files" }), "Checking files: 25% (10 of 40 files)");
    assert.equal(progressLine("Counting", { done: 0, total: 0 }), "Counting");
  });

  it("reports zipping progress, leaving LootDen's own files out", async () => {
    const game = path.join(work, "game");
    await mkdir(path.join(game, "data", ".lootden-backup"), { recursive: true });
    for (let i = 0; i < 4; i++) await writeFile(path.join(game, "data", `pak${i}.bin`), Buffer.alloc(2 * 1024 * 1024, i));
    await writeFile(path.join(game, "game.exe"), "MZ");
    await writeFile(path.join(game, "data", ".lootden-backup", "old.bin"), "backup");
    await writeFile(path.join(game, MANIFEST_NAME), "{}");
    const size = await measureFolder(game);
    assert.deepEqual(size, { bytes: 8 * 1024 * 1024 + 2, files: 5 });
    const seen: ZipProgress[] = [];
    await zipFolder(sevenZip, game, path.join(work, "out.zip"), { onProgress: (p) => seen.push(p) });
    assert.ok((await stat(path.join(work, "out.zip"))).size > 0);
    const end = seen.at(-1)!;
    assert.deepEqual([end.done, end.total, end.files, end.totalFiles], [size.bytes, size.bytes, 5, 5]);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i]!.done >= seen[i - 1]!.done, "never goes backwards");
  });

  it("stops zipping when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(zipFolder(sevenZip, path.join(work, "game"), path.join(work, "never.zip"), { signal: controller.signal, onProgress: () => {} }));
  });

  it("counts files down while uninstalling", async () => {
    const dir = path.join(work, "Installed Game");
    await mkdir(path.join(dir, "a", "b"), { recursive: true });
    await writeFile(path.join(dir, MANIFEST_NAME), JSON.stringify({ gameId: "g1", title: "Installed Game" }));
    await writeFile(path.join(dir, "a", "one.bin"), Buffer.alloc(1000));
    await writeFile(path.join(dir, "a", "b", "two.bin"), Buffer.alloc(3000));
    const seen: Array<{ done: number; total: number; files: number; totalFiles: number }> = [];
    await uninstallGame(dir, (p) => seen.push(p));
    await assert.rejects(stat(dir));
    assert.equal(seen[0]!.done, 0);
    assert.deepEqual(seen.at(-1), { done: seen.at(-1)!.total, total: seen.at(-1)!.total, files: 3, totalFiles: 3 });
  });
});
