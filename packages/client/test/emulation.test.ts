import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { browserRomFile, pickRomFile, platformFor, romTitle, sharedSavePath, type GameSummary } from "@lootden/shared";
import { buildApp, loadConfig, openDatabase } from "@lootden/server/lib";
import { GameServerClient } from "../src/api.js";
import { biosFromServer, biosStatus, planLaunch, playEmulated, readTools, restoreEmulatorSaves } from "../src/emulators.js";
import { findSevenZip, type SevenZip } from "../src/extractor.js";
import { listInstalled } from "../src/installed.js";
import { installGame } from "../src/installer.js";

let work: string;
let app: FastifyInstance;
let api: GameServerClient;
let token: string;
let base: string;
let sevenZip: SevenZip;
let games: GameSummary[];

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "gm-emu-"));
  const g = path.join(work, "games");
  await mkdir(path.join(g, "Hades"), { recursive: true });
  await writeFile(path.join(g, "Hades", "Hades.exe"), "x");
  await mkdir(path.join(g, "Emulation", "psx", "Crash Bandicoot (USA)"), { recursive: true });
  await writeFile(path.join(g, "Emulation", "psx", "Crash Bandicoot (USA)", "Crash Bandicoot (USA).cue"), 'FILE "Crash Bandicoot (USA).bin" BINARY');
  await writeFile(path.join(g, "Emulation", "psx", "Crash Bandicoot (USA)", "Crash Bandicoot (USA).bin"), "disc");
  await mkdir(path.join(g, "Emulation", "snes"), { recursive: true });
  await writeFile(path.join(g, "Emulation", "snes", "Super Mario World (USA).sfc"), "rom");
  await mkdir(path.join(g, "Emulation", "bios"), { recursive: true });
  await writeFile(path.join(g, "Emulation", "bios", "scph5501.bin"), "not a game");

  const built = buildApp({ ...loadConfig({}), gamesDir: g, dataDir: path.join(work, "data"), logLevel: "silent" }, openDatabase(":memory:"));
  app = built.app;
  await built.ctx.library.rescan();
  const admin = await built.ctx.users.create({ username: "admin", password: "password1", role: "admin" });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
  token = built.ctx.auth.createApiToken(admin.id, "t").token;
  api = new GameServerClient({ serverUrl: base, apiToken: token });
  games = await api.listGames();
  sevenZip = (await findSevenZip(""))!;
});

after(async () => {
  await app.close();
  await rm(work, { recursive: true, force: true });
});

describe("emulation", () => {
  it("reads Emulation/<system>/ folders as their own shelf", async () => {
    assert.deepEqual(games.map((x) => [x.title, x.platform, x.layout]).sort(), [
      ["Crash Bandicoot", "ps1", "folder"],
      ["Hades", "pc", "folder"],
      ["Super Mario World", "snes", "file"],
    ]);
    // Disc images are fine for emulators; only PC discs need setting up.
    assert.equal(games.find((x) => x.platform === "ps1")!.needsSetup, null);
    const emulated = await api.json<GameSummary[]>("/api/games?platform=emulated");
    assert.deepEqual(emulated.map((x) => x.platform).sort(), ["ps1", "snes"]);
    const pc = await api.json<GameSummary[]>("/api/games?platform=pc");
    assert.deepEqual(pc.map((x) => x.title), ["Hades"]);
    const overview = await api.json<{ library: Array<{ id: string; count: number }> }>("/api/emulation");
    assert.deepEqual(overview.library.map((x) => x.id), ["pc", "ps1", "snes"]);
    const home = await api.json<{ sections: Array<{ id: string; games: GameSummary[] }> }>("/api/home");
    assert.deepEqual(home.sections.find((s) => s.id === "recent")!.games.map((x) => x.title), ["Hades"]);
    assert.equal(home.sections.find((s) => s.id === "emulation")!.games.length, 2);
  });

  it("names and opens ROMs sensibly", () => {
    assert.equal(romTitle("Final Fantasy VII (USA) (Disc 1) [!].chd", true), "Final Fantasy VII");
    assert.equal(romTitle("Dr. Mario (World)"), "Dr. Mario");
    assert.equal(pickRomFile(["Game.bin", "Game.cue"], platformFor("ps1")), "Game.cue");
    assert.equal(pickRomFile(["Game/PS3_GAME/USRDIR/EBOOT.BIN", "Game/PS3_GAME/ICON0.PNG"], platformFor("ps3")), "Game/PS3_GAME/USRDIR/EBOOT.BIN");
    assert.equal(platformFor("megadrive").id, "genesis");
  });

  it("plays single-file games in the browser and shares the save with the desktop", async () => {
    const snes = games.find((x) => x.platform === "snes")!;
    const page = await fetch(`${base}/api/games/${snes.id}/play`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /EJS_core = "snes"/);
    assert.match(html, /files\/0\/Super%20Mario%20World%20\(USA\)\.sfc/);
    assert.match(html, /"savePath":"saves\/Super Mario World \(USA\)\.srm"/);
    const rom = await fetch(`${base}/api/games/${snes.id}/files/0/Super%20Mario%20World%20(USA).sfc`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(await rom.text(), "rom");
    // Cue sheets with separate tracks need the desktop app; PC games never play in the browser.
    assert.equal(browserRomFile([{ path: "a.cue", index: 0 }, { path: "a (Track 1).bin", index: 1 }, { path: "a (Track 2).bin", index: 2 }], platformFor("ps1")), null);
    assert.equal(browserRomFile([{ path: "a.cue", index: 0 }, { path: "a.bin", index: 1 }], platformFor("ps1"))?.path, "a.bin");
    const crash = games.find((x) => x.platform === "ps1")!;
    assert.equal((await fetch(`${base}/api/games/${crash.id}/play`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    const hades = games.find((x) => x.platform === "pc")!;
    assert.equal((await fetch(`${base}/api/games/${hades.id}/play`, { headers: { Authorization: `Bearer ${token}` } })).status, 400);
  });

  it("stores BIOS files for every player and refuses files no emulator uses", async () => {
    const put = (name: string, body: string) =>
      fetch(`${base}/api/emulation/bios/${name}`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" }, body });
    const ok = await put("scph5501.bin", "ps1 bios");
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { emulator: string }).emulator, "duckstation");
    assert.equal((await put("holiday.jpg", "x")).status, 400);
    assert.deepEqual((await api.json<Array<{ name: string }>>("/api/emulation/bios")).map((b) => b.name), ["scph5501.bin"]);
  });

  it("plays a PS1 game through the emulator and syncs the memory card", { skip: process.platform === "win32" }, async () => {
    process.env.XDG_DATA_HOME = path.join(work, "xdg");
    const tools = path.join(work, "tools");
    const installDir = path.join(work, "install");
    const crash = games.find((x) => x.platform === "ps1")!;
    const dir = await installGame(api, crash.id, { installDir, keepArchives: false, sevenZipPath: "", device: "desktop" });
    assert.equal((await listInstalled([installDir]))[0]!.platform, "ps1");

    // Not set up yet: a clear message instead of a crash.
    await assert.rejects(planLaunch(dir, "ps1", { toolsDir: tools, sevenZip, platform: "linux" }), /Set up DuckStation first/);

    // A stand-in emulator that writes a memory card like DuckStation would.
    await mkdir(path.join(tools, "duckstation"), { recursive: true });
    const exe = path.join(tools, "duckstation", "DuckStation-x64.AppImage");
    await writeFile(exe, '#!/bin/sh\nd="$XDG_DATA_HOME/duckstation"\nmkdir -p "$d/memcards"\necho "$@" > "$d/args"\necho "level 3" > "$d/memcards/Crash Bandicoot (USA)_1.mcd"\n');
    await chmod(exe, 0o755);
    await writeFile(path.join(tools, "lootden-tools.json"), JSON.stringify({ emulators: { duckstation: { version: "test", exe: "duckstation/DuckStation-x64.AppImage", installedAt: "" } } }));
    await assert.rejects(planLaunch(dir, "ps1", { toolsDir: tools, sevenZip, platform: "linux" }), /needs PlayStation BIOS/);

    assert.deepEqual((await biosFromServer(api, tools, "linux")).added, ["scph5501.bin"]);
    assert.ok((await biosStatus(tools, "linux")).find((b) => b.requirement.id === "ps1")!.present);
    // Again: the same file is already there, so nothing is copied twice.
    const again = await biosFromServer(api, tools, "linux");
    assert.deepEqual([again.added, again.already], [[], ["scph5501.bin"]]);
    // PS3 firmware needs RPCS3 to install it: the player is told so, not left with "nothing new".
    const auth = { Authorization: `Bearer ${token}` };
    await fetch(`${base}/api/emulation/bios/PS3UPDAT.PUP`, { method: "PUT", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: "pup" });
    const fw = await biosFromServer(api, tools, "linux");
    assert.deepEqual(fw.problems, [{ name: "PS3UPDAT.PUP", reason: "Set up RPCS3 first, then get the BIOS files again to install it" }]);
    await fetch(`${base}/api/emulation/bios/PS3UPDAT.PUP`, { method: "DELETE", headers: auth });

    const session = await playEmulated(api, crash.id, dir, "ps1", { toolsDir: tools, sevenZip, platform: "linux", device: "desktop" });
    const data = path.join(work, "xdg", "duckstation");
    assert.match(await readFile(path.join(data, "args"), "utf8"), /-batch -fullscreen -- .*Crash Bandicoot \(USA\)\.cue/);
    assert.ok(session.backup, "the changed memory card was uploaded");
    // Cards are named after the game file, matching where the browser player keeps its card.
    assert.match(await readFile(path.join(data, "settings.ini"), "utf8"), /\[MemoryCards\]\nCard1Type = PerGameFileTitle/);
    assert.equal(sharedSavePath(platformFor("ps1"), "Crash Bandicoot (USA).cue"), "memcards/Crash Bandicoot (USA)_1.mcd");
    assert.equal((await api.listSaves(crash.id)).length, 1);

    // Another PC: no memory card yet, so the backup comes down before playing.
    await rm(path.join(data, "memcards"), { recursive: true });
    const t = await readTools(tools);
    delete t.restored[crash.id];
    await writeFile(path.join(tools, "lootden-tools.json"), JSON.stringify(t));
    const plan = await planLaunch(dir, "ps1", { toolsDir: tools, sevenZip, platform: "linux" });
    const restored = await restoreEmulatorSaves(api, crash.id, plan, tools, sevenZip, "laptop");
    assert.equal(restored?.id, session.backup!.id);
    assert.equal(await readFile(path.join(data, "memcards", "Crash Bandicoot (USA)_1.mcd"), "utf8"), "level 3\n");
    // Already applied: not downloaded again.
    assert.equal(await restoreEmulatorSaves(api, crash.id, plan, tools, sevenZip, "laptop"), null);
  });
});
