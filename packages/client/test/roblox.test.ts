import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRobloxPlayer, RobloxLogWatcher, robloxSettingsDirs, setRobloxFullscreen, trackRoblox, withFullscreen } from "../src/roblox.js";

describe("Roblox play tracking", () => {
  it("knows the Roblox player by its program", () => {
    assert.ok(isRobloxPlayer({ pid: 1, path: "C:\\Users\\sam\\AppData\\Local\\Roblox\\Versions\\version-1\\RobloxPlayerBeta.exe" }));
    assert.ok(isRobloxPlayer({ pid: 1, path: "/app/bin/sober\0--" }));
    assert.ok(!isRobloxPlayer({ pid: 1, path: "C:\\Users\\sam\\AppData\\Local\\Roblox\\Versions\\version-1\\RobloxPlayerInstaller.exe" }));
    assert.ok(!isRobloxPlayer({ pid: 1, path: "C:\\Games\\Portal 2\\portal2.exe" }));
  });

  it("waits for the player, counts until it closes, and closes it when time's up", async () => {
    // Starting, then running for three looks, then gone. No log to read: the player running counts.
    const frames = [[], [], [{ pid: 7, path: "RobloxPlayerBeta.exe" }], [{ pid: 7, path: "RobloxPlayerBeta.exe" }], [{ pid: 7, path: "RobloxPlayerBeta.exe" }], []];
    let started = false;
    const seconds = await trackRoblox({ pollMs: 1, inGame: async () => null, list: async () => frames.shift() ?? [], onStarted: () => (started = true) });
    assert.ok(started);
    assert.equal(seconds, 0, "a few ms round to no time");

    const killed: number[] = [];
    const stop = new AbortController();
    stop.abort();
    let running = true;
    await trackRoblox({ pollMs: 1, inGame: async () => true, stop: stop.signal, list: async () => (running ? [{ pid: 9, path: "RobloxPlayerBeta.exe" }] : []), kill: (pid) => (killed.push(pid), (running = false)) });
    assert.deepEqual(killed, [9]);
  });

  it("gives up when the player never starts", async () => {
    assert.equal(await trackRoblox({ pollMs: 1, startTimeoutMs: 5, inGame: async () => null, list: async () => [] }), 0);
  });

  it("only counts time in a game, not Roblox sitting in the tray, and ends when the game is left", async () => {
    const player = [{ pid: 3, path: "RobloxPlayerBeta.exe" }];
    // Roblox in the tray the whole time; a game for a while, then back to the home screen.
    const states = [false, false, true, true, true, false, false, false, false];
    let started = 0;
    let looks = 0;
    const seconds = await trackRoblox({
      pollMs: 20,
      leaveGraceMs: 50,
      list: async () => player,
      inGame: async () => (looks++, states.shift() ?? false),
      onStarted: () => started++,
    });
    assert.equal(started, 1);
    assert.equal(seconds, 0, "about 60 ms in the game");
    assert.ok(looks < 12, "the session ended with Roblox still open");

    // Roblox in the tray and no game ever joined: nothing counts, and it gives up.
    let inTray = 0;
    assert.equal(await trackRoblox({ pollMs: 1, startTimeoutMs: 20, list: async () => player, inGame: async () => (inTray++, false), onStarted: () => assert.fail("never played") }), 0);
    assert.ok(inTray > 0);
  });

  it("reads joins and leaves from Roblox's newest log as it grows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "roblox-logs-"));
    assert.equal(await new RobloxLogWatcher([path.join(dir, "missing")], Date.now()).poll(), null, "no log folder: can't tell");
    const w = new RobloxLogWatcher([dir], Date.now());
    assert.equal(await w.poll(), false, "a folder but no log yet: not in a game");
    const log = path.join(dir, "0.650.0.6500718_20261101T170000Z_Player_A1B2C_last.log");
    await writeFile(log, "2026-11-01T17:00:00.000Z,0.1,1,6 [FLog::Output] Settings Date header was Sat, 01 Nov 2026\n");
    assert.equal(await w.poll(), false);
    await appendFile(log, "2026-11-01T17:00:05.000Z,5.1,1,6 [FLog::Output] ! Joining game 'abc' place 920587237 at 1.2.3.4\n");
    assert.equal(await w.poll(), true);
    await appendFile(log, "2026-11-01T17:10:00.000Z,600.1,1,6 [FLog::SingleSurfaceApp] leaveUGCGameInternal\n");
    assert.equal(await w.poll(), false);
    await appendFile(log, "2026-11-01T17:11:00.000Z,660.1,1,6 [FLog::Network] serverId: 1.2.3.4|5678\n2026-11-01T17:12:00.000Z,7");
    assert.equal(await w.poll(), true, "joined another game; a half-written line waits");
    await appendFile(log, "20.1,1,6 [FLog::Network] Time to disconnect replication data: 0.01\n");
    assert.equal(await w.poll(), false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("Roblox full screen", () => {
  const settings = (flag: string | null) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<roblox version="4">\n\t<Item class="UserGameSettings">\n\t\t<Properties>\n${flag === null ? "" : `\t\t\t<bool name="Fullscreen">${flag}</bool>\n`}\t\t\t<int name="GraphicsQualityLevel">5</int>\n\t\t</Properties>\n\t</Item>\n</roblox>\n`;

  it("switches full screen on, keeping the rest of the settings", () => {
    assert.equal(withFullscreen(settings("false")), settings("true"));
    assert.equal(withFullscreen(settings("true")), settings("true"));
    const added = withFullscreen(settings(null));
    assert.match(added, /<Properties>\n\t\t\t<bool name="Fullscreen">true<\/bool>/);
    assert.match(added, /GraphicsQualityLevel">5</);
    assert.equal(withFullscreen("not settings"), "not settings");
  });

  it("changes the player's settings files and leaves a missing folder alone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "roblox-"));
    await writeFile(path.join(dir, "GlobalBasicSettings_13.xml"), settings("false"));
    await writeFile(path.join(dir, "Other.xml"), settings("false"));
    assert.deepEqual(await setRobloxFullscreen([dir, path.join(dir, "missing")]), [path.join(dir, "GlobalBasicSettings_13.xml")]);
    assert.equal(await readFile(path.join(dir, "GlobalBasicSettings_13.xml"), "utf8"), settings("true"));
    assert.equal(await readFile(path.join(dir, "Other.xml"), "utf8"), settings("false"));
    assert.deepEqual(await setRobloxFullscreen([dir]), [], "already on");
    assert.deepEqual(robloxSettingsDirs("win32", { LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" }), ["C:\\Users\\sam\\AppData\\Local\\Roblox"]);
    await rm(dir, { recursive: true, force: true });
  });
});
