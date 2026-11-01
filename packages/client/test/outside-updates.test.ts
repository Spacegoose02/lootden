import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { effectiveVersion } from "@lootden/shared";
import { exeVersion, parseVersionResource } from "../src/exeversion.js";
import { hoistSingleFolder, renameRetrying } from "../src/installer.js";
import { copyOver, updateProblem } from "../src/updates.js";
import { listInstalled } from "../src/installed.js";

let work: string;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "lootden-outside-"));
});
after(() => rm(work, { recursive: true, force: true }));

/** A version resource as Windows lays it out: header, "VS_VERSION_INFO", padding, VS_FIXEDFILEINFO. */
function versionResource(file: number[], product = file): Buffer {
  const head = Buffer.alloc(6);
  const key = Buffer.from("VS_VERSION_INFO\0", "utf16le");
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE(0x00010000, 4);
  fixed.writeUInt32LE(((file[0]! << 16) | file[1]!) >>> 0, 8);
  fixed.writeUInt32LE(((file[2]! << 16) | file[3]!) >>> 0, 12);
  fixed.writeUInt32LE(((product[0]! << 16) | product[1]!) >>> 0, 16);
  fixed.writeUInt32LE(((product[2]! << 16) | product[3]!) >>> 0, 20);
  return Buffer.concat([Buffer.alloc(16, 0xaa), head, key, Buffer.alloc(2), fixed]);
}

/** The smallest PE file with one .rsrc section holding the given bytes. */
function peWith(rsrc: Buffer): Buffer {
  const pe = Buffer.alloc(0x200);
  pe.write("MZ", 0, "latin1");
  pe.writeUInt32LE(0x40, 0x3c);
  pe.writeUInt32LE(0x00004550, 0x40);
  pe.writeUInt16LE(1, 0x40 + 6);
  pe.writeUInt16LE(0, 0x40 + 20);
  const section = 0x40 + 24;
  pe.write(".rsrc", section, "latin1");
  pe.writeUInt32LE(rsrc.length, section + 16);
  pe.writeUInt32LE(0x200, section + 20);
  return Buffer.concat([pe, rsrc]);
}

describe("versions read from a game's executable", () => {
  it("reads the file version, or the product version when the file version is blank", async () => {
    assert.equal(parseVersionResource(versionResource([1, 0, 141, 13368])), "1.0.141.13368");
    assert.equal(parseVersionResource(versionResource([0, 0, 0, 0], [2, 3, 0, 1])), "2.3.0.1");
    assert.equal(parseVersionResource(versionResource([0, 0, 0, 0])), null);
    assert.equal(parseVersionResource(Buffer.from("no version here")), null);

    const exe = path.join(work, "game.exe");
    await writeFile(exe, peWith(versionResource([1, 0, 141, 13368])));
    assert.equal(await exeVersion(exe), "1.0.141.13368");
    await writeFile(path.join(work, "notes.txt"), "just text");
    assert.equal(await exeVersion(path.join(work, "notes.txt")), null);
    assert.equal(await exeVersion(path.join(work, "missing.exe")), null);
  });

  it("counts an exe version only when it's newer and numbered the same way", () => {
    const update = { version: "1.0.141.13368", fromVersion: "1.0.141.3207" };
    assert.deepEqual(effectiveVersion({ version: "1.0.141.3207", exeVersion: "1.0.141.13368" }, update), { version: "1.0.141.13368", fromExe: true });
    assert.deepEqual(effectiveVersion({ version: null, exeVersion: "1.0.141.13368" }, update), { version: "1.0.141.13368", fromExe: true });
    // An older or unrelated stamp ("1.0.0.0" on a v2.3 game) is ignored.
    assert.deepEqual(effectiveVersion({ version: "1.0.141.13368", exeVersion: "1.0.141.3207" }, update), { version: "1.0.141.13368", fromExe: false });
    assert.deepEqual(effectiveVersion({ version: "2.3", exeVersion: "1.0.0.0" }), { version: "2.3", fromExe: false });
    assert.deepEqual(effectiveVersion({ version: null, exeVersion: "1.0.0.0" }), { version: null, fromExe: false });
  });

  it("ignores a generic exe stamp older than the version the update needs", () => {
    // CFB 27 on the ROG Ally: the exe says 1.0.0.0, LootDen applied 1.0.141.3207 but the
    // manifest's own version was lost, so the next update must not read 1.0.0.0 as "outside LootDen".
    const next = { id: "u2", title: "CFB 27 patch", kind: "update" as const, version: "1.0.141.13368", fromVersion: "1.0.141.3207" };
    assert.deepEqual(effectiveVersion({ version: null, exeVersion: "1.0.0.0" }, next), { version: null, fromExe: false });
    assert.equal(updateProblem(next, { version: null, exeVersion: "1.0.0.0" }), null);
    // The newest applied update's version stands in for a missing manifest version.
    const applied = [{ version: null }, { version: "1.0.141.3207" }];
    assert.deepEqual(effectiveVersion({ version: null, exeVersion: "1.0.0.0", updates: applied }, next), { version: "1.0.141.3207", fromExe: false });
    assert.equal(updateProblem(next, { version: null, exeVersion: "1.0.0.0", updates: applied as never }), null);
  });

  it("says an update is already on when the game was updated outside LootDen", () => {
    const update = { id: "u1", title: "CFB 27 patch", kind: "update" as const, version: "1.0.141.13368", fromVersion: "1.0.141.3207" };
    assert.equal(updateProblem(update, { version: "1.0.141.3207", exeVersion: "1.0.141.3207" }), null);
    assert.match(updateProblem(update, { version: "1.0.141.3207", exeVersion: "1.0.141.13368" }) ?? "", /updated outside LootDen/);
    assert.match(updateProblem(update, { version: null, exeVersion: "1.0.141.13368" }) ?? "", /updated outside LootDen/);
  });
});

describe("the version LootDen keeps for each game", () => {
  it("backfills a lost version and stamps the exe, so a generic exe version is never read as an outside update", async () => {
    const root = path.join(work, "games");
    const dir = path.join(root, "CFB 27");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "game.exe"), peWith(versionResource([1, 0, 0, 0])));
    const applied = { id: "u1", title: "CFB 27 1.0.141.3207", kind: "update", previousVersion: null, version: "1.0.141.3207", mode: "files", appliedAt: "2026-10-16T00:00:00Z", replaced: 1, added: 0 };
    await writeFile(path.join(dir, ".lootden.json"), JSON.stringify({ gameId: "g1", title: "CFB 27", platform: "pc", executable: "game.exe", version: null, updates: [applied] }));

    const [g] = await listInstalled([root]);
    assert.equal(g!.version, "1.0.141.3207");
    assert.equal(g!.versionSetBy?.how, "backfill");
    assert.equal(g!.exeVersion, null);
    const saved = JSON.parse(await readFile(path.join(dir, ".lootden.json"), "utf8"));
    assert.equal(saved.version, "1.0.141.3207");
    assert.ok(saved.exeStamp?.size > 0);
    assert.equal(updateProblem({ id: "u2", title: "next", kind: "update", version: "1.0.141.13368", fromVersion: "1.0.141.3207" }, g!), null);

    // The exe replaced from outside LootDen: now its version counts.
    await writeFile(path.join(dir, "game.exe"), Buffer.concat([peWith(versionResource([1, 0, 141, 13368])), Buffer.alloc(8)]));
    const [later] = await listInstalled([root]);
    assert.equal(later!.exeVersion, "1.0.141.13368");
    assert.match(updateProblem({ id: "u2", title: "next", kind: "update", version: "1.0.141.13368", fromVersion: "1.0.141.3207" }, later!) ?? "", /updated outside LootDen/);
  });
});

describe("copying update files over the game", () => {
  it("retries a copy Windows refuses, then explains what to do", async () => {
    const src = path.join(work, "new.png");
    const dest = path.join(work, "old.png");
    await writeFile(src, "new");
    await writeFile(dest, "old");
    let tries = 0;
    const { copyFile } = await import("node:fs/promises");
    await copyOver(src, dest, [1, 1, 1], async (a, b) => {
      if (++tries < 3) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      await copyFile(a, b);
    });
    assert.equal(tries, 3);
    assert.equal(await readFile(dest, "utf8"), "new");

    await assert.rejects(
      copyOver(src, dest, [1], async () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }),
      { code: "EPERM", message: /Close the game and its launcher/ },
    );
    // Other errors aren't retried.
    await assert.rejects(copyOver(path.join(work, "missing.png"), dest, [1]), { code: "ENOENT" });
  });
});

describe("lifting a wrapper folder after unpacking", () => {
  it("retries a rename while the folder is locked", async () => {
    let tries = 0;
    const dir = path.join(work, "retry");
    await mkdir(path.join(dir, "a"), { recursive: true });
    const original = (await import("node:fs/promises")).rename;
    // Locked twice, then free: the rename goes through.
    const flaky = async (from: string, to: string) => {
      if (++tries < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
      await original(from, to);
    };
    await renameRetrying(path.join(dir, "a"), path.join(dir, "b"), [1, 1, 1], flaky);
    assert.equal(tries, 3);
    assert.deepEqual(await readdir(dir), ["b"]);
    // Other errors aren't retried.
    await assert.rejects(renameRetrying(path.join(dir, "nope"), path.join(dir, "c"), [1]), { code: "ENOENT" });
  });

  it("leaves the files nested with a warning when Windows keeps the folder locked", async () => {
    const dir = path.join(work, "locked");
    await mkdir(path.join(dir, "Wrapper", "bin"), { recursive: true });
    await writeFile(path.join(dir, "Wrapper", "bin", "game.exe"), "exe");
    const warning = await hoistSingleFolder(dir, async () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    assert.match(warning ?? "", /Left the files inside "Wrapper".*EPERM/);
    assert.equal(await readFile(path.join(dir, "Wrapper", "bin", "game.exe"), "utf8"), "exe");

    // Unlocked, it lifts them as before.
    assert.equal(await hoistSingleFolder(dir), null);
    assert.deepEqual(await readdir(dir), ["bin"]);
  });
});
