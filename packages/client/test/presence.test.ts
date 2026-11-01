import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LocalStoreGame } from "@lootden/shared";
import { runningStoreGames, streamingPaths } from "../src/presence.js";

const games: LocalStoreGame[] = [
  { addon: "steam", externalId: "620", title: "Portal 2", installDir: "/games/steam/steamapps/common/Portal 2" },
  { addon: "epic", externalId: "fn", title: "Fortnite", installDir: "/games/epic/Fortnite" },
  { addon: "gog", externalId: "1", title: "Broken entry", installDir: "/" },
];

describe("now playing on this PC", () => {
  it("finds other launchers' games by what runs from their folders", () => {
    const since = new Map<string, string>();
    const t0 = new Date("2026-11-01T10:00:00Z");
    const procs = [
      { pid: 10, path: "/games/steam/steamapps/common/Portal 2/portal2_linux" },
      { pid: 11, path: "/usr/bin/bash" },
    ];
    const first = runningStoreGames(procs, games, since, new Set(), "linux", t0);
    assert.deepEqual(first, [{ gameId: "store:steam:620", title: "Portal 2", source: "store", store: "Steam", startedAt: t0.toISOString() }]);

    // Still running a minute later: same start time. Fortnite started too.
    const later = runningStoreGames([...procs, { pid: 12, path: "/games/epic/Fortnite/FortniteClient" }], games, since, new Set(), "linux", new Date("2026-11-01T10:01:00Z"));
    assert.equal(later.find((g) => g.gameId === "store:steam:620")!.startedAt, t0.toISOString());
    assert.equal(later.length, 2);

    // Games LootDen started are left out; stopped games are forgotten.
    assert.deepEqual(runningStoreGames(procs, games, since, new Set(["store:steam:620"]), "linux"), []);
    assert.equal(since.size, 0);
    assert.deepEqual(runningStoreGames([{ pid: 1, path: "/init" }], games, since, new Set(), "linux"), [], "a drive root never matches everything");
  });

  it("knows where Sunshine and Moonlight live", () => {
    const w = streamingPaths("win32", { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" });
    assert.equal(w.sunshine[0], "C:\\Program Files\\Sunshine\\sunshine.exe");
    assert.ok(w.moonlight.includes("C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe"));
    assert.ok(streamingPaths("linux", {}).moonlight.includes("/usr/bin/moonlight-qt"));
  });
});
