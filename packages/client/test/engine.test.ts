import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { listDrives } from "../src/drives.js";
import { listInstalled, uninstallGame } from "../src/installed.js";
import { MANIFEST_NAME } from "../src/installer.js";
import { findExecutable, launchAndTrack, saveExecutable } from "../src/launcher.js";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gm-engine-"));
});
after(() => rm(root, { recursive: true, force: true }));

async function fakeInstall(name: string, files: Record<string, string>) {
  const dir = path.join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  await writeFile(path.join(dir, MANIFEST_NAME), JSON.stringify({ gameId: name.toLowerCase().replace(/\W/g, ""), title: name, installedAt: "2026-10-13" }));
  return dir;
}

describe("finding the game executable", () => {
  it("skips installers and redistributables and prefers the title's name", async () => {
    const dir = await fakeInstall("Hollow Knight", {
      "unins000.exe": "x".repeat(5000),
      "_CommonRedist/vcredist_x64.exe": "x".repeat(90000),
      "UnityCrashHandler64.exe": "x".repeat(4000),
      "hollow_knight.exe": "x".repeat(600),
      "tools/editor.exe": "x".repeat(80000),
    });
    assert.equal(await findExecutable(dir, "Hollow Knight", "win32"), "hollow_knight.exe");
  });

  it("prefers native Linux launchers on Linux", async () => {
    const dir = await fakeInstall("Celeste", { "Celeste.exe": "x".repeat(900), "Celeste.bin.x86_64": "elf", "start.sh": "#!/bin/sh" });
    assert.equal(await findExecutable(dir, "Celeste", "linux"), "Celeste.bin.x86_64");
  });

  it("remembers the choice in the manifest", async () => {
    const dir = await fakeInstall("Hades", { "x64/Hades.exe": "x" });
    await saveExecutable(dir, "x64/Hades.exe");
    const [g] = (await listInstalled([root])).filter((x) => x.title === "Hades");
    assert.equal(g?.executable, "x64/Hades.exe");
  });

  it("times how long the game ran", { skip: process.platform === "win32" }, async () => {
    const dir = await fakeInstall("Sleepy", { "run.sh": "sleep 1.2\n" });
    await chmod(path.join(dir, "run.sh"), 0o755);
    const seconds = await launchAndTrack(dir, "run.sh", "linux");
    assert.ok(seconds >= 1 && seconds <= 3, `ran ${seconds}s`);
  });

  it("keeps timing a game a launcher started and then left running", { skip: process.platform !== "linux" }, async () => {
    const dir = await fakeInstall("Launched", { "launcher.sh": 'sh "$(dirname "$0")/game.sh" &\n', "game.sh": "sleep 2\n" });
    const seconds = await launchAndTrack(dir, "launcher.sh", "linux", undefined, { pollMs: 200 });
    assert.ok(seconds >= 2 && seconds <= 4, `ran ${seconds}s`);
  });

  it("closes what the launcher started when play time is up", { skip: process.platform !== "linux" }, async () => {
    const dir = await fakeInstall("Stopped", { "launcher.sh": 'sh "$(dirname "$0")/game.sh" &\n', "game.sh": "sleep 30\n" });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 600);
    const seconds = await launchAndTrack(dir, "launcher.sh", "linux", stop.signal, { pollMs: 200 });
    assert.ok(seconds < 5, `ran ${seconds}s`);
  });
});

describe("installed games", () => {
  it("lists installs by manifest and only deletes folders it installed", async () => {
    const dir = await fakeInstall("Stardew Valley", { "Stardew Valley.exe": "x" });
    await mkdir(path.join(root, "Not Ours"), { recursive: true });
    const titles = (await listInstalled([root, path.join(root, "missing")])).map((g) => g.title);
    assert.ok(titles.includes("Stardew Valley"));
    assert.ok(!titles.includes("Not Ours"));
    await assert.rejects(uninstallGame(path.join(root, "Not Ours")), /not a LootDen install/);
    assert.ok((await stat(path.join(root, "Not Ours"))).isDirectory());
    const removed = await uninstallGame(dir);
    assert.equal(removed.title, "Stardew Valley");
    await assert.rejects(readFile(path.join(dir, MANIFEST_NAME)));
  });
});

describe("drives", () => {
  it("reports at least the root drive with free space", async () => {
    const drives = await listDrives();
    assert.ok(drives.length >= 1);
    assert.ok(drives.every((d) => d.totalBytes > 0 && d.freeBytes >= 0));
  });
});
