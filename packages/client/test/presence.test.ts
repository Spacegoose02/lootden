import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LocalStoreGame } from "@lootden/shared";
import { runningStoreGames, streamingPaths } from "../src/presence.js";
import { missingSunshineApps, moonlightCommand, sunshineAppFor } from "../src/streaming.js";

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


describe("game streaming", () => {
  it("adds games to Sunshine as LootDen play links, once", () => {
    const app = sunshineAppFor({ gameId: "abc", title: "Celeste" }, "C:\\Program Files\\LootDen\\LootDen.exe");
    assert.equal(app.name, "Celeste");
    assert.equal(app.cmd, '"C:\\Program Files\\LootDen\\LootDen.exe" "lootden://play/abc"');
    assert.equal(app["auto-detach"], "true");
    const games = [
      { gameId: "a", title: "Celeste" },
      { gameId: "b", title: "Hades" },
    ];
    assert.deepEqual(missingSunshineApps(games, [{ name: "celeste " }, { name: "Desktop" }]).map((g) => g.gameId), ["b"]);
  });

  it("starts Moonlight on a game, the Flatpak one too", () => {
    assert.deepEqual(moonlightCommand("C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe", "192.168.1.20", "Hades"), {
      cmd: "C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe",
      args: ["stream", "192.168.1.20", "Hades"],
    });
    assert.deepEqual(moonlightCommand("/var/lib/flatpak/app/com.moonlight_stream.Moonlight", "10.0.0.2", "Hades").cmd, "flatpak");
  });
});
