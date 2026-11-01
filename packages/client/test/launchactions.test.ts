import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanLaunchProfile, describeLaunchStep, emptyLaunchProfile, launchKey, splitArgs } from "@lootden/shared";
import { commandFor, launchActionAndTrack, runLaunchSteps, stepTarget, type Spawner } from "../src/launchactions.js";

/** A spawner that records calls; each process "runs" until the test says it closed. */
function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const spawner: Spawner = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd as string | undefined });
    return { pid: calls.length, exited: cmd === "fail" ? Promise.reject(new Error("ENOENT")) : new Promise<number | null>((r) => setTimeout(() => r(0), 1)) };
  };
  return { calls, spawner };
}

describe("launch options", () => {
  it("checks profiles from the editor", () => {
    const p = cleanLaunchProfile({
      actions: [{ id: "smapi", name: " SMAPI ", steps: [{ type: "run", path: "StardewModdingAPI.exe", args: "" }] }],
      defaultAction: "smapi",
      before: [{ type: "close", name: "Discord.exe" }],
      after: [],
    });
    assert.equal(p.actions[0]!.name, "SMAPI");
    assert.equal(p.defaultAction, "smapi");
    assert.equal(emptyLaunchProfile(p), false);
    assert.throws(() => cleanLaunchProfile({ actions: [{ name: "x", steps: [{ type: "wait", seconds: 5 }] }] }), /needs a program/);
    assert.throws(() => cleanLaunchProfile({ actions: [], before: [{ type: "wait", seconds: 9999 }] }), /1 to 600/);
    assert.throws(() => cleanLaunchProfile({ actions: [], before: [{ type: "close", name: "C:\\x.exe" }] }), /file name/);
    assert.equal(cleanLaunchProfile({ actions: [], defaultAction: "gone" }).defaultAction, null);
    assert.equal(launchKey({ gameId: "abc" }), "lootden:abc");
    assert.equal(launchKey({ addon: "steam", externalId: "271590" }), "store:steam:271590");
    assert.equal(describeLaunchStep({ type: "wait", seconds: 30 }), "Wait 30 s");
  });

  it("splits arguments with quotes", () => {
    assert.deepEqual(splitArgs('-a "two words" -b  c'), ["-a", "two words", "-b", "c"]);
    assert.deepEqual(splitArgs('""'), [""]);
  });

  it("starts scripts through their shell and links through the system", () => {
    assert.deepEqual(commandFor("C:\\g\\x.bat", ["1"], "win32"), { cmd: "cmd.exe", args: ["/d", "/c", "C:\\g\\x.bat", "1"] });
    assert.equal(commandFor("C:\\g\\x.ps1", [], "win32").cmd, "powershell.exe");
    assert.deepEqual(commandFor("C:\\g\\GTA5.exe", ["-x"], "win32"), { cmd: "C:\\g\\GTA5.exe", args: ["-x"] });
    assert.deepEqual(commandFor("steam://rungameid/271590", [], "linux"), { cmd: "xdg-open", args: ["steam://rungameid/271590"] });
    assert.deepEqual(commandFor("/g/game.exe", [], "linux"), { cmd: "wine", args: ["/g/game.exe"] });
    assert.equal(stepTarget("{game}/mods/run.sh", "/games/x"), "/games/x/mods/run.sh");
    assert.equal(stepTarget("bin/run", "/games/x"), "/games/x/bin/run");
  });

  it("runs steps in order with waits between them", async () => {
    const { calls, spawner } = fakeSpawn();
    const waits: number[] = [];
    const dirs = await runLaunchSteps(
      [
        { type: "run", path: "PlayGTAV.exe" },
        { type: "wait", seconds: 45 },
        { type: "run", path: "/games/gta/RAGEPluginHook.exe", args: "-x", waitForExit: true },
        { type: "close", name: "Launcher.exe" },
      ],
      { gameDir: "/games/gta", platform: "linux", spawn: spawner, sleep: async (ms) => void waits.push(ms) },
    );
    assert.deepEqual(
      calls.map((c) => [c.cmd, ...c.args]),
      [["wine", "/games/gta/PlayGTAV.exe"], ["wine", "/games/gta/RAGEPluginHook.exe", "-x"], ["pkill", "-x", "Launcher.exe"]],
    );
    assert.ok(waits.includes(45_000));
    assert.deepEqual(dirs, ["/games/gta"]);
  });

  it("says which program couldn't start", async () => {
    const { spawner } = fakeSpawn();
    const failing: Spawner = (cmd, args, opts) => spawner("fail", args, opts);
    await assert.rejects(runLaunchSteps([{ type: "run", path: "nope.exe", waitForExit: true }], { gameDir: "/g", platform: "linux", spawn: failing }), /Couldn't start nope\.exe/);
  });

  it("tracks the game while anything runs from its folders, waiting for slow launchers", async () => {
    const { spawner } = fakeSpawn();
    let t = 0;
    let polls = 0;
    const seconds = await launchActionAndTrack(
      { id: "a", name: "SMAPI", steps: [{ type: "run", path: "/mods/smapi/StardewModdingAPI" }] },
      {
        gameDir: "/games/stardew",
        platform: "linux",
        spawn: spawner,
        sleep: async (ms) => void (t += ms),
        now: () => t,
        pollMs: 10_000,
        // Nothing for two polls (the launcher is slow), then the game for three, then gone.
        list: async () => {
          polls++;
          return polls > 2 && polls <= 5 ? [{ pid: 99, path: "/mods/smapi/StardewModdingAPI" }] : [];
        },
      },
    );
    assert.equal(polls, 6);
    assert.equal(seconds, 50);
  });

  it("gives up when nothing shows up in time", async () => {
    const { spawner } = fakeSpawn();
    let t = 0;
    const seconds = await launchActionAndTrack(
      { id: "a", name: "x", steps: [{ type: "run", path: "steam://rungameid/1" }] },
      { gameDir: "/g", platform: "linux", spawn: spawner, sleep: async (ms) => void (t += ms), now: () => t, pollMs: 5000, graceMs: 20_000, list: async () => [] },
    );
    assert.equal(seconds, 20);
  });
});
