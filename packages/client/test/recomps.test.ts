import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { spawn } from "node:child_process";
import type { FastifyInstance } from "fastify";
import {
  cleanCustomRecomp,
  currentChoice,
  n64Header,
  prepareProgress,
  readConfigKeys,
  settingApplies,
  writeConfigKeys,
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
import { installRecomp, planRecomp, playRecomp, recompDir, recompSettings, recompUpdates, removeRecomp, restoreRecompSaves, setRecompSetting } from "../src/recomps.js";

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
    assert.deepEqual({ ...m, config: undefined, settings: undefined, prepare: undefined, exitCodes: undefined }, { programs: ["bin/game.exe"], args: ["--iso", "{game}"], env: { MY_DATA: "{documents}/X" }, saves: ["{install}/saves"], config: undefined, settings: undefined, prepare: undefined, exitCodes: undefined });
    assert.deepEqual(parseRecompManifest("nonsense"), { programs: [], args: [], env: {}, saves: [], config: [], settings: [], prepare: null, exitCodes: {} });
    const full = parseRecompManifest({
      config: [{ format: "toml", file: [{ path: "{install}/game.toml", if: "{install}/portable.txt" }, { path: "{documents}/G/game.toml" }], game_path: "iso_path", ensure: { a: "1" }, new: { b: "2" } }, { format: "yaml", file: "x" }],
      settings: [{ id: "res", label: "Resolution", choices: [{ label: "1x", set: { scale: "1" } }, { label: "2x", set: { scale: "2" } }], defaults: { scale: "1" } }, { id: "bad" }],
      prepare: { program: ["prep.exe", "../x.exe"], args: ["--game", "{game}"], label: "Fonts", timeout: 99999 },
      exit_codes: { "252968961": "Pick your copy again.", abc: "no" },
    });
    assert.equal(full.config.length, 1);
    assert.deepEqual(full.config[0], { id: "main", format: "toml", file: [{ path: "{install}/game.toml", if: "{install}/portable.txt" }, { path: "{documents}/G/game.toml" }], gamePath: "iso_path", ensure: { a: "1" }, always: {}, fresh: { b: "2" } });
    assert.deepEqual(full.settings.map((x) => x.id), ["res"]);
    assert.deepEqual(full.prepare, { programs: ["prep.exe"], args: ["--game", "{game}"], label: "Fonts", timeout: 3600 });
    assert.deepEqual(full.exitCodes, { "252968961": "Pick your copy again." });
  });

  it("edits TOML, INI and JSON settings files without losing what's there", () => {
    const toml = '# my settings\nfullscreen = true\n\n[graphics]\n# how sharp\nscale = 1\n\n[audio]\nvolume = 80\n';
    const out = writeConfigKeys(toml, "toml", { "graphics.scale": "2", "graphics.api": '"vulkan"', fullscreen: "false", top: "1", "input.pad": '"xbox"' });
    assert.equal(out, '# my settings\nfullscreen = false\ntop = 1\n\n[graphics]\n# how sharp\nscale = 2\napi = "vulkan"\n\n[audio]\nvolume = 80\n\n[input]\npad = "xbox"\n');
    assert.deepEqual(readConfigKeys(out, "toml"), { fullscreen: "false", top: "1", "graphics.scale": "2", "graphics.api": '"vulkan"', "audio.volume": "80", "input.pad": '"xbox"' });
    assert.equal(writeConfigKeys("[Video]\r\nWidth=640\r\n", "ini", { "Video.Width": "1280" }), "[Video]\r\nWidth=1280\r\n");
    const json = writeConfigKeys('{"disc":"old","video":{"vsync":true}}', "json", { disc: '"D:/x.iso"', "video.fps": "60" });
    assert.deepEqual(JSON.parse(json), { disc: "D:/x.iso", video: { vsync: true, fps: 60 } });
    assert.deepEqual(readConfigKeys(json, "json"), { disc: '"D:/x.iso"', "video.vsync": "true", "video.fps": "60" });
    assert.equal(writeConfigKeys("", "toml", { a: "1" }), "a = 1\n");
  });

  it("works out which choice a setting is on, and when it applies", () => {
    const s = { id: "w", label: "Window", help: "", in: "main", choices: [{ label: "Small", set: { w: "640" }, args: [] }, { label: "Big", set: { w: "1280" }, args: [] }], defaults: { w: "640", fullscreen: "false" }, when: { fullscreen: "false" } };
    assert.equal(currentChoice(s, {}), 0);
    assert.equal(currentChoice(s, { w: "1280" }), 1);
    assert.equal(currentChoice(s, { w: "999" }), -1);
    assert.equal(settingApplies(s, {}), true);
    assert.equal(settingApplies(s, { fullscreen: "true" }), false);
    assert.deepEqual(prepareProgress("progress 0.4 Unpacking menu art"), { fraction: 0.4, text: "Unpacking menu art" });
    assert.deepEqual(prepareProgress("progress 7"), { fraction: 1, text: "" });
    assert.equal(prepareProgress("hello"), null);
  });

  it("cleans a recomp an admin adds by link", () => {
    const r = cleanCustomRecomp({ repo: "https://github.com/luckvj/streetball-revival/releases", platform: "ps2", titles: ["NBA Street Vol. 2"] }, ["pc", "ps2"]);
    assert.deepEqual(r, { id: "streetballrevival", name: "streetball revival", game: "NBA Street Vol. 2", repo: "luckvj/streetball-revival", platform: "ps2", titles: ["nbastreetvol2"], programs: [], custom: true });
    assert.equal(cleanCustomRecomp({ repo: "luckvj/streetball-revival.git", platform: "ps2", titles: ["x y z"] }, ["ps2"]).repo, "luckvj/streetball-revival");
    assert.throws(() => cleanCustomRecomp({ repo: "not a link", platform: "ps2", titles: ["A"] }, ["ps2"]), /GitHub link/);
    assert.throws(() => cleanCustomRecomp({ repo: "a/b", platform: "pc", titles: ["Abc"] }, ["pc"]), /console/);
    assert.throws(() => cleanCustomRecomp({ repo: "a/b", platform: "ps2", titles: [] }, ["ps2"]), /title/);
    assert.throws(() => cleanCustomRecomp({ repo: "Zelda64Recomp/Zelda64Recomp", platform: "n64", titles: ["Zelda"] }, ["n64"]), /already knows/);
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
  await mkdir(path.join(g, "Emulation", "ps2"), { recursive: true });
  await writeFile(path.join(g, "Emulation", "ps2", "NBA Street Vol. 2 (USA).iso"), "disc");
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

describe("recomps: added by an admin, with a recomplauncher.json", { skip: process.platform === "win32" }, () => {
  it("is listed by the server, writes its settings, runs its setup step once and explains its exit codes", async () => {
    // The server keeps the admin's list; players can read it.
    const added = await api.json<{ id: string }>("/api/recomps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: "https://github.com/luckvj/streetball-revival", platform: "ps2", titles: ["NBA Street Vol. 2"] }) });
    assert.equal(added.id, "streetballrevival");
    const list = await api.recomps();
    assert.deepEqual(list.added.map((r) => r.id), ["streetballrevival"]);
    assert.ok(list.builtIn.some((r) => r.id === "zelda64recomp"));
    const info = list.added[0]!;

    const tools = path.join(work, "tools-sb");
    const rel = path.join(work, "release-sb");
    await mkdir(rel, { recursive: true });
    await writeFile(
      path.join(rel, "recomplauncher.json"),
      JSON.stringify({
        format: 1,
        start: { program: ["street-game"], args: ["--iso", "{game}"], env: { SB_DATA: "{install}/data" } },
        config: [{ id: "launcher", format: "json", file: [{ path: "{install}/launcher.json" }], game_path: "disc", new: { volume: "80" } }],
        settings: [
          { id: "picture", label: "Picture", in: "args", choices: [{ label: "Game's option", args: [] }, { label: "Wide", args: ["--widescreen", "wide"] }] },
          { id: "volume", label: "Volume", in: "launcher", choices: [{ label: "Loud", set: { volume: "100" } }, { label: "Normal", set: { volume: "80" } }] },
        ],
        prepare: { program: ["prep"], args: ["--game", "{game}"], label: "Fonts from your disc" },
        exit_codes: { "7": "Pick your copy again." },
      }),
    );
    await writeFile(path.join(rel, "street-game"), '#!/bin/sh\necho "$* $SB_DATA" > args.txt\nmkdir -p saves\necho court > saves/s.bin\n[ -f fail ] && exit 7\nexit 0\n');
    await writeFile(path.join(rel, "prep"), '#!/bin/sh\necho "progress 0.5 Fonts"\necho run >> prep.log\n');
    const zip = path.join(work, "sb.zip");
    await zipDir(rel, zip);
    const bytes = await readFile(zip);
    const github = (tag: string) =>
      (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.startsWith("https://api.github.com/repos/luckvj/streetball-revival/releases"))
          return Response.json([{ tag_name: tag, prerelease: false, draft: false, assets: [{ name: "StreetballRevival-Linux-x64.zip", browser_download_url: "https://example.test/sb.zip" }] }]);
        if (u === "https://example.test/sb.zip") return new Response(new Uint8Array(bytes));
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

    await installRecomp("streetballrevival", { added: list.added, toolsDir: tools, sevenZip, platform: "linux", arch: "x64", fetchImpl: github("v1.0") });
    // Offline later: the details it was set up with are kept.
    assert.equal((await readTools(tools)).recomps.streetballrevival!.info?.repo, "luckvj/streetball-revival");
    const data = recompDir(tools, "streetballrevival");

    // Settings on the game's page: one passed on the command line, one in its settings file.
    assert.deepEqual((await recompSettings("streetballrevival", { toolsDir: tools, platform: "linux" })).map((x) => [x.id, x.current]), [["picture", 0], ["volume", -1]]);
    await setRecompSetting("streetballrevival", "picture", 1, { toolsDir: tools, platform: "linux" });
    const after = await setRecompSetting("streetballrevival", "volume", 0, { toolsDir: tools, platform: "linux" });
    assert.deepEqual(after.map((x) => [x.id, x.current]), [["picture", 1], ["volume", 0]]);

    const game = games.find((x) => x.platform === "ps2")!;
    const dir = await installGame(api, game.id, { installDir: path.join(work, "install-sb"), keepArchives: false, sevenZipPath: "", device: "desktop" });
    const events: string[] = [];
    const first = await playRecomp(api, game.id, dir, "streetballrevival", { toolsDir: tools, sevenZip, platform: "linux", device: "desktop", onEvent: (e) => events.push(e.message) });
    const iso = path.join(dir, "NBA Street Vol. 2 (USA).iso");
    assert.equal(await readFile(path.join(data, "args.txt"), "utf8"), `--iso ${iso} --widescreen wide ${data}/data\n`);
    assert.deepEqual(JSON.parse(await readFile(path.join(data, "launcher.json"), "utf8")), { volume: 100, disc: iso });
    assert.ok(events.includes("Fonts from your disc: Fonts (50%)"), events.join(" | "));
    assert.equal(first.problem, null);
    assert.equal(first.backup?.runner, "recomp:streetballrevival");

    // The setup step only runs again when the game file changes; exit codes get the recomp's own message.
    await writeFile(path.join(data, "fail"), "");
    const second = await playRecomp(api, game.id, dir, "streetballrevival", { toolsDir: tools, sevenZip, platform: "linux", device: "desktop" });
    assert.equal(await readFile(path.join(data, "prep.log"), "utf8"), "run\n");
    assert.equal(second.exitCode, 7);
    assert.equal(second.problem, "Pick your copy again.");

    // Updates: only when GitHub has a newer full release.
    assert.deepEqual(await recompUpdates({ toolsDir: tools, platform: "linux", arch: "x64", fetchImpl: github("v1.0") }), []);
    assert.deepEqual(await recompUpdates({ toolsDir: tools, platform: "linux", arch: "x64", fetchImpl: github("v1.1") }), [{ id: "streetballrevival", installed: "v1.0", latest: "v1.1" }]);

    // Taking it off the server's list.
    assert.deepEqual(await api.json("/api/recomps/streetballrevival", { method: "DELETE" }), { ok: true });
    assert.deepEqual((await api.recomps()).added, []);
  });
});
