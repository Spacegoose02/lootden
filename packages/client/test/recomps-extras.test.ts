import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { after, before, describe, it } from "node:test";
import { parseRecompManifest, type RecompInfo } from "@lootden/shared";
import { readTools, writeTools } from "../src/emulators.js";
import { findSevenZip, type SevenZip } from "../src/extractor.js";
import { applyLook, crtLines, ensureReShade, LOOKS_FX, zipInSetup } from "../src/looks.js";
import { gameBananaFiles, installGameBananaMod, parseGameBananaList, recompGameBanana, recompMods, wantedGameBananaFile } from "../src/recompmods.js";
import { crc32File, matchDump, planRecomp, recompDir, recompLook, setRecompLook } from "../src/recomps.js";

let work: string;
let sevenZip: SevenZip;

function zipDir(cwd: string, zip: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(sevenZip.path, ["a", "-tzip", "-bd", "-y", zip, "."], { cwd, stdio: "ignore" });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`7z ${code}`))));
  });
}

async function zipOf(name: string, files: Record<string, string | Buffer>): Promise<Buffer> {
  const d = path.join(work, "src", name);
  await mkdir(d, { recursive: true });
  for (const [f, body] of Object.entries(files)) await writeFile(path.join(d, f), body);
  const z = path.join(work, `${name}.zip`);
  await zipDir(d, z);
  return readFile(z);
}

const INFO: RecompInfo = { id: "testrecomp", name: "Test Recompiled", game: "Test", repo: "someone/TestRecomp", platform: "x360", titles: ["test"], programs: ["test"], custom: true };

/** A recomp "set up" in a tools folder: its program and recomplauncher.json, without downloading anything. */
async function fakeSetup(tools: string, manifest: unknown): Promise<string> {
  const dir = recompDir(tools, INFO.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "test"), "#!/bin/sh\nexit 0\n");
  await writeFile(path.join(dir, "recomplauncher.json"), JSON.stringify(manifest));
  const t = await readTools(tools);
  t.recomps[INFO.id] = { version: "v1", exe: path.relative(tools, path.join(dir, "test")), installedAt: new Date().toISOString(), sha256: null, info: INFO };
  await writeTools(tools, t);
  return dir;
}

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "gm-recomp4-"));
  sevenZip = (await findSevenZip(""))!;
});

after(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("recomp manifests: GameBanana, dumps and looks", () => {
  it("reads the new parts and refuses bad ones", () => {
    const m = parseRecompManifest({
      mods: { gamebanana: 123, loader: "nrm", data: "TestData" },
      game: { kind: "iso", dumps: [{ name: "Test (USA)", size: 100, crc32: "DEADBEEF" }, { name: "bad", size: 1, crc32: "xyz" }] },
      looks: { allowed: false, reason: "The game has its own filters" },
    });
    assert.deepEqual(m.mods, { gamebanana: 123, loader: "nrm", data: "TestData" });
    assert.deepEqual(m.game?.dumps, [{ name: "Test (USA)", size: 100, crc32: "deadbeef" }]);
    assert.deepEqual(m.looks, { allowed: false, reason: "The game has its own filters" });
    // "nrm" mods need the data folder name; a loader is required.
    assert.equal(parseRecompManifest({ mods: { gamebanana: 123, loader: "nrm" } }).mods, null);
    assert.equal(parseRecompManifest({ mods: { gamebanana: 123 } }).mods, null);
    assert.deepEqual(parseRecompManifest({ mods: { gamebanana: 5, loader: "otr" } }).mods, { gamebanana: 5, loader: "otr" });
  });
});

describe("GameBanana mods", { skip: process.platform === "win32" }, () => {
  it("lists, filters and installs mods, keeping only scanned archives and the files the game reads", async () => {
    const list = parseGameBananaList({
      _aRecords: [
        { _sModelName: "Mod", _idRow: 1, _sName: "HD Link", _aSubmitter: { _sName: "Ann" }, _nLikeCount: 40, _aRootCategory: { _sName: "Textures" }, _aPreviewMedia: { _aImages: [{ _sBaseUrl: "https://img", _sFile: "a.png", _sFile530: "a530.png" }] } },
        { _sModelName: "Mod", _idRow: 2, _sName: "Rated", _bHasContentRatings: true },
        { _sModelName: "Sound", _idRow: 3, _sName: "Not a mod" },
      ],
    });
    assert.deepEqual(list, [{ id: 1, name: "HD Link", owner: "Ann", likes: 40, image: "https://img/a530.png", category: "Textures", page: "https://gamebanana.com/mods/1" }]);
    const files = { _aFiles: [{ _idRow: 9, _sFile: "virus.zip", _sAvResult: "contains_virus" }, { _idRow: 10, _sFile: "x.rar", _sAvResult: "clean" }, { _idRow: 11, _sFile: "hd.zip", _sAvResult: "clean", _nFilesize: 5 }] };
    assert.deepEqual(gameBananaFiles(files, false).map((f) => f.id), [11]);
    assert.deepEqual(gameBananaFiles(files, true).map((f) => f.id), [10, 11]);
    assert.ok(wantedGameBananaFile("pack.o2r", "otr"));
    assert.ok(!wantedGameBananaFile("pack.nrm", "otr"));
    assert.ok(wantedGameBananaFile("pack.nrm", "nrm"));

    const tools = path.join(work, "tools-gb");
    await fakeSetup(tools, { start: { program: ["test"] }, mods: { gamebanana: 777, loader: "nrm", data: "TestData" } });
    const archive = await zipOf("gb", { "hd_link.nrm": "mod", "hd_link.rtz": "pixels", "readme.txt": "hi" });
    const seen: string[] = [];
    const gb = (async (url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("/Mod/Index?") && u.includes("[Generic_Game]=777")) return Response.json({ _aRecords: [{ _sModelName: "Mod", _idRow: 1, _sName: "HD Link" }] });
      if (u.includes("/Util/Search/Results?") && u.includes("_sSearchString=hd%20link")) return Response.json({ _aRecords: [] });
      if (u.endsWith("/Mod/1/ProfilePage")) return Response.json({ _sName: "HD Link", _aFiles: files._aFiles });
      if (u === "https://gamebanana.com/dl/11") return new Response(new Uint8Array(archive));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    assert.deepEqual((await recompGameBanana(INFO.id, "", { toolsDir: tools, fetchImpl: gb })).map((m) => m.name), ["HD Link"]);
    assert.deepEqual(await recompGameBanana(INFO.id, "hd link", { toolsDir: tools, fetchImpl: gb }), []);
    const view = await recompMods(INFO.id, { toolsDir: tools, fetchImpl: gb });
    assert.deepEqual([view?.community, view?.gamebanana], [null, 777]);

    const installed = await installGameBananaMod(INFO.id, 1, { toolsDir: tools, sevenZip: { ...sevenZip, supportsRar: false }, fetchImpl: gb, platform: "linux" });
    assert.deepEqual(installed.map((m) => [m.full, m.name, m.files.sort()]), [["gamebanana:1", "HD Link", ["hd_link.nrm", "hd_link.rtz"]]]);
    assert.deepEqual((await readdir(path.join(recompDir(tools, INFO.id), "mods"))).sort(), ["hd_link.nrm", "hd_link.rtz"]);
    assert.ok(!seen.includes("https://gamebanana.com/dl/9"), "a file that failed the virus scan is never downloaded");
  });
});

describe("verified dumps", { skip: process.platform === "win32" }, () => {
  it("compares the image's CRC32 once per file and says when it matches", async () => {
    const image = path.join(work, "game.iso");
    const bytes = Buffer.alloc(300_000, 7);
    await writeFile(image, bytes);
    const want = (crc32(bytes) >>> 0).toString(16).padStart(8, "0");
    assert.equal(await crc32File(image), want);

    const msgs: string[] = [];
    const hit = await matchDump(image, [{ name: "Test (USA)", size: bytes.length, crc32: want }], undefined, (m) => msgs.push(m));
    assert.equal(hit?.name, "Test (USA)");
    assert.equal(msgs.length, 1);
    // Remembered: not read again (a wrong cached CRC proves the file wasn't re-read).
    const again = await matchDump(image, [{ name: "Test (USA)", size: bytes.length, crc32: want }], { signature: hit!.signature, crc32: "00000000" }, (m) => msgs.push(m));
    assert.equal(again?.name, null);
    assert.equal(msgs.length, 1);
    // Wrong size: no need to read.
    assert.deepEqual((await matchDump(image, [{ name: "Other", size: 5, crc32: want }], undefined, (m) => msgs.push(m)))?.name, null);
    assert.equal(msgs.length, 1);

    // Through planRecomp: the plan says which disc it matched, and the answer is kept in the tools file.
    const tools = path.join(work, "tools-dump");
    await fakeSetup(tools, { start: { program: ["test"] }, game: { kind: "iso", dumps: [{ name: "Test (USA)", size: bytes.length, crc32: want }] } });
    const game = path.join(work, "lib-game");
    await mkdir(game, { recursive: true });
    await writeFile(path.join(game, "Test.iso"), bytes);
    const events: string[] = [];
    const plan = await planRecomp(game, INFO.id, { toolsDir: tools, sevenZip, platform: "linux", onEvent: (e) => events.push(e.message) });
    assert.equal(plan.verified, "Test (USA)");
    assert.ok(events.includes("Matches the verified Test (USA) disc"), events.join(" | "));
    assert.equal((await readTools(tools)).recomps[INFO.id]?.dumpCheck?.crc32, want);
    assert.equal(plan.look, "off");
  });
});

describe("looks", { skip: process.platform === "win32" }, () => {
  it("finds the library inside ReShade's setup and keeps it until a newer version", async () => {
    const dll = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100, 1)]);
    const zip = await zipOf("reshade", { "ReShade64.dll": dll, "ReShade32.dll": Buffer.from("MZ32") });
    // A program, padded to a 512-byte boundary, then the zip; a stray "PK" before it isn't taken for it.
    const head = Buffer.alloc(2048, 0);
    head.write("PK\x03\x04", 1024, "latin1");
    const setup = Buffer.concat([head, zip]);
    assert.deepEqual(Buffer.from(zipInSetup(setup)!), zip);
    assert.equal(zipInSetup(Buffer.from("nothing here")), null);

    const tools = path.join(work, "tools-look");
    let downloads = 0;
    let tag = "v6.3.3";
    const net = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.startsWith("https://api.github.com/repos/crosire/reshade/tags")) return Response.json([{ name: "nightly" }, { name: tag }]);
      if (u === `https://reshade.me/downloads/ReShade_Setup_${tag.slice(1)}.exe`) {
        downloads++;
        return new Response(new Uint8Array(setup));
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const got = await ensureReShade(tools, sevenZip, net);
    assert.deepEqual(await readFile(got), dll);
    await ensureReShade(tools, sevenZip, net);
    assert.equal(downloads, 1, "checked at most weekly");
    // Offline with a copy: keeps working.
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    assert.equal(await ensureReShade(tools, sevenZip, offline), got);
    await assert.rejects(ensureReShade(path.join(work, "tools-none"), sevenZip, offline), /latest version/);
  });

  it("puts ReShade beside the program for one session, and never over someone else's dxgi.dll", async () => {
    const exeDir = path.join(work, "look-game");
    await mkdir(exeDir, { recursive: true });
    const exe = path.join(exeDir, "game.exe");
    await writeFile(exe, "exe");
    const dll = path.join(work, "ReShade64.dll");
    await writeFile(dll, "MZreshade");

    assert.deepEqual((await applyLook({ exe, dataDir: exeDir, dll, look: "off", lines: 240 })).env, {});
    const s = await applyLook({ exe, dataDir: exeDir, dll, look: "crt", lines: crtLines("n64") });
    const base = path.join(exeDir, "reshade");
    assert.deepEqual(s.env, { RESHADE_BASE_PATH_OVERRIDE: base });
    assert.equal(await readFile(path.join(exeDir, "dxgi.dll"), "utf8"), "MZreshade");
    assert.equal(await readFile(path.join(base, "Shaders", "LootDenLooks.fx"), "utf8"), LOOKS_FX);
    const preset = await readFile(path.join(base, "LootDen.ini"), "utf8");
    assert.match(preset, /^Techniques=LootDenCRT@LootDenLooks\.fx\r\n/);
    assert.match(preset, /Lines=240\.000000/);
    assert.match(await readFile(path.join(base, "ReShade.ini"), "utf8"), new RegExp(`PresetPath=${path.join(base, "LootDen.ini").replace(/[.\\/]/g, "\\$&")}`));
    // Starting again while ours is there is fine; afterwards it's all taken away.
    const again = await applyLook({ exe, dataDir: exeDir, dll, look: "sharp", lines: 240 });
    await again.undo();
    await s.undo();
    assert.equal(await stat(path.join(exeDir, "dxgi.dll")).catch(() => null), null);
    assert.ok(!(await readdir(exeDir)).includes(".lootden-reshade"));

    await writeFile(path.join(exeDir, "dxgi.dll"), "someone else's");
    await assert.rejects(applyLook({ exe, dataDir: exeDir, dll, look: "vivid", lines: 240 }), /already a dxgi\.dll/);
    assert.equal(await readFile(path.join(exeDir, "dxgi.dll"), "utf8"), "someone else's");

    // Every look has a technique in the shader file.
    for (const t of ["LootDenSharp", "LootDenVivid", "LootDenFilm", "LootDenCRT"]) assert.ok(LOOKS_FX.includes(`technique ${t} `), t);
    assert.ok(!LOOKS_FX.includes("#include"), "the filters stand alone");
  });

  it("keeps the player's look per recomp, only on Windows, and respects a recomp that opts out", async () => {
    const tools = path.join(work, "tools-pick");
    await fakeSetup(tools, { start: { program: ["test"] } });
    await setRecompLook(INFO.id, "film", { toolsDir: tools });
    await assert.rejects(setRecompLook(INFO.id, "sepia", { toolsDir: tools }), /Unknown look/);
    assert.deepEqual(await recompLook(INFO.id, { toolsDir: tools, platform: "win32" }), { look: "film", available: true, reason: "" });
    assert.equal((await recompLook(INFO.id, { toolsDir: tools, platform: "linux" })).available, false);

    const game = path.join(work, "lib-game2");
    await mkdir(game, { recursive: true });
    await writeFile(path.join(game, "Test.iso"), "iso");
    assert.equal((await planRecomp(game, INFO.id, { toolsDir: tools, sevenZip, platform: "linux" })).look, "off");

    await writeFile(path.join(recompDir(tools, INFO.id), "recomplauncher.json"), JSON.stringify({ start: { program: ["test"] }, looks: { allowed: false, reason: "Has its own filters" } }));
    assert.deepEqual(await recompLook(INFO.id, { toolsDir: tools, platform: "win32" }), { look: "film", available: false, reason: "Has its own filters" });
  });
});
