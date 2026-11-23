import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";
import { after, before, describe, it } from "node:test";
import { compareModVersions, compareStardewMods, parseSmapiManifest, stardewProblems, type StardewMod } from "@lootden/shared";
import { readStardewZip, safeFolderName } from "../src/stardewmods/store.js";
import { makeApp, makeLibrary } from "./helpers.js";

/** A small zip, deflated, the way Nexus mods come. */
export function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const manifest = (id: string, name: string, version: string, extra: object = {}) => JSON.stringify({ Name: name, Author: "Someone", Version: version, UniqueID: id, ...extra });

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

describe("stardew mod manifests", () => {
  it("reads manifests the way SMAPI does: comments, trailing commas, any case, content packs", () => {
    const m = parseSmapiManifest(
      `﻿{
        // A comment
        "name": "Stardew Valley Expanded",
        "Author": "FlashShifter",
        "Version": "1.15.3", /* block */
        "UniqueId": "FlashShifter.SVECode",
        "Dependencies": [
          { "UniqueID": "Pathoschild.ContentPatcher", "MinimumVersion": "2.0.0" },
          { "UniqueID": "Some.Optional", "IsRequired": false },
        ],
        "UpdateKeys": ["Nexus:3753"],
      }`,
      "Stardew Valley Expanded/SVE Code",
    );
    assert.equal(m?.uniqueId, "FlashShifter.SVECode");
    assert.equal(m?.name, "Stardew Valley Expanded");
    assert.equal(m?.version, "1.15.3");
    assert.deepEqual(m?.dependencies, [
      { uniqueId: "Pathoschild.ContentPatcher", minimumVersion: "2.0.0", required: true },
      { uniqueId: "Some.Optional", minimumVersion: null, required: false },
    ]);
    assert.deepEqual(m?.updateKeys, ["Nexus:3753"]);
    assert.equal(m?.folder, "Stardew Valley Expanded/SVE Code");
    const old = parseSmapiManifest(JSON.stringify({ UniqueID: "a.b", Version: { MajorVersion: 1, MinorVersion: 2, PatchVersion: 0 }, ContentPackFor: { UniqueID: "Pathoschild.ContentPatcher" } }));
    assert.equal(old?.version, "1.2.0");
    assert.deepEqual(old?.contentPackFor, { uniqueId: "Pathoschild.ContentPatcher", minimumVersion: null, required: true });
    assert.equal(parseSmapiManifest("{ \"Name\": \"no id\" }"), null);
    assert.equal(parseSmapiManifest("not json"), null);
  });

  it("compares versions like SMAPI", () => {
    assert.equal(compareModVersions("1.10.0", "1.9.9"), 1);
    assert.equal(compareModVersions("1.2", "1.2.0"), 0);
    assert.equal(compareModVersions("1.2.0-beta", "1.2.0"), -1);
    assert.equal(compareModVersions("v2.0.0", "1.99"), 1);
  });

  it("finds what switched-on mods need, and how a PC differs from the set", () => {
    const pkg = (id: number, enabled: boolean, mods: Array<[string, string, string, object?]>): StardewMod => ({
      id, title: mods[0]![1], fileName: "x.zip", sizeBytes: 1, folder: mods[0]![1], enabled, sourceUrl: null, addedBy: null, addedAt: "", updatedAt: "", canManage: true,
      mods: mods.map(([uid, name, version, extra]) => parseSmapiManifest(manifest(uid, name, version, extra))!),
    });
    const set = [
      pkg(1, true, [["Pathoschild.ContentPatcher", "Content Patcher", "1.9.0"]]),
      pkg(2, true, [["A.Pack", "[CP] A", "1.0.0", { ContentPackFor: { UniqueID: "Pathoschild.ContentPatcher", MinimumVersion: "2.0.0" } }]]),
      pkg(3, true, [["B.Mod", "B", "1.0.0", { Dependencies: [{ UniqueID: "C.Lib" }, { UniqueID: "D.Lib" }, { UniqueID: "SMAPI.ConsoleCommands" }] }]]),
      pkg(4, false, [["C.Lib", "C Lib", "3.0.0"]]),
    ];
    const problems = stardewProblems(set).map((p) => `${p.modName}:${p.needs}:${p.kind}`);
    assert.deepEqual(problems, ["[CP] A:Pathoschild.ContentPatcher:too-old", "B:C.Lib:off", "B:D.Lib:missing"]);

    const diff = compareStardewMods(set, [
      { uniqueId: "pathoschild.contentpatcher", name: "Content Patcher", version: "1.9.0", enabled: true },
      { uniqueId: "A.Pack", name: "[CP] A", version: "0.9.0", enabled: true },
      { uniqueId: "B.Mod", name: "B", version: "1.0.0", enabled: false },
      { uniqueId: "Extra.Mod", name: "Extra", version: "1.0.0", enabled: true },
      { uniqueId: "SMAPI.SaveBackup", name: "Save Backup", version: "4.0.0", enabled: true },
    ]);
    assert.deepEqual(diff.map((d) => `${d.name}:${d.state}`), ["[CP] A:outdated", "B:missing", "Content Patcher:match", "Extra:extra"]);
  });
});

describe("stardew mod zips", () => {
  it("finds the mods in a zip and the folder it goes into", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gm-sdv-"));
    try {
      const one = path.join(dir, "one.zip");
      await writeFile(one, makeZip({ "Lookup Anything/manifest.json": manifest("Pathoschild.LookupAnything", "Lookup Anything", "1.40.0"), "Lookup Anything/LookupAnything.dll": "dll", "Lookup Anything/i18n/de.json": "{}" }));
      const a = await readStardewZip(one, "Lookup Anything 1.40.0-541-1-40-0-1700000000.zip");
      assert.equal(a.folder, "Lookup Anything");
      assert.deepEqual(a.mods.map((m) => m.uniqueId), ["Pathoschild.LookupAnything"]);

      // A mod with its content pack in one zip; a manifest deeper inside a mod isn't a mod.
      const two = path.join(dir, "two.zip");
      await writeFile(two, makeZip({
        "Pack/Mod/manifest.json": manifest("X.Mod", "X", "1.0.0"),
        "Pack/[CP] X/manifest.json": manifest("X.CP", "[CP] X", "1.0.0", { ContentPackFor: { UniqueID: "Pathoschild.ContentPatcher" } }),
        "Pack/Mod/assets/manifest.json": manifest("Not.A.Mod", "Nope", "1.0.0"),
        "__MACOSX/Pack/._manifest.json": "junk",
      }));
      const b = await readStardewZip(two, "pack.zip");
      assert.equal(b.folder, "Pack");
      assert.deepEqual(b.mods.map((m) => m.uniqueId).sort(), ["X.CP", "X.Mod"]);

      // Loose files: a folder named after the zip.
      const three = path.join(dir, "three.zip");
      await writeFile(three, makeZip({ "manifest.json": manifest("Loose.Mod", "Loose", "1.0.0") }));
      assert.equal((await readStardewZip(three, "Loose Mod-123-1-0-0.zip")).folder, "Loose Mod");

      const none = path.join(dir, "none.zip");
      await writeFile(none, makeZip({ "readme.txt": "hi" }));
      await assert.rejects(readStardewZip(none, "none.zip"), /no SMAPI mod/);
      assert.equal(safeFolderName("..\\.hidden: mod?"), "hidden mod");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("stardew mod set", () => {
  it("keeps one set for every PC: admins switch mods on and off, updates replace, PCs report", async () => {
    const { app, ctx } = await makeApp(root);
    const token = async (name: string, role: "admin" | "user" = "user", kid = false) => {
      const u = await ctx.users.create({ username: name, password: "password1", role });
      if (kid) ctx.db.prepare("UPDATE users SET kid_mode = 1 WHERE id = ?").run(u.id);
      return { authorization: `Bearer ${ctx.auth.createApiToken(u.id, "t").token}` };
    };
    const admin = await token("boss", "admin");
    const wife = await token("wife");
    const kid = await token("kiddo", "user", true);
    const upload = (headers: object, qs: string, body: Buffer) =>
      app.inject({ method: "POST", url: `/api/stardew-mods?${qs}`, headers: { ...headers, "content-type": "application/octet-stream" }, payload: body });
    const cp = (v: string) => makeZip({ "ContentPatcher/manifest.json": manifest("Pathoschild.ContentPatcher", "Content Patcher", v), "ContentPatcher/ContentPatcher.dll": `dll ${v}` });

    const first = await upload(admin, "name=ContentPatcher-1915-2-0-0.zip&source=https%3A%2F%2Fwww.nexusmods.com%2Fstardewvalley%2Fmods%2F1915", cp("2.0.0"));
    assert.equal(first.statusCode, 200, first.body);
    const mod = first.json();
    assert.equal(mod.title, "Content Patcher");
    assert.equal(mod.folder, "ContentPatcher");
    assert.equal(mod.enabled, true, "an admin's mod is on at once");
    assert.equal(mod.sourceUrl, "https://www.nexusmods.com/stardewvalley/mods/1915");

    // Someone else's mod waits for an admin, and needs something the set doesn't have on.
    const pack = (await upload(wife, "name=Flowers.zip", makeZip({ "[CP] Flowers/manifest.json": manifest("Wife.Flowers", "[CP] Flowers", "1.0.0", { ContentPackFor: { UniqueID: "Pathoschild.ContentPatcher", MinimumVersion: "2.1.0" } }) }))).json();
    assert.equal(pack.enabled, false);
    assert.equal(pack.folder, "[CP] Flowers");
    assert.equal((await app.inject({ method: "PATCH", url: `/api/stardew-mods/${pack.id}`, headers: wife, payload: { enabled: true } })).statusCode, 403);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/stardew-mods/${pack.id}`, headers: admin, payload: { enabled: true } })).json().enabled, true);
    let set = (await app.inject({ url: "/api/stardew-mods", headers: wife })).json();
    assert.equal(set.mods.length, 2);
    assert.deepEqual(set.problems.map((p: { kind: string; needs: string }) => `${p.needs}:${p.kind}`), ["Pathoschild.ContentPatcher:too-old"]);

    // A newer zip of a mod in the set replaces it, keeping it on.
    const updated = (await upload(wife, "name=ContentPatcher-1915-2-1-0.zip", cp("2.1.0"))).json();
    assert.equal(updated.id, mod.id);
    assert.equal(updated.enabled, true);
    assert.equal(updated.mods[0].version, "2.1.0");
    assert.equal((await app.inject({ url: `/api/stardew-mods/${mod.id}/file`, headers: wife })).rawPayload.equals(cp("2.1.0")), true);
    set = (await app.inject({ url: "/api/stardew-mods", headers: wife })).json();
    assert.deepEqual(set.problems, []);

    // PCs report their Mods folder; the page shows where they differ.
    const report = (headers: Record<string, string>, device: string, mods: object[]) => app.inject({ method: "PUT", url: "/api/stardew-mods/report", headers, payload: { device, mods } });
    assert.equal((await report(admin, "DESKTOP-HIS", [{ uniqueId: "Pathoschild.ContentPatcher", name: "Content Patcher", version: "2.1.0" }, { uniqueId: "Wife.Flowers", name: "[CP] Flowers", version: "1.0.0" }])).statusCode, 200);
    assert.equal((await report(wife, "DESKTOP-HERS", [{ uniqueId: "Pathoschild.ContentPatcher", name: "Content Patcher", version: "2.0.0" }])).statusCode, 200);
    set = (await app.inject({ url: "/api/stardew-mods", headers: admin })).json();
    const pcs = Object.fromEntries(set.pcs.map((p: { device: string; differences: Array<{ state: string }> }) => [p.device, p.differences.map((d) => d.state).sort()]));
    assert.deepEqual(pcs, { "DESKTOP-HIS": [], "DESKTOP-HERS": ["missing", "outdated"] });
    assert.equal(set.pcs.find((p: { device: string }) => p.device === "DESKTOP-HERS").user, "wife");

    // Not zips, zips without a mod, and kid profiles are turned away.
    assert.equal((await upload(wife, "name=mod.7z", Buffer.from("7z"))).statusCode, 400);
    assert.equal((await upload(wife, "name=readme.zip", makeZip({ "readme.txt": "x" }))).statusCode, 400);
    assert.equal((await upload(kid, "name=x.zip", cp("1.0.0"))).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/stardew-mods", headers: kid })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/stardew-mods" })).statusCode, 401);

    // Only who added a mod, or an admin, deletes it.
    assert.equal((await app.inject({ method: "DELETE", url: `/api/stardew-mods/${mod.id}`, headers: wife })).statusCode, 404);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/stardew-mods/${pack.id}`, headers: wife, payload: { title: "Pretty flowers" } })).json().title, "Pretty flowers");
    assert.equal((await app.inject({ method: "DELETE", url: `/api/stardew-mods/${pack.id}`, headers: wife })).statusCode, 200);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/stardew-mods/${mod.id}`, headers: admin })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/stardew-mods", headers: admin })).json().mods.length, 0);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/stardew-mods/pcs/DESKTOP-HERS", headers: wife })).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/stardew-mods/pcs/DESKTOP-HERS", headers: admin })).statusCode, 200);
    await app.close();
  });
});
