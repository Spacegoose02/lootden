import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { cleanLimits, computeAllowance, type Allowance } from "@lootden/shared";
import { offlineAllowance, watchPlayTime } from "../src/playtime.js";
import { switchSaveSlot } from "../src/saveslots.js";

/** A clock and timer the test moves by hand. */
function fakeClock(start = Date.parse("2026-10-28T17:00:00Z")) {
  let t = start;
  let fn: (() => void) | null = null;
  return {
    now: () => t,
    setInterval: (f: () => void) => ((fn = f), 1),
    clearInterval: () => (fn = null),
    advance: async (seconds: number, step = 20) => {
      for (let s = 0; s < seconds; s += step) {
        t += step * 1000;
        fn?.();
        await Promise.resolve();
      }
    },
  };
}

const limits = cleanLimits({ weekdayMinutes: 60, hardStop: true });
const at = (used: number, bonus = 0, now = new Date("2026-10-28T17:00:00Z")) => computeAllowance(limits, used, bonus, now, "UTC");

describe("play time watcher", () => {
  it("warns at 10, 5 and 1 minute, then closes the game a minute after time's up", async () => {
    const clock = fakeClock();
    const events: string[] = [];
    const stop = watchPlayTime({
      allowance: at(45 * 60),
      refresh: async () => null,
      onWarn: (m) => events.push(`warn ${m}`),
      onTimeUp: (grace) => events.push(`up ${grace}`),
      onStop: () => events.push("stop"),
      ...clock,
    });
    await clock.advance(15 * 60);
    assert.deepEqual(events, ["warn 10", "warn 5", "warn 1", "up 60"]);
    await clock.advance(60);
    assert.deepEqual(events.slice(4), ["stop"]);
    stop();
  });

  it("starts over when bonus time arrives mid-game, and only warns without a hard stop", async () => {
    const clock = fakeClock();
    const events: string[] = [];
    let answer: Allowance | null = null;
    watchPlayTime({
      allowance: { ...at(55 * 60), hardStop: false },
      refresh: async () => answer,
      onWarn: (m) => events.push(`warn ${m}`),
      onTimeUp: (grace) => events.push(`up ${grace}`),
      onStop: () => events.push("stop"),
      refreshSeconds: 60,
      ...clock,
    });
    assert.deepEqual(events, ["warn 5"]);
    // 30 bonus minutes are granted (the server still counts 55 minutes: the session runs on).
    answer = { ...at(55 * 60, 30 * 60), hardStop: false };
    await clock.advance(120);
    assert.deepEqual(events, ["warn 5"], "about 33 minutes left now");
    await clock.advance(25 * 60);
    assert.deepEqual(events, ["warn 5", "warn 10"]);
    await clock.advance(10 * 60);
    assert.deepEqual(events.filter((e) => e.startsWith("up")), ["up null"]);
    assert.ok(!events.includes("stop"));
  });

  it("closes the game at bedtime even after asking the server again", async () => {
    const clock = fakeClock(Date.parse("2026-10-28T20:50:00Z"));
    const bedtime = cleanLimits({ bedtime: { from: "21:00", to: "07:00" }, hardStop: true });
    const now = () => computeAllowance(bedtime, 0, 0, new Date(clock.now()), "UTC");
    const events: string[] = [];
    const stop = watchPlayTime({
      allowance: now(),
      refresh: async () => now(),
      onWarn: (m) => events.push(`warn ${m}`),
      onTimeUp: (grace) => events.push(`up ${grace}`),
      onStop: () => events.push("stop"),
      ...clock,
    });
    await clock.advance(15 * 60);
    assert.deepEqual(events, ["warn 10", "warn 5", "warn 1", "up 60", "stop"]);
    stop();
  });

  it("works out today's time offline from the last answer and play since", () => {
    const kept = { allowance: at(30 * 60), limits, at: "2026-10-28T17:00:00.000Z" };
    const pending = [
      { seconds: 600, playedAt: "2026-10-28T17:30:00.000Z" },
      { seconds: 900, playedAt: "2026-10-28T16:00:00.000Z" },
    ];
    assert.equal(offlineAllowance(kept, pending, new Date("2026-10-28T18:00:00Z")).remainingSeconds, 20 * 60, "play before the answer is already in it");
    assert.equal(offlineAllowance(kept, pending, new Date("2026-10-29T10:00:00Z")).remainingSeconds, 60 * 60, "a new day starts over");
  });
});

describe("save slots per profile", () => {
  it("puts the last player's saves aside and brings this player's back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gm-slots-"));
    try {
      const saveDir = path.join(root, "AppData", "Game");
      const slotsDir = path.join(root, "SaveSlots");
      await mkdir(saveDir, { recursive: true });
      await writeFile(path.join(saveDir, "save1.dat"), "sam's castle");
      const base = { saveDir, slotsDir, gameId: "g1" };

      assert.equal(await switchSaveSlot({ ...base, userId: 1, owner: null }), "same", "nobody's saves yet: nothing moves");
      assert.equal(await switchSaveSlot({ ...base, userId: 1, owner: 1 }), "same");

      // Ana plays next: Sam's saves go to his slot, Ana gets hers from the server.
      let restored = false;
      const r = await switchSaveSlot({
        ...base,
        userId: 2,
        owner: 1,
        restoreFromServer: async () => {
          await mkdir(saveDir, { recursive: true });
          await writeFile(path.join(saveDir, "save1.dat"), "ana's farm");
          return (restored = true);
        },
      });
      assert.equal(r, "restored");
      assert.ok(restored);
      assert.equal(await readFile(path.join(slotsDir, "g1", "1", "save1.dat"), "utf8"), "sam's castle");

      // Sam again: his castle comes back, Ana's farm waits in her slot.
      assert.equal(await switchSaveSlot({ ...base, userId: 1, owner: 2 }), "swapped");
      assert.equal(await readFile(path.join(saveDir, "save1.dat"), "utf8"), "sam's castle");
      assert.equal(await readFile(path.join(slotsDir, "g1", "2", "save1.dat"), "utf8"), "ana's farm");

      // A third profile with nothing anywhere starts fresh; Sam's slot is replaced, the old one kept.
      await mkdir(path.join(slotsDir, "g1", "1"), { recursive: true });
      await writeFile(path.join(slotsDir, "g1", "1", "stale.dat"), "older");
      assert.equal(await switchSaveSlot({ ...base, userId: 3, owner: 1 }), "fresh");
      assert.deepEqual((await readdir(path.join(slotsDir, "g1"))).sort(), ["1", "1.old", "2"]);
      assert.equal(await readFile(path.join(slotsDir, "g1", "1.old", "stale.dat"), "utf8"), "older");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
