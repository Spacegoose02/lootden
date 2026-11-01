import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRobloxPlayer, robloxSettingsDirs, setRobloxFullscreen, trackRoblox, withFullscreen } from "../src/roblox.js";

describe("Roblox play tracking", () => {
  it("knows the Roblox player by its program", () => {
    assert.ok(isRobloxPlayer({ pid: 1, path: "C:\\Users\\sam\\AppData\\Local\\Roblox\\Versions\\version-1\\RobloxPlayerBeta.exe" }));
    assert.ok(isRobloxPlayer({ pid: 1, path: "/app/bin/sober\0--" }));
    assert.ok(!isRobloxPlayer({ pid: 1, path: "C:\\Users\\sam\\AppData\\Local\\Roblox\\Versions\\version-1\\RobloxPlayerInstaller.exe" }));
    assert.ok(!isRobloxPlayer({ pid: 1, path: "C:\\Games\\Portal 2\\portal2.exe" }));
  });

  it("waits for the player, counts until it closes, and closes it when time's up", async () => {
    // Starting, then running for three looks, then gone.
    const frames = [[], [], [{ pid: 7, path: "RobloxPlayerBeta.exe" }], [{ pid: 7, path: "RobloxPlayerBeta.exe" }], [{ pid: 7, path: "RobloxPlayerBeta.exe" }], []];
    let started = false;
    const seconds = await trackRoblox({ pollMs: 1, list: async () => frames.shift() ?? [], onStarted: () => (started = true) });
    assert.ok(started);
    assert.equal(seconds, 0, "a few ms round to no time");

    const killed: number[] = [];
    const stop = new AbortController();
    stop.abort();
    let running = true;
    await trackRoblox({ pollMs: 1, stop: stop.signal, list: async () => (running ? [{ pid: 9, path: "RobloxPlayerBeta.exe" }] : []), kill: (pid) => (killed.push(pid), (running = false)) });
    assert.deepEqual(killed, [9]);
  });

  it("gives up when the player never starts", async () => {
    assert.equal(await trackRoblox({ pollMs: 1, startTimeoutMs: 5, list: async () => [] }), 0);
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
