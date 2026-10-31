import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRobloxPlayer, trackRoblox } from "../src/roblox.js";

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
