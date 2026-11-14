import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { biosRequirementFor, isSwitchAddon, pickRomFile, platformFor } from "@lootden/shared";
import { addBiosFile, biosStatus, emulatorDataDir, emulatorInfo, installEmulator, planLaunch, readTools, switchFirmwareDir, zipFiles } from "../src/emulators.js";
import { findSevenZip, type SevenZip } from "../src/extractor.js";

/** Answers GitHub's releases list with the given asset names, and any other URL with the bytes "bin". */
function fakeGitHub(assets: string[]) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    if (String(url).startsWith("https://api.github.com/")) {
      const list = [{ tag_name: "v0.1.0", prerelease: false, draft: false, assets: assets.map((name) => ({ name, browser_download_url: `https://dl.test/${name}` })) }];
      return new Response(JSON.stringify(list));
    }
    if (String(url).startsWith("https://dl.test/")) return new Response("bin");
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe("Switch and Switch 2", () => {
  it("are systems of their own, found by their usual folder names", () => {
    assert.equal(platformFor("switch").emulator, "eden");
    assert.equal(platformFor("Nintendo Switch").id, "switch");
    assert.equal(platformFor("nsw").id, "switch");
    assert.equal(platformFor("switch2").name, "Nintendo Switch 2");
    assert.equal(platformFor("NS2").id, "switch2");
    // Nothing LootDen can set up plays Switch 2 yet, and the shelf says so.
    assert.equal(platformFor("switch2").emulator, null);
    assert.match(platformFor("switch2").note ?? "", /No Switch 2 emulator/);
  });

  it("opens the base game, not the update or DLC that came with it", () => {
    const sw = platformFor("switch");
    const files = [
      "Zelda [0100F2C0115B6800][v131072].nsp",
      "Zelda [0100F2C0115B6000][v0].nsp",
      "Zelda [0100F2C0115B7001][DLC].nsp",
    ];
    assert.equal(pickRomFile(files, sw), "Zelda [0100F2C0115B6000][v0].nsp");
    assert.equal(pickRomFile(["Game [UPD].nsp", "Game.nsp"], sw), "Game.nsp");
    // A cartridge dump beats an NSP; an update alone still opens rather than nothing.
    assert.equal(pickRomFile(["Game.nsp", "Game.xci"], sw), "Game.xci");
    assert.equal(pickRomFile(["Game [v65536].nsp"], sw), "Game [v65536].nsp");
    assert.equal(pickRomFile(["setup.exe", "data.bin"], sw), null);
    assert.equal(isSwitchAddon("Game (Update 1.2.0).nsp"), true);
    assert.equal(isSwitchAddon("Game [0100ABCD12340000].xci"), false);
  });

  it("knows keys and firmware by name, for the server's BIOS uploads", () => {
    assert.equal(biosRequirementFor("prod.keys")?.requirement.id, "prodkeys");
    assert.equal(biosRequirementFor("title.keys")?.requirement.id, "titlekeys");
    assert.equal(biosRequirementFor("Firmware 20.1.0.zip")?.emulator.id, "eden");
    assert.equal(biosRequirementFor("firmware.bin")?.emulator.id, "retroarch", "the DS firmware stays RetroArch's");
  });

  it("downloads Eden's standard build for each computer", async () => {
    const assets = [
      "Eden-Windows-v0.1.0-amd64-clang-pgo.zip",
      "Eden-Windows-v0.1.0-amd64-msvc-standard.zip",
      "Eden-Windows-v0.1.0-arm64-msvc-standard.zip",
      "Eden-Linux-v0.1.0-amd64-gcc-steamdeck.AppImage",
      "Eden-Linux-v0.1.0-amd64-gcc-standard.AppImage",
      "Eden-Linux-v0.1.0-aarch64-gcc-standard.AppImage",
      "Eden-Android-v0.1.0-standard.apk",
    ];
    const work = await mkdtemp(path.join(os.tmpdir(), "lootden-eden-"));
    try {
      const sevenZip: SevenZip = { path: "/nonexistent/7za", supportsRar: false };
      const flatpaks = async () => new Set<string>();
      for (const [arch, want] of [
        ["x64", "Eden-Linux-v0.1.0-amd64-gcc-standard.AppImage"],
        ["arm64", "Eden-Linux-v0.1.0-aarch64-gcc-standard.AppImage"],
      ] as const) {
        const gh = fakeGitHub(assets);
        const tools = path.join(work, arch);
        const r = await installEmulator("eden", { toolsDir: tools, sevenZip, platform: "linux", arch, fetchImpl: gh.fetchImpl, flatpaks });
        assert.match(gh.urls[0]!, /repos\/eden-emulator\/Releases\/releases/);
        assert.equal(path.basename(r.exe), want);
        assert.equal((await readTools(tools)).emulators.eden!.version, "v0.1.0");
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("playing Switch games in Eden", { skip: process.platform === "win32" }, () => {
  let work: string;
  let tools: string;
  let sevenZip: SevenZip | null;
  let xdg: string | undefined;
  before(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), "lootden-switch-"));
    tools = path.join(work, "tools");
    xdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(work, "xdg");
    sevenZip = await findSevenZip("");
  });
  after(async () => {
    process.env.XDG_DATA_HOME = xdg;
    await rm(work, { recursive: true, force: true });
  });

  it("needs the keys, then starts the base game full screen", async () => {
    const game = path.join(work, "games", "Zelda");
    await mkdir(game, { recursive: true });
    await writeFile(path.join(game, "Zelda [0100F2C0115B6000][v0].nsp"), "base");
    await writeFile(path.join(game, "Zelda [0100F2C0115B6800][v131072].nsp"), "update");
    const opts = { toolsDir: tools, sevenZip: sevenZip ?? { path: "", supportsRar: false }, platform: "linux" as const };
    await assert.rejects(planLaunch(game, "switch", opts), /Set up Eden first/);

    await mkdir(path.join(tools, "eden"), { recursive: true });
    const exe = path.join(tools, "eden", "Eden-Linux-amd64-gcc-standard.AppImage");
    await writeFile(exe, "#!/bin/sh\n");
    await chmod(exe, 0o755);
    await writeFile(path.join(tools, "lootden-tools.json"), JSON.stringify({ emulators: { eden: { version: "test", exe: path.relative(tools, exe), installedAt: "" } } }));
    await assert.rejects(planLaunch(game, "switch", opts), /needs Switch keys \(prod\.keys\)/);

    const keys = path.join(work, "prod.keys");
    await writeFile(keys, "header_key = 00\n");
    await addBiosFile(tools, emulatorInfo("eden")!, keys, "linux");
    const data = path.join(work, "xdg", "eden");
    assert.equal(emulatorDataDir(tools, "eden", "linux"), data);
    assert.equal(await readFile(path.join(data, "keys", "prod.keys"), "utf8"), "header_key = 00\n");

    const plan = await planLaunch(game, "switch", opts);
    assert.deepEqual(plan.args, ["-f", "-g", path.join(game, "Zelda [0100F2C0115B6000][v0].nsp")]);
    assert.deepEqual(plan.saveDirs, ["nand/user/save"]);
  });

  it("explains that a repack with an installer isn't a Switch dump", async () => {
    const game = path.join(work, "games", "Mario Kart World");
    await mkdir(game, { recursive: true });
    await writeFile(path.join(game, "setup.exe"), "x");
    await writeFile(path.join(game, "fg-01.bin"), "x");
    await assert.rejects(planLaunch(game, "switch", { toolsDir: tools, sevenZip: { path: "", supportsRar: false }, platform: "linux" }), /Windows installer with its own emulator/);
  });

  it("unpacks a firmware zip into Eden's NAND, replacing the old firmware", async (t) => {
    if (!sevenZip) return t.skip("no 7-Zip here");
    const src = path.join(work, "fw");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "0a1b.nca"), "system");
    await writeFile(path.join(src, "2c3d.cnmt.nca"), "meta");
    const zip = path.join(work, "Firmware 20.1.0.zip");
    await zipFiles(sevenZip, src, ["0a1b.nca", "2c3d.cnmt.nca"], zip);

    const dir = switchFirmwareDir(path.join(work, "xdg", "eden"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "old.nca"), "old firmware");
    assert.equal((await biosStatus(tools, "linux")).find((b) => b.requirement.id === "switchfw")!.present, "installed");

    await addBiosFile(tools, emulatorInfo("eden")!, zip, "linux", sevenZip);
    assert.deepEqual((await readdir(dir)).sort(), ["0a1b.nca", "2c3d.cnmt.nca"]);
  });
});
