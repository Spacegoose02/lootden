import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { compareStardewMods, parseSmapiManifest, type StardewMod } from "@lootden/shared";
import { findStardewDir, scanStardewMods, syncStardewMods, type StardewSyncDeps } from "../src/stardewmods.js";

const manifest = (id: string, name: string, version: string) => JSON.stringify({ Name: name, Version: version, UniqueID: id });

/** A shared mod whose "zip" is a JSON list of files, unpacked by the fake extract below. */
function shared(id: number, title: string, folder: string, version: string, opts: { enabled?: boolean; uniqueId?: string; updatedAt?: string; extra?: Record<string, string> } = {}): StardewMod & { files: Record<string, string> } {
  const uid = opts.uniqueId ?? `Test.${folder.replace(/\W/g, "")}`;
  return {
    id, title, fileName: `${folder}.zip`, sizeBytes: 1, folder, enabled: opts.enabled ?? true, sourceUrl: null, addedBy: null, addedAt: "", updatedAt: opts.updatedAt ?? `v${version}`, canManage: true,
    mods: [parseSmapiManifest(manifest(uid, title, version), folder)!],
    files: { [`${folder}/manifest.json`]: manifest(uid, title, version), [`${folder}/${folder}.dll`]: `dll ${version}`, ...(opts.extra ?? {}) },
  };
}

const deps = (strict = true): StardewSyncDeps & { downloads: number[] } => {
  const downloads: number[] = [];
  return {
    strict,
    downloads,
    download: async (mod, dest) => {
      downloads.push(mod.id);
      await writeFile(dest, JSON.stringify((mod as StardewMod & { files: Record<string, string> }).files));
    },
    extract: async (zip, out) => {
      for (const [name, text] of Object.entries(JSON.parse(await readFile(zip, "utf8")) as Record<string, string>)) {
        await mkdir(path.dirname(path.join(out, name)), { recursive: true });
        await writeFile(path.join(out, name), text);
      }
    },
  };
};

let dir: string;
let mods: string;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "gm-sdv-client-"));
  mods = path.join(dir, "Stardew Valley", "Mods");
  await mkdir(mods, { recursive: true });
  await writeFile(path.join(dir, "Stardew Valley", "Stardew Valley.dll"), "game");
});
after(() => rm(dir, { recursive: true, force: true }));

const put = async (rel: string, text: string) => {
  await mkdir(path.dirname(path.join(mods, rel)), { recursive: true });
  await writeFile(path.join(mods, rel), text);
};

describe("stardew mods on a PC", () => {
  it("finds the game's folder under where it was installed", async () => {
    assert.equal(await findStardewDir(dir), path.join(dir, "Stardew Valley"));
    assert.equal(await findStardewDir(path.join(dir, "Stardew Valley", "Mods")), null);
  });

  it("makes the Mods folder match the set, switching off rather than deleting", async () => {
    // SMAPI's own mods, a hand-installed copy of a shared mod, and a mod only this PC has.
    await put("ConsoleCommands/manifest.json", manifest("SMAPI.ConsoleCommands", "Console Commands", "4.1.0"));
    await put("CP by hand/manifest.json", manifest("Test.ContentPatcher", "Content Patcher", "1.0.0"));
    await put("Cheats/Inner/manifest.json", manifest("Some.Cheats", "Cheats", "1.0.0"));

    const cp = shared(1, "Content Patcher", "ContentPatcher", "2.0.0");
    const flowers = shared(2, "Flowers", "Flowers", "1.0.0", { enabled: false });
    const d = deps();
    const first = await syncStardewMods(mods, [cp, flowers], d);
    assert.deepEqual(first.added, ["Content Patcher"]);
    assert.deepEqual(first.extrasOff, ["Cheats"]);
    assert.equal(first.switchedOff.length, 1, "the hand-installed copy is switched off");
    assert.deepEqual(first.failed, []);
    assert.deepEqual(d.downloads, [1], "a mod that's off isn't downloaded");
    const names = (await readdir(mods)).sort();
    assert.deepEqual(names.filter((n) => !n.startsWith(".lootden")), [".CP by hand", ".Cheats", "ConsoleCommands", "ContentPatcher"]);

    let local = await scanStardewMods(mods);
    assert.deepEqual(compareStardewMods([cp, flowers], local).map((x) => x.state), ["match"]);
    assert.equal(local.find((m) => m.uniqueId === "Test.ContentPatcher" && m.enabled)?.sharedId, 1);
    assert.equal(local.find((m) => m.uniqueId === "Some.Cheats")?.enabled, false);

    // Nothing changed: nothing downloaded.
    const again = await syncStardewMods(mods, [cp, flowers], d);
    assert.deepEqual([again.added, again.updated, again.switchedOn, again.switchedOff, again.extrasOff], [[], [], [], [], []]);
    assert.deepEqual(d.downloads, [1]);

    // An update keeps the player's config.json; switching a mod on installs it.
    await writeFile(path.join(mods, "ContentPatcher", "config.json"), '{"mine":true}');
    const cp2 = shared(1, "Content Patcher", "ContentPatcher", "2.1.0");
    const flowersOn = { ...flowers, enabled: true };
    const third = await syncStardewMods(mods, [cp2, flowersOn], d);
    assert.deepEqual(third.updated, ["Content Patcher"]);
    assert.deepEqual(third.added, ["Flowers"]);
    assert.equal(await readFile(path.join(mods, "ContentPatcher", "config.json"), "utf8"), '{"mine":true}');
    assert.equal(await readFile(path.join(mods, "ContentPatcher", "ContentPatcher.dll"), "utf8"), "dll 2.1.0");

    // Switched off in the set: renamed, not downloaded again when it comes back on.
    const off = await syncStardewMods(mods, [cp2, flowers], d);
    assert.deepEqual(off.switchedOff, ["Flowers"]);
    assert.ok(existsSync(path.join(mods, ".Flowers")));
    const on = await syncStardewMods(mods, [cp2, flowersOn], d);
    assert.deepEqual(on.switchedOn, ["Flowers"]);
    assert.deepEqual(d.downloads, [1, 1, 2]);

    // Deleted from the set: switched off here.
    const gone = await syncStardewMods(mods, [cp2], d);
    assert.deepEqual(gone.switchedOff, ["Flowers"]);
    local = await scanStardewMods(mods);
    assert.deepEqual(compareStardewMods([cp2], local).map((x) => `${x.name}:${x.state}`), ["Content Patcher:match"]);
  });

  it("leaves other mods on without strict, and keeps the old version when a download fails", async () => {
    const own = path.join(dir, "loose");
    mods = path.join(own, "Mods");
    await put("Mine/manifest.json", manifest("My.Mod", "Mine", "1.0.0"));
    const cp = shared(1, "Content Patcher", "ContentPatcher", "2.0.0");
    await syncStardewMods(mods, [cp], deps(false));
    assert.ok(existsSync(path.join(mods, "Mine")));
    const broken = deps(false);
    broken.download = async () => {
      throw new Error("server is down");
    };
    const r = await syncStardewMods(mods, [shared(1, "Content Patcher", "ContentPatcher", "2.1.0")], broken);
    assert.deepEqual(r.failed, [{ name: "Content Patcher", error: "server is down" }]);
    assert.equal(await readFile(path.join(mods, "ContentPatcher", "ContentPatcher.dll"), "utf8"), "dll 2.0.0");
  });
});
