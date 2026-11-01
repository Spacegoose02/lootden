import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { spawn } from "node:child_process";
import type { FastifyInstance } from "fastify";
import {
  n64Header,
  parseRecompManifest,
  pickRecompAsset,
  recompRomProblem,
  recompInfo,
  recompsFor,
  sha256FromDigest,
  toZ64,
  type GameSummary,
} from "@lootden/shared";
import { buildApp, loadConfig, openDatabase } from "@lootden/server/lib";
import { GameServerClient } from "../src/api.js";
import { readTools } from "../src/emulators.js";
import { findSevenZip, type SevenZip } from "../src/extractor.js";
import { installGame } from "../src/installer.js";
import { installRecomp, planRecomp, playRecomp, recompDir, removeRecomp, restoreRecompSaves } from "../src/recomps.js";

/** A tiny N64 ROM: big-endian header with the game's name, country and revision. */
function rom(name: string, country = "E", size = 0x1000): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x80, 0x37, 0x12, 0x40]);
  for (let i = 0; i < 20; i++) b[0x20 + i] = (name.padEnd(20, " ").charCodeAt(i) ?? 32) & 0xff;
  b[0x3e] = country.charCodeAt(0);
  for (let i = 0x40; i < size; i++) b[i] = (i * 7) & 0xff;
  return b;
}
/** The same ROM in byte-swapped (.v64) order. */
function v64(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i += 2) [out[i], out[i + 1]] = [b[i + 1]!, b[i]!];
  return out;
}

describe("recomps: matching, files and ROMs", () => {
  it("matches library games to their recomp", () => {
    assert.deepEqual(recompsFor({ platform: "n64", title: "The Legend of Zelda: Majora's Mask" }).map((r) => r.id), ["zelda64recomp"]);
    assert.deepEqual(recompsFor({ platform: "n64", title: "Legend of Zelda, The - Majora's Mask" }).map((r) => r.id), ["zelda64recomp"]);
    assert.deepEqual(recompsFor({ platform: "n64", title: "Star Fox 64" }).map((r) => r.id), ["starfox64recomp"]);
    assert.deepEqual(recompsFor({ platform: "n64", title: "Super Mario 64" }), []);
    // A PC game of the same name isn't the console game.
    assert.deepEqual(recompsFor({ platform: "pc", title: "Majora's Mask" }), []);
  });

  it("picks the release file for the PC from its name", () => {
    const zelda = ["Zelda64Recompiled-v1.2.2-Linux-ARM64.zip", "Zelda64Recompiled-v1.2.2-Linux-Flatpak-X64.zip", "Zelda64Recompiled-v1.2.2-Linux-X64.zip", "Zelda64Recompiled-v1.2.2-Windows.zip", "Zelda64Recompiled-v1.2.2-macOS.zip", "Zelda64Recompiled-v1.2.2-Windows.pdb.zip"];
    assert.equal(pickRecompAsset(zelda, "win32"), "Zelda64Recompiled-v1.2.2-Windows.zip");
    assert.equal(pickRecompAsset(zelda, "linux"), "Zelda64Recompiled-v1.2.2-Linux-X64.zip");
    assert.equal(pickRecompAsset(zelda, "linux", "arm64"), "Zelda64Recompiled-v1.2.2-Linux-ARM64.zip");
    assert.equal(pickRecompAsset(["Game-Setup.exe", "Game-Windows.zip.sha256"], "win32"), null);
    assert.equal(pickRecompAsset(["Game-x86_64.AppImage", "Game-Windows-x64.7z"], "linux"), "Game-x86_64.AppImage");
    assert.equal(sha256FromDigest("sha256:" + "AB".repeat(32)), "ab".repeat(32));
    assert.equal(sha256FromDigest(null), null);
  });

  it("reads N64 headers in every byte order and checks it's the right game", () => {
    const mm = rom("ZELDA MAJORA'S MASK");
    assert.deepEqual(n64Header(v64(mm)), { order: "v64", name: "ZELDA MAJORA'S MASK", country: "E", version: 0 });
    assert.deepEqual(toZ64(v64(mm)), mm);
    const zelda = recompInfo("zelda64recomp")!;
    assert.equal(recompRomProblem(zelda, v64(mm)), null);
    assert.match(recompRomProblem(zelda, rom("SUPER MARIO 64"))!, /"SUPER MARIO 64"/);
    assert.match(recompRomProblem(zelda, rom("ZELDA MAJORA'S MASK", "P"))!, /another region/);
    assert.match(recompRomProblem(zelda, new Uint8Array(100))!, /isn't an N64 ROM/);
  });

  it("reads recomplauncher.json and leaves out what isn't safe", () => {
    const m = parseRecompManifest({
      start: { program: ["bin/game.exe", "../../evil.exe", "C:\\Windows\\x.exe"], args: ["--iso", "{game}"], env: { MY_DATA: "{documents}/X", PATH: "/tmp", "bad name": "x" } },
      saves: ["{install}/saves"],
    });
    assert.deepEqual(m, { programs: ["bin/game.exe"], args: ["--iso", "{game}"], env: { MY_DATA: "{documents}/X" }, saves: ["{install}/saves"] });
    assert.deepEqual(parseRecompManifest("nonsense"), { programs: [], args: [], env: {}, saves: [] });
  });
});

let work: string;
let app: FastifyInstance;
let api: GameServerClient;
let sevenZip: SevenZip;
let games: GameSummary[];

function zipDir(cwd: string, zip: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(sevenZip.path, ["a", "-tzip", "-bd", "-y", zip, "."], { cwd, stdio: "ignore" });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`7z ${code}`))));
  });
}

/** GitHub's release list and file download, served from memory. */
function fakeGitHub(zip: Buffer, digest: string | null, tag = "v1.2.2") {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.startsWith("https://api.github.com/repos/Zelda64Recomp/Zelda64Recomp/releases")) {
      return Response.json([
        { tag_name: "v1.3.0-beta", prerelease: true, draft: false, assets: [{ name: "Zelda64Recompiled-v1.3.0-Linux-X64.zip", browser_download_url: "https://example.test/beta.zip" }] },
        { tag_name: tag, prerelease: false, draft: false, assets: [{ name: `Zelda64Recompiled-${tag}-Linux-X64.zip`, browser_download_url: "https://example.test/zelda.zip", digest }, { name: `Zelda64Recompiled-${tag}-Windows.zip`, browser_download_url: "https://example.test/win.zip" }] },
      ]);
    }
    if (u === "https://example.test/zelda.zip") return new Response(new Uint8Array(zip), { headers: { "content-length": String(zip.length) } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "gm-recomp-"));
  const g = path.join(work, "games");
  await mkdir(path.join(g, "Emulation", "n64"), { recursive: true });
  await writeFile(path.join(g, "Emulation", "n64", "Legend of Zelda, The - Majora's Mask (USA).v64"), v64(rom("ZELDA MAJORA'S MASK")));
  const built = buildApp({ ...loadConfig({}), gamesDir: g, dataDir: path.join(work, "data"), logLevel: "silent" }, openDatabase(":memory:"));
  app = built.app;
  await built.ctx.library.rescan();
  const admin = await built.ctx.users.create({ username: "admin", password: "password1", role: "admin" });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  api = new GameServerClient({ serverUrl: base, apiToken: built.ctx.auth.createApiToken(admin.id, "t").token });
  games = await api.listGames();
  sevenZip = (await findSevenZip(""))!;
});

after(async () => {
  await app.close();
  await rm(work, { recursive: true, force: true });
});

describe("recomps: install and play", { skip: process.platform === "win32" }, () => {
  it("installs from GitHub after checking the file, plays the library ROM and keeps its saves apart", async () => {
    const tools = path.join(work, "tools");
    // A release zip with one folder on top and a stand-in recomp that acts like N64ModernRuntime:
    // portable.txt in the folder it starts in, the ROM stored as <id>.z64 there, saves in saves/.
    const rel = path.join(work, "release", "Zelda64Recompiled-v1.2.2");
    await mkdir(rel, { recursive: true });
    await writeFile(
      path.join(rel, "Zelda64Recompiled"),
      '#!/bin/sh\n[ -f portable.txt ] || exit 3\n[ -f mm.n64.us.1.0.z64 ] || exit 4\nmkdir -p saves\necho "$LOOTDEN $*" > args.txt\necho "owl statue" > saves/mm.n64.us.1.0.bin\n',
    );
    const zip = path.join(work, "zelda.zip");
    await zipDir(path.join(work, "release"), zip);
    const bytes = await readFile(zip);
    const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");

    // A file that doesn't match GitHub's checksum is never unpacked.
    await assert.rejects(installRecomp("zelda64recomp", { toolsDir: tools, sevenZip, platform: "linux", arch: "x64", fetchImpl: fakeGitHub(bytes, "sha256:" + "0".repeat(64)) }), /doesn't match the checksum/);
    assert.equal((await readTools(tools)).recomps.zelda64recomp, undefined);

    const installed = await installRecomp("zelda64recomp", { toolsDir: tools, sevenZip, platform: "linux", arch: "x64", fetchImpl: fakeGitHub(bytes, digest) });
    assert.equal(installed.version, "v1.2.2");
    assert.equal(installed.exe, path.join(recompDir(tools, "zelda64recomp"), "Zelda64Recompiled"));
    assert.ok(await stat(path.join(recompDir(tools, "zelda64recomp"), "portable.txt")));
    // Same version again: nothing downloaded.
    assert.equal((await installRecomp("zelda64recomp", { toolsDir: tools, sevenZip, platform: "linux", fetchImpl: fakeGitHub(bytes, digest) })).updated, false);

    const zelda = games.find((x) => x.platform === "n64")!;
    const dir = await installGame(api, zelda.id, { installDir: path.join(work, "install"), keepArchives: false, sevenZipPath: "", device: "desktop" });
    const session = await playRecomp(api, zelda.id, dir, "zelda64recomp", { toolsDir: tools, sevenZip, platform: "linux", device: "desktop" });
    const data = recompDir(tools, "zelda64recomp");
    // The .v64 from the library went in as the big-endian copy the recomp checks.
    assert.deepEqual(new Uint8Array(await readFile(path.join(data, "mm.n64.us.1.0.z64"))), rom("ZELDA MAJORA'S MASK"));
    assert.equal(await readFile(path.join(data, "args.txt"), "utf8"), "1 \n");
    assert.ok(session.backup);
    assert.equal(session.backup.runner, "recomp:zelda64recomp");
    assert.equal((await api.listSaves(zelda.id))[0]!.runner, "recomp:zelda64recomp");

    // Another PC: the recomp's backup comes down; it's never handed to the emulator.
    await rm(path.join(data, "saves"), { recursive: true });
    const t = await readTools(tools);
    t.restored = {};
    await writeFile(path.join(tools, "lootden-tools.json"), JSON.stringify(t));
    const plan = await planRecomp(dir, "zelda64recomp", { toolsDir: tools, sevenZip, platform: "linux" });
    assert.equal((await restoreRecompSaves(api, zelda.id, plan, { toolsDir: tools, sevenZip, device: "laptop" }))?.id, session.backup.id);
    assert.equal(await readFile(path.join(data, "saves", "mm.n64.us.1.0.bin"), "utf8"), "owl statue\n");

    // Removing it keeps the saves for next time.
    assert.deepEqual(await removeRecomp("zelda64recomp", tools), { keptSaves: true });
    assert.equal((await readTools(tools)).recomps.zelda64recomp, undefined);
    assert.equal(await readFile(path.join(data, "saves", "mm.n64.us.1.0.bin"), "utf8"), "owl statue\n");
    await assert.rejects(planRecomp(dir, "zelda64recomp", { toolsDir: tools, sevenZip, platform: "linux" }), /Set up Zelda 64: Recompiled first/);
  });
});
