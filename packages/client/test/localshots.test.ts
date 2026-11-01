import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { findLocalScreenshots } from "../src/localshots.js";

describe("screenshots already on the PC", () => {
  it("finds Steam's and Game Bar's for one game, newest first", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lootden-shots-"));
    try {
      const steam = path.join(root, "Steam");
      const dir = path.join(steam, "userdata", "1234", "760", "remote", "620", "screenshots");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "20260101_1.jpg"), "a");
      await writeFile(path.join(dir, "thumbs.db"), "x");
      await utimes(path.join(dir, "20260101_1.jpg"), new Date("2026-01-01"), new Date("2026-01-01"));
      const captures = path.join(root, "Captures");
      await mkdir(captures);
      await writeFile(path.join(captures, "Portal 2 2026-02-01 10-00-00.png"), "b");
      await writeFile(path.join(captures, "Hades 2026-02-01 10-00-00.png"), "c");
      const found = await findLocalScreenshots({ steamAppId: "620", title: "Portal 2", steamRoots: [steam], capturesDir: captures, platform: "linux" });
      assert.deepEqual(
        found.map((f) => [f.from, path.basename(f.path)]),
        [
          ["captures", "Portal 2 2026-02-01 10-00-00.png"],
          ["steam", "20260101_1.jpg"],
        ],
      );
      assert.deepEqual(await findLocalScreenshots({ steamAppId: "../x", title: "", steamRoots: [steam], capturesDir: captures }), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
