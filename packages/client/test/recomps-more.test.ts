import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { parseRecompManifest, platformFor, type GameSummary } from "@lootden/shared";
import { buildApp, loadConfig, openDatabase } from "@lootden/server/lib";
import { GameServerClient } from "../src/api.js";
import { checkGameCopy, iso9660RootNames, xdvdfsRootNames } from "../src/discs.js";
import { readTools } from "../src/emulators.js";
import { findSevenZip, type SevenZip } from "../src/extractor.js";
import { installGame } from "../src/installer.js";
import { installRecompMod, parseThunderstore, recompMods, removeRecompMod, wantedModFile } from "../src/recompmods.js";
import { installRecomp, planRecomp, recompDir } from "../src/recomps.js";

const SECTOR = 2048;

/** A tiny ISO 9660 image with these files in its top folder. */
function isoImage(names: string[]): Buffer {
  const b = Buffer.alloc(20 * SECTOR);
  const pvd = 16 * SECTOR;
  b[pvd] = 1;
  b.write("CD001", pvd + 1, "ascii");
  b[pvd + 156] = 34;
  b.writeUInt32LE(18, pvd + 156 + 2);
  b.writeUInt32LE(SECTOR, pvd + 156 + 10);
  let at = 18 * SECTOR;
  for (const raw of ["\0", "\x01", ...names.map((n) => `${n};1`)]) {
    const len = 33 + raw.length + ((33 + raw.length) % 2);
    b[at] = len;
    b[at + 32] = raw.length;
    b.write(raw, at + 33, "latin1");
    at += len;
  }
  return b;
}

/** A tiny Xbox (XDVDFS) image, its game partition starting at `base`, with two files in a two-entry tree. */
function xdvdfsImage(names: [string, string], base = 0): Buffer {
  const b = Buffer.alloc(base + 40 * SECTOR);
  b.write("MICROSOFT*XBOX*MEDIA", base + 32 * SECTOR, "ascii");
  b.writeUInt32LE(34, base + 32 * SECTOR + 20);
  b.writeUInt32LE(SECTOR, base + 32 * SECTOR + 24);
  const dir = base + 34 * SECTOR;
  b.writeUInt16LE(0, dir);
  b.writeUInt16LE(8, dir + 2); // right child at 32 bytes
  b[dir + 13] = names[0].length;
  b.write(names[0], dir + 14, "latin1");
  b[dir + 32 + 13] = names[1].length;
  b.write(names[1], dir + 32 + 14, "latin1");
  return b;
}

describe("disc and folder checks", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gm-discs-"));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("reads the top folder of PS2 and Xbox 360 disc images, and checks folders", async () => {
    await writeFile(path.join(dir, "ps2.iso"), isoImage(["SLUS_206.51", "SYSTEM.CNF"]));
    assert.deepEqual(await iso9660RootNames(path.join(dir, "ps2.iso")), ["SLUS_206.51", "SYSTEM.CNF"]);
    assert.equal(await checkGameCopy(path.join(dir, "ps2.iso"), { iso9660: "slus_206.51" }), null);
    assert.match((await checkGameCopy(path.join(dir, "ps2.iso"), { iso9660: "SLES_123.45" }))!, /another game or region/);

    // Xbox 360 game partitions start part-way into the disc (0xFD90000 here would be 250 MB; the tree reading is the same at 0).
    await writeFile(path.join(dir, "360.iso"), xdvdfsImage(["default.xex", "media"]));
    assert.deepEqual(await xdvdfsRootNames(path.join(dir, "360.iso")), ["DEFAULT.XEX", "MEDIA"]);
    assert.equal(await checkGameCopy(path.join(dir, "360.iso"), { xdvdfs: "default.xex" }), null);
    assert.match((await checkGameCopy(path.join(dir, "ps2.iso"), { xdvdfs: "default.xex" }))!, /isn't an Xbox disc image/);

    await mkdir(path.join(dir, "Sonic Unleashed", "Media"), { recursive: true });
    await writeFile(path.join(dir, "Sonic Unleashed", "default.xex"), "x");
    assert.equal(await checkGameCopy(path.join(dir, "Sonic Unleashed"), { file: "DEFAULT.XEX" }), null);
    assert.equal(await checkGameCopy(path.join(dir, "Sonic Unleashed"), { xdvdfs: "default.xex" }), null);
    assert.match((await checkGameCopy(path.join(dir, "Sonic Unleashed"), { file: "game.xex" }))!, /no game.xex/);
    assert.match((await checkGameCopy(path.join(dir, "360.iso"), { file: "default.xex" }))!, /as a folder/);
  });

  it("knows Xbox 360 as a system with no emulator yet", () => {
    assert.equal(platformFor("xbox360").id, "x360");
    assert.equal(platformFor("x360").emulator, null);
  });

  it("picks the mod files the game reads", () => {
    assert.ok(wantedModFile("my_mod.nrm", "linux"));
    assert.ok(wantedModFile("Textures.rtz", "win32"));
    assert.ok(wantedModFile("lib.dll", "win32"));
    assert.ok(!wantedModFile("lib.dll", "linux"));
    assert.ok(!wantedModFile("README.md", "linux"));
    const list = parseThunderstore([
      { full_name: "A-Old", name: "Old", is_deprecated: true, versions: [{ download_url: "x" }] },
      { full_name: "B-Mod", name: "Big_Mod", owner: "B", rating_score: 5, versions: [{ version_number: "1.2.0", download_url: "https://x/b", downloads: 10, dependencies: ["C-Lib-1.0.0"] }, { downloads: 5 }] },
    ]);
    assert.deepEqual(list.map((m) => [m.full, m.name, m.downloads, m.deps]), [["B-Mod", "Big Mod", 15, ["C-Lib"]]]);
    assert.deepEqual(parseRecompManifest({ mods: { thunderstore: "zelda-64-recompiled", data: "Zelda64Recompiled" } }).mods, { thunderstore: "zelda-64-recompiled", data: "Zelda64Recompiled" });
    assert.equal(parseRecompManifest({ mods: { thunderstore: "../x", data: "y" } }).mods, null);
  });
});

let work: string;
let app: FastifyInstance;
let api: GameServerClient;
let sevenZip: SevenZip;
let games: GameSummary[];
/** What the server sees when it asks GitHub; each test sets it. */
let serverGitHub: typeof fetch = (async () => new Response("offline", { status: 503 })) as typeof fetch;

function zipDir(cwd: string, zip: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(sevenZip.path, ["a", "-tzip", "-bd", "-y", zip, "."], { cwd, stdio: "ignore" });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`7z ${code}`))));
  });
}

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "gm-recomp3-"));
  const g = path.join(work, "games");
  await mkdir(path.join(g, "Emulation", "xbox360", "Sonic Unleashed (USA)"), { recursive: true });
  await writeFile(path.join(g, "Emulation", "xbox360", "Sonic Unleashed (USA)", "default.xex"), "xex");
  const built = buildApp({ ...loadConfig({}), gamesDir: g, dataDir: path.join(work, "data"), logLevel: "silent" }, openDatabase(":memory:"), {
    fetchImpl: ((url: string | URL | Request, init?: RequestInit) => serverGitHub(url, init)) as typeof fetch,
  });
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

describe("recomps through the server, for Xbox 360, with mods", { skip: process.platform === "win32" }, () => {
  it("downloads a release once on the server and installs every PC from there", async () => {
    // An Xbox 360 recomp that wants the game folder, checked by default.xex, with a Thunderstore community.
    const rel = path.join(work, "release");
    await mkdir(rel, { recursive: true });
    await writeFile(
      path.join(rel, "recomplauncher.json"),
      JSON.stringify({
        start: { program: ["unleashed"], args: ["--game", "{game}"] },
        game: { kind: "iso_or_folder", label: "your Sonic Unleashed (Xbox 360) folder or disc image", check: { xdvdfs: "default.xex" } },
        mods: { thunderstore: "unleashed-recompiled", data: "UnleashedRecomp" },
      }),
    );
    await writeFile(path.join(rel, "unleashed"), "#!/bin/sh\nexit 0\n");
    const zip = path.join(work, "unleashed.zip");
    await zipDir(rel, zip);
    const bytes = await readFile(zip);
    const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    let githubDownloads = 0;
    serverGitHub = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.startsWith("https://api.github.com/repos/hedge-dev/UnleashedRecomp/releases"))
        return Response.json([{ tag_name: "v1.0.3", prerelease: false, draft: false, assets: [{ name: "UnleashedRecomp-Linux-x64.zip", browser_download_url: "https://example.test/u.zip", digest }] }]);
      if (u === "https://example.test/u.zip") {
        githubDownloads++;
        return new Response(new Uint8Array(bytes));
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await api.json("/api/recomps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: "hedge-dev/UnleashedRecomp", platform: "x360", titles: ["Sonic Unleashed"], name: "Unleashed Recompiled" }) });
    const added = (await api.recomps()).added;
    const noGitHubHere = (async () => {
      throw new Error("this PC shouldn't go to GitHub");
    }) as unknown as typeof fetch;

    const release = await api.json<{ version: string; cached: boolean }>("/api/recomps/unleashedrecomp/release?os=linux&arch=x64");
    assert.deepEqual([release.version, release.cached], ["v1.0.3", false]);

    // Two PCs: GitHub is only asked once.
    for (const pc of ["tools-a", "tools-b"]) {
      const events: string[] = [];
      const r = await installRecomp("unleashedrecomp", { api, added, toolsDir: path.join(work, pc), sevenZip, platform: "linux", arch: "x64", fetchImpl: noGitHubHere, onEvent: (e) => events.push(e.message) });
      assert.equal(r.version, "v1.0.3");
      assert.ok(events.some((m) => m.includes(pc === "tools-a" ? "through your LootDen server" : "from your LootDen server")), events.join(" | "));
    }
    assert.equal(githubDownloads, 1);
    assert.equal((await api.json<{ cached: boolean }>("/api/recomps/unleashedrecomp/release?os=linux&arch=x64")).cached, true);

    // A file that doesn't match GitHub's checksum never reaches a PC.
    serverGitHub = (async (url: string | URL | Request) =>
      String(url).includes("api.github.com")
        ? Response.json([{ tag_name: "v9", prerelease: false, draft: false, assets: [{ name: "Bad-Linux-x64.zip", browser_download_url: "https://example.test/bad.zip", digest: "sha256:" + "0".repeat(64) }] }])
        : new Response("tampered")) as typeof fetch;
    await api.json("/api/recomps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: "someone/BadRecomp", platform: "x360", titles: ["Sonic Unleashed"] }) });
    const res = await fetch(api.urlFor("/api/recomps/badrecomp/file?os=linux&arch=x64"), { headers: api.headers() });
    assert.equal(res.status, 502);
    assert.match(await res.text(), /checksum/);

    // The Xbox 360 game from the library is handed over as its folder, checked by default.xex.
    const sonic = games.find((x) => x.platform === "x360")!;
    const dir = await installGame(api, sonic.id, { installDir: path.join(work, "install"), keepArchives: false, sevenZipPath: "", device: "desktop" });
    const plan = await planRecomp(dir, "unleashedrecomp", { added, toolsDir: path.join(work, "tools-a"), sevenZip, platform: "linux" });
    assert.deepEqual(plan.args, ["--game", dir]);
    await rm(path.join(dir, "default.xex"));
    await writeFile(path.join(dir, "other.xex"), "x");
    await assert.rejects(planRecomp(dir, "unleashedrecomp", { added, toolsDir: path.join(work, "tools-a"), sevenZip, platform: "linux" }), /no DEFAULT.XEX .*Unleashed Recompiled needs your Sonic Unleashed/);
  });

  it("installs Thunderstore mods with what they need, and takes them out again", async () => {
    const tools = path.join(work, "tools-a");
    const pkg = async (name: string, files: Record<string, string>) => {
      const d = path.join(work, "mods-src", name);
      await mkdir(d, { recursive: true });
      for (const [f, body] of Object.entries(files)) await writeFile(path.join(d, f), body);
      const z = path.join(work, `${name}.zip`);
      await zipDir(d, z);
      return readFile(z);
    };
    const zips: Record<string, Buffer> = {
      "https://ts.test/lib.zip": await pkg("lib", { "shared.so": "lib", "manifest.json": "{}" }),
      "https://ts.test/hd.zip": await pkg("hd", { "hd_textures.rtz": "pixels", "hd.nrm": "mod", "README.md": "read me", "icon.png": "x" }),
      "https://ts.test/readme.zip": await pkg("readme", { "README.md": "do it by hand" }),
    };
    const thunderstore = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://thunderstore.io/c/unleashed-recompiled/api/v1/package/")
        return Response.json([
          { full_name: "Team-HD", name: "HD", owner: "Team", rating_score: 9, package_url: "https://thunderstore.io/hd", versions: [{ version_number: "2.0.0", download_url: "https://ts.test/hd.zip", downloads: 100, dependencies: ["Team-Lib-1.0.0", "Missing-Thing-1.0.0"] }] },
          { full_name: "Team-Lib", name: "Lib", owner: "Team", rating_score: 1, versions: [{ version_number: "1.0.0", download_url: "https://ts.test/lib.zip", downloads: 3 }] },
          { full_name: "Team-Readme", name: "Readme", owner: "Team", versions: [{ version_number: "1.0.0", download_url: "https://ts.test/readme.zip" }] },
        ]);
      const z = zips[u];
      return z ? new Response(new Uint8Array(z)) : new Response("not found", { status: 404 });
    }) as typeof fetch;
    const added = (await api.recomps()).added;

    const before = await recompMods("unleashedrecomp", { toolsDir: tools, added, fetchImpl: thunderstore });
    assert.deepEqual(before?.available.map((m) => m.full), ["Team-HD", "Team-Lib", "Team-Readme"]);
    const installed = await installRecompMod("unleashedrecomp", "Team-HD", { toolsDir: tools, sevenZip, added, fetchImpl: thunderstore, platform: "linux" });
    assert.deepEqual(installed.map((m) => [m.full, m.dep, m.files.sort()]), [["Team-Lib", true, ["shared.so"]], ["Team-HD", false, ["hd.nrm", "hd_textures.rtz"]]]);
    const mods = path.join(recompDir(tools, "unleashedrecomp"), "mods");
    assert.deepEqual((await readdir(mods)).sort(), ["hd.nrm", "hd_textures.rtz", "shared.so"]);

    await assert.rejects(installRecompMod("unleashedrecomp", "Team-Readme", { toolsDir: tools, sevenZip, added, fetchImpl: thunderstore, platform: "linux" }), /no files the game reads by itself/);

    await writeFile(path.join(mods, "by-hand.nrm"), "mine");
    assert.deepEqual((await recompMods("unleashedrecomp", { toolsDir: tools, added, fetchImpl: thunderstore }))?.others, ["by-hand.nrm"]);
    assert.deepEqual((await removeRecompMod("unleashedrecomp", "Team-HD", { toolsDir: tools, added })).map((m) => m.full), ["Team-Lib"]);
    assert.deepEqual((await readdir(mods)).sort(), ["by-hand.nrm", "shared.so"]);
    assert.deepEqual((await readTools(tools)).recomps.unleashedrecomp?.mods?.map((m) => m.full), ["Team-Lib"]);
  });
});
