import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { parseTruckManifest, truckGameFor, truckGameFromUrl, truckGameVersionFromLog, truckModFileName, truckModFit, truckModTitle } from "@lootden/shared";
import { findSevenZip, type SevenZip } from "../src/extractor.js";
import { installedTruckModKey, installTruckMod, linkTruckMod, listTruckMods, removeTruckMod, scanTruckMods, truckGameVersion, truckModsFolder } from "../src/truckmods.js";

let work: string;
let sevenZip: SevenZip;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "gm-truckmods-"));
  sevenZip = (await findSevenZip(""))!;
});
after(() => rm(work, { recursive: true, force: true }));

describe("truck game mods", () => {
  it("knows the games, their mod folders and their mod files", () => {
    assert.equal(truckModsFolder("ats", { platform: "win32", documents: "D:\\OneDrive\\Documents" }), "D:\\OneDrive\\Documents\\American Truck Simulator\\mod");
    assert.equal(truckModsFolder("ets2", { platform: "linux", home: "/home/deck" }), "/home/deck/.local/share/Euro Truck Simulator 2/mod");
    assert.equal(truckModsFolder("ats", { custom: "/games/ats-home/mod" }), path.resolve("/games/ats-home/mod"));

    assert.equal(truckGameFor("270880", null), "ats");
    assert.equal(truckGameFor(null, "Euro Truck Simulator 2 - Gold Edition"), "ets2");
    assert.equal(truckGameFor("620", "Portal 2"), null);
    assert.equal(truckGameFromUrl("https://truckymods.io/american-truck-simulator/trucks/some-truck"), "ats");
    assert.equal(truckGameFromUrl("https://truckymods.io/euro-truck-simulator-2/maps/promods"), "ets2");
    assert.equal(truckGameFromUrl("https://example.com/mods/ats/peterbilt"), "ats");
    assert.equal(truckGameFromUrl("https://truckymods.io/stats"), null);

    assert.equal(truckModFileName("C:\\Users\\me\\Downloads\\cool:truck.scs"), "cooltruck.scs");
    assert.throws(() => truckModFileName("setup.exe"), /\.scs/);
    assert.throws(() => truckModFileName("../.."));
    assert.equal(truckModTitle("kenworth_w900_v2.1.scs"), "kenworth w900 v2.1");
  });

  it("installs .scs files and archives of them, replaces updates and removes only its own", async () => {
    const mods = path.join(work, "ATS", "mod");
    await mkdir(mods, { recursive: true });
    await writeFile(path.join(mods, "mine.scs"), "a mod I added by hand");

    // A plain .scs.
    const scs = path.join(work, "dl", "w900.scs");
    await mkdir(path.dirname(scs), { recursive: true });
    await writeFile(scs, "w900 v1");
    const w900 = await installTruckMod(scs, mods, { serverId: null, title: "W900", fileName: "w900.scs", sourceUrl: "https://truckymods.io/american-truck-simulator/trucks/w900" }, sevenZip);
    assert.deepEqual(w900.files, ["w900.scs"]);
    assert.equal(await readFile(path.join(mods, "w900.scs"), "utf8"), "w900 v1");

    // A zip holding two .scs in folders (the TruckyMods upload rules), and a readme.
    const staging = path.join(work, "staging");
    await mkdir(path.join(staging, "pack", "extra"), { recursive: true });
    await writeFile(path.join(staging, "pack", "map.scs"), "map");
    await writeFile(path.join(staging, "pack", "extra", "map_patch.scs"), "patch");
    await writeFile(path.join(staging, "pack", "readme.txt"), "read me");
    const zip = path.join(work, "dl", "Big Map.zip");
    execFileSync(sevenZip.path, ["a", "-tzip", zip, path.join(staging, "pack", "*")], { stdio: "ignore" });
    const map = await installTruckMod(zip, mods, { serverId: 7, title: "Big Map", fileName: "Big Map.zip" }, sevenZip);
    assert.deepEqual([...map.files].sort(), ["map.scs", "map_patch.scs"]);
    assert.equal(existsSync(path.join(mods, "readme.txt")), false);

    // A zip that is a mod itself (manifest.sii at its root) goes in as it is.
    await mkdir(path.join(staging, "zipmod"), { recursive: true });
    await writeFile(path.join(staging, "zipmod", "manifest.sii"), "SiiNunit {}");
    const zipMod = path.join(work, "dl", "sounds.zip");
    execFileSync(sevenZip.path, ["a", "-tzip", zipMod, path.join(staging, "zipmod", "*")], { stdio: "ignore" });
    assert.deepEqual((await installTruckMod(zipMod, mods, { serverId: null, title: "Sounds", fileName: "sounds.zip" }, sevenZip)).files, ["sounds.zip"]);

    // An archive without a mod in it is refused.
    await mkdir(path.join(staging, "junk"), { recursive: true });
    await writeFile(path.join(staging, "junk", "notes.txt"), "no mod here");
    const junk = path.join(work, "dl", "junk.7z");
    execFileSync(sevenZip.path, ["a", "-t7z", junk, path.join(staging, "junk", "*")], { stdio: "ignore" });
    await assert.rejects(installTruckMod(junk, mods, { serverId: null, title: "Junk", fileName: "junk.7z" }, sevenZip), /no mod/);

    assert.deepEqual((await listTruckMods(mods)).map((m) => m.title).sort(), ["Big Map", "Sounds", "W900"]);

    // Kept on the server afterwards: linked, so it's the same mod everywhere.
    await linkTruckMod(mods, installedTruckModKey(w900), 12);
    assert.equal((await listTruckMods(mods)).find((m) => m.title === "W900")!.serverId, 12);

    // A newer version of the map with one file fewer: the old files go.
    await rm(path.join(staging, "pack", "extra"), { recursive: true });
    await writeFile(path.join(staging, "pack", "map.scs"), "map v2");
    await rm(zip);
    execFileSync(sevenZip.path, ["a", "-tzip", zip, path.join(staging, "pack", "*")], { stdio: "ignore" });
    await installTruckMod(zip, mods, { serverId: 7, title: "Big Map", fileName: "Big Map.zip" }, sevenZip);
    assert.equal(await readFile(path.join(mods, "map.scs"), "utf8"), "map v2");
    assert.equal(existsSync(path.join(mods, "map_patch.scs")), false);
    assert.equal((await listTruckMods(mods)).filter((m) => m.serverId === 7).length, 1);

    await assert.rejects(removeTruckMod(mods, "file:mine.scs"), /didn't install/);
    await removeTruckMod(mods, "server:7");
    await removeTruckMod(mods, "server:12");
    assert.deepEqual((await readdir(mods)).filter((f) => !f.startsWith(".")).sort(), ["mine.scs", "sounds.zip"]);
  });

  it("tells which mods are made for an older (or newer) game", async () => {
    const manifest = parseTruckManifest(`SiiNunit
{
mod_package : .package_name
{
    package_version: "2.4"
    display_name: "Kenworth W900"
    author: "Trucker"
    compatible_versions[]: "1.52.*"
    compatible_versions[]: "1.53.*"
}
}`);
    assert.deepEqual(manifest, { name: "Kenworth W900", version: "2.4", author: "Trucker", compatibleVersions: ["1.52.*", "1.53.*"] });
    assert.equal(truckModFit(manifest.compatibleVersions, "1.53.3.14s"), "ok");
    assert.equal(truckModFit(["1.49.*", "1.50.*"], "1.53.3.14s"), "outdated");
    assert.equal(truckModFit(["1.54.*"], "1.53.3.14s"), "newer");
    assert.equal(truckModFit([], "1.53.3.14s"), "unknown");
    assert.equal(truckModFit(["1.53.*"], null), "unknown");
    assert.equal(truckGameVersionFromLog("00:00:00.000 : log created\n00:00:00.003 : American Truck Simulator init ver.1.53.3.14s (rev. 2d1a6e23b13e)"), "1.53.3.14s");

    // A mod folder with one current mod, one outdated one, one whose manifest can't be read, and the game's log beside it.
    const home = path.join(work, "ATS2");
    const mods = path.join(home, "mod");
    await mkdir(mods, { recursive: true });
    await writeFile(path.join(home, "game.log.txt"), "00:00:00.003 : American Truck Simulator init ver.1.53.3.14s (rev. 2d1a6e23b13e)\n");
    const pack = async (name: string, versions: string[]) => {
      const dir = path.join(work, "packs", name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "manifest.sii"), `SiiNunit\n{\nmod_package : .p\n{\n${versions.map((v) => `compatible_versions[]: "${v}"`).join("\n")}\n}\n}`);
      execFileSync(sevenZip.path, ["a", "-tzip", path.join(mods, name), path.join(dir, "*")], { stdio: "ignore" });
    };
    await pack("fresh.scs", ["1.53.*"]);
    await pack("old.scs", ["1.48.*"]);
    await writeFile(path.join(mods, "hashfs.scs"), "SCS#not a zip");
    await writeFile(path.join(mods, "notes.txt"), "not a mod");

    const version = await truckGameVersion(mods);
    assert.equal(version, "1.53.3.14s");
    const found = await scanTruckMods(mods, sevenZip, version);
    assert.deepEqual(found.map((f) => [f.file, f.fit]), [["fresh.scs", "ok"], ["hashfs.scs", "unknown"], ["old.scs", "outdated"]]);
    assert.equal(found[1]!.manifest, null);
    // The second look comes from what was remembered (no 7-Zip needed).
    assert.deepEqual((await scanTruckMods(mods, null, version)).map((f) => f.fit), ["ok", "unknown", "outdated"]);
  });
});
