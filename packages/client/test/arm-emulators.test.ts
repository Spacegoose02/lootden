import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { biosStatus, emulatorCommand, installCore, installEmulator, planLaunch, readTools } from "../src/emulators.js";
import type { SevenZip } from "../src/extractor.js";

// Emulators on ARM handhelds running Linux (a Retroid Pocket on Armada OS) and Flatpak emulators.
const sevenZip: SevenZip = { path: "/nonexistent/7za", supportsRar: false };

/** Answers GitHub's releases list with the given asset names, and any other URL with the bytes "bin". */
function fakeGitHub(assets: string[]) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    if (String(url).startsWith("https://api.github.com/")) {
      const list = [{ tag_name: "v1", prerelease: false, draft: false, assets: assets.map((name) => ({ name, browser_download_url: `https://dl.test/${name}` })) }];
      return new Response(JSON.stringify(list));
    }
    if (String(url).startsWith("https://dl.test/")) return new Response("bin");
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe("emulators on ARM Linux and from Flatpak", () => {
  let work: string;
  let home: string | undefined;
  before(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), "lootden-arm-"));
    home = process.env.HOME;
    process.env.HOME = path.join(work, "home");
  });
  after(async () => {
    process.env.HOME = home;
    await rm(work, { recursive: true, force: true });
  });

  it("downloads the ARM AppImage on an ARM handheld and the x64 one on a PC", async () => {
    const assets = ["DuckStation-x64.AppImage", "DuckStation-arm64.AppImage", "duckstation-windows-x64-release.zip"];
    const none = async () => new Set<string>();
    const arm = fakeGitHub(assets);
    const armTools = path.join(work, "arm-tools");
    const r = await installEmulator("duckstation", { toolsDir: armTools, sevenZip, platform: "linux", arch: "arm64", fetchImpl: arm.fetchImpl, flatpaks: none });
    assert.match(r.exe, /DuckStation-arm64\.AppImage$/);
    const pc = fakeGitHub(assets);
    const pcTools = path.join(work, "pc-tools");
    assert.match((await installEmulator("duckstation", { toolsDir: pcTools, sevenZip, platform: "linux", arch: "x64", fetchImpl: pc.fetchImpl, flatpaks: none })).exe, /DuckStation-x64\.AppImage$/);
  });

  it("picks RPCS3's ARM builds and skips xemu's debug AppImages", async () => {
    const rpcs3 = fakeGitHub(["rpcs3-v0.0.37-18146-ffeb16fe_linux_aarch64.AppImage"]);
    await installEmulator("rpcs3", { toolsDir: path.join(work, "rpcs3"), sevenZip, platform: "linux", arch: "arm64", fetchImpl: rpcs3.fetchImpl, flatpaks: async () => new Set() });
    assert.match(rpcs3.urls[0]!, /RPCS3\/rpcs3-binaries-linux-arm64\//);

    const xemu = fakeGitHub(["xemu-0.8.138-dbg-aarch64.AppImage", "xemu-0.8.138-aarch64.AppImage", "xemu-0.8.138-x86_64.AppImage"]);
    // The hard drive image download 404s here; the program is in place by then.
    await installEmulator("xemu", { toolsDir: path.join(work, "xemu"), sevenZip, platform: "linux", arch: "arm64", fetchImpl: xemu.fetchImpl, flatpaks: async () => new Set() }).catch(() => {});
    assert.equal((await readTools(path.join(work, "xemu"))).emulators.xemu!.exe, path.join("xemu", "xemu-0.8.138-aarch64.AppImage"));
  });

  it("explains how to get an emulator that has no ARM Linux download", async () => {
    const { fetchImpl, urls } = fakeGitHub([]);
    const opts = { toolsDir: path.join(work, "none"), sevenZip, platform: "linux" as const, arch: "arm64" as const, fetchImpl, flatpaks: async () => new Set<string>() };
    await assert.rejects(installEmulator("pcsx2", opts), /no official download for ARM Linux.*net\.pcsx2\.PCSX2/);
    await assert.rejects(installEmulator("retroarch", opts), /no official download for ARM Linux.*org\.libretro\.RetroArch/);
    assert.deepEqual(urls, []);
  });

  it("uses an installed Flatpak instead of downloading, and plays through flatpak run", async () => {
    const tools = path.join(work, "flatpak-tools");
    const { fetchImpl, urls } = fakeGitHub([]);
    const flatpaks = async () => new Set(["org.duckstation.DuckStation", "org.mozilla.firefox"]);
    const r = await installEmulator("duckstation", { toolsDir: tools, sevenZip, platform: "linux", arch: "arm64", fetchImpl, flatpaks });
    assert.deepEqual(r, { version: "Flatpak", exe: "flatpak:org.duckstation.DuckStation" });
    assert.deepEqual(urls, [], "nothing downloaded");

    // BIOS lives in the Flatpak's own home folder.
    const data = path.join(process.env.HOME!, ".var", "app", "org.duckstation.DuckStation", "data", "duckstation");
    await mkdir(path.join(data, "bios"), { recursive: true });
    await writeFile(path.join(data, "bios", "scph5501.bin"), "bios");
    assert.equal((await biosStatus(tools, "linux")).find((b) => b.requirement.id === "ps1")!.present, "scph5501.bin");

    const game = path.join(work, "sdcard", "Crash");
    await mkdir(game, { recursive: true });
    await writeFile(path.join(game, "Crash.cue"), 'FILE "Crash.bin" BINARY\n');
    await writeFile(path.join(game, "Crash.bin"), "x");
    const plan = await planLaunch(game, "ps1", { toolsDir: tools, sevenZip, platform: "linux" });
    assert.equal(plan.exe, "flatpak");
    assert.deepEqual(plan.args, ["run", `--filesystem=${tools}`, `--filesystem=${game}`, "org.duckstation.DuckStation", "-batch", "-fullscreen", "--", path.join(game, "Crash.cue")]);
    assert.equal(plan.dataDir, data);
    assert.match(await readFile(path.join(data, "settings.ini"), "utf8"), /Card1Type = PerGameFileTitle/);
  });

  it("keeps updating a copy LootDen downloaded even when a Flatpak is also installed", async () => {
    const tools = path.join(work, "both");
    const none = async () => new Set<string>();
    const first = fakeGitHub(["DuckStation-x64.AppImage"]);
    await installEmulator("duckstation", { toolsDir: tools, sevenZip, platform: "linux", arch: "x64", fetchImpl: first.fetchImpl, flatpaks: none });
    const again = fakeGitHub(["DuckStation-x64.AppImage"]);
    const r = await installEmulator("duckstation", { toolsDir: tools, sevenZip, platform: "linux", arch: "x64", fetchImpl: again.fetchImpl, flatpaks: async () => new Set(["org.duckstation.DuckStation"]) });
    assert.match(r.exe, /DuckStation-x64\.AppImage$/);
    assert.ok(again.urls.length > 0);
  });

  it("fetches RetroArch cores built for ARM", async () => {
    const { fetchImpl, urls } = fakeGitHub([]);
    await assert.rejects(installCore("snes9x", { toolsDir: path.join(work, "cores"), sevenZip, platform: "linux", arch: "arm64", fetchImpl }));
    assert.equal(urls[0], "https://buildbot.libretro.com/nightly/linux/aarch64/latest/snes9x_libretro.so.zip");
  });

  it("starts downloaded emulators directly", () => {
    assert.deepEqual(emulatorCommand("/t", "pcsx2/pcsx2.AppImage", ["-batch"]), { cmd: path.join("/t", "pcsx2/pcsx2.AppImage"), args: ["-batch"] });
  });
});
