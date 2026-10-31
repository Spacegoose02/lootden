import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { packageInfo, versionFromFiles, versionFromName, versionLabel } from "@lootden/shared";
import { tidyName } from "../src/connectors/tidy.js";
import { makeApp } from "./helpers.js";

describe("update and DLC names", () => {
  it("tells updates and DLC from full games", () => {
    assert.deepEqual(packageInfo("Cyberpunk.2077.Update.v2.1-GOG.zip"), { kind: "update", baseTitle: "Cyberpunk 2077", version: "2.1", fromVersion: null });
    assert.deepEqual(packageInfo("Stardew Valley v1.5 to v1.6 Patch.zip"), { kind: "update", baseTitle: "Stardew Valley", version: "1.6", fromVersion: "1.5" });
    assert.equal(packageInfo("Elden Ring Title Update 3").kind, "update");
    assert.equal(packageInfo("Hollow Knight DLC Godmaster").kind, "dlc");
    assert.equal(packageInfo("Hollow Knight DLC Godmaster").baseTitle, "Hollow Knight");
    // Full games that already include their updates, or are just named that way.
    assert.equal(packageInfo("Game incl Update 3").kind, "game");
    assert.equal(packageInfo("The Sims 4 + 5 DLCs").kind, "game");
    assert.equal(packageInfo("Patch Quest").kind, "game");
    assert.equal(packageInfo("Hades v1.38.zip").kind, "game");
    assert.equal(packageInfo("Hades v1.38.zip").version, "1.38");
    // Imports keep saying they're updates, so they aren't taken for the full game.
    assert.equal(tidyName("Cyberpunk.2077.Update.v2.1-GOG"), "Cyberpunk 2077 Update v2.1");
    assert.equal(tidyName("Stardew.Valley.v1.5.to.v1.6.Patch-GROUP.rar"), "Stardew Valley Update v1.5 to v1.6");
    assert.equal(packageInfo(tidyName("Stardew.Valley.v1.5.to.v1.6.Patch-GROUP.rar")).fromVersion, "1.5");
    // Anything in an Updates folder is an update.
    assert.equal(packageInfo("Hades 1.39 files", "update").kind, "update");
  });
});

describe("game versions", () => {
  it("reads versions written without a v", () => {
    assert.equal(packageInfo("Critter Cove Build 15934").version, "Build 15934");
    assert.equal(packageInfo("Critter.Cove.Build.15934-TENOKE").version, "Build 15934");
    assert.equal(packageInfo("Occupy Mars The Game [1.0.2]").version, "1.0.2");
    assert.equal(packageInfo("Occupy Mars The Game (1.2)").version, "1.2");
    assert.equal(packageInfo("Occupy Mars The Game 1.0.2").version, "1.0.2");
    assert.equal(packageInfo("PBA Pro Bowling_2.0.1.3").version, "2.0.1.3");
    // The v form still wins, and a tidied download reads back the same.
    assert.equal(packageInfo("Hades v1.38 [1.0.0]").version, "1.38");
    assert.equal(packageInfo(tidyName("Critter.Cove.Build.15934-TENOKE")).version, "Build 15934");
  });

  it("doesn't take a title's own numbers for a version", () => {
    for (const name of ["EA Sports College Football 26", "Metal Gear Solid 3 Snake Eater", "METAL GEAR SOLID MASTER COLLECTION Vol 2", "Fallout 3.5", "Build 1000 Houses", "The.Sims.4.1.0.2", "Game (2024)"]) {
      assert.equal(packageInfo(name).version, null, name);
    }
  });

  it("finds a version inside a folder whose name doesn't say", () => {
    assert.equal(versionFromFiles([{ path: "setup_critter_cove_1.2.3_(64bit)_(78123).exe" }, { path: "setup_critter_cove_1.2.3_(64bit)_(78123)-1.bin" }]), "1.2.3");
    assert.equal(versionFromFiles([{ path: "Occupy Mars v1.0.2/OccupyMars.exe" }, { path: "Occupy Mars v1.0.2/data.pak" }]), "1.0.2");
    assert.equal(versionFromFiles([{ path: "PBA.Pro.Bowling.v2.1.iso" }, { path: "readme.txt" }]), "2.1");
    // Redistributables carry their own versions, which aren't the game's.
    assert.equal(versionFromFiles([{ path: "Game.exe" }, { path: "_CommonRedist/PhysX-9.13.0604-SystemSoftware.msi" }, { path: "DirectX/Jun2010/DXSETUP.exe" }]), null);
    assert.equal(versionFromName("Critter Cove"), null);
    assert.equal(versionLabel("1.2"), "v1.2");
    assert.equal(versionLabel("Build 15934"), "Build 15934");
  });
});

describe("game versions in the library", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "lootden-versions-"));
    await mkdir(path.join(root, "Critter Cove"));
    await writeFile(path.join(root, "Critter Cove", "setup_critter_cove_1.2.3_(64bit)_(78123).exe"), "x");
    await mkdir(path.join(root, "Occupy Mars The Game"));
    await writeFile(path.join(root, "Occupy Mars The Game", "OccupyMars.exe"), "x");
  });
  after(() => rm(root, { recursive: true, force: true }));

  it("shows a version found inside the folder, and one an admin types in", async () => {
    const { ctx, app } = await makeApp(root, { apiToken: "svc" });
    const auth = { authorization: "Bearer svc" };
    await ctx.library.rescan();
    const games = (await app.inject({ url: "/api/games", headers: auth })).json() as Array<{ id: string; title: string; version: string | null; latestVersion: string | null }>;
    const critter = games.find((g) => g.title === "Critter Cove")!;
    assert.deepEqual([critter.version, critter.latestVersion], ["1.2.3", "1.2.3"]);
    const mars = games.find((g) => g.title === "Occupy Mars The Game")!;
    assert.equal(mars.version, null);

    const set = await app.inject({ method: "PATCH", url: `/api/games/${mars.id}`, headers: auth, payload: { version: " v1.0.2 " } });
    assert.equal(set.statusCode, 200);
    const detail = set.json() as { version: string | null; latestVersion: string | null; overrides: { version: string | null } };
    assert.deepEqual([detail.version, detail.latestVersion, detail.overrides.version], ["1.0.2", "1.0.2", "1.0.2"]);
    const listed = (await app.inject({ url: "/api/games", headers: auth })).json() as Array<{ id: string; version: string | null }>;
    assert.equal(listed.find((g) => g.id === mars.id)!.version, "1.0.2");

    const reset = (await app.inject({ method: "PATCH", url: `/api/games/${mars.id}`, headers: auth, payload: { version: "" } })).json() as { version: string | null; overrides: { version: string | null } };
    assert.deepEqual([reset.version, reset.overrides.version], [null, null]);
    await app.close();
  });
});

describe("update packages in the library", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "lootden-updates-"));
    await mkdir(path.join(root, "Cyberpunk 2077"));
    await writeFile(path.join(root, "Cyberpunk 2077", "Cyberpunk2077.exe"), "x".repeat(1000));
    await writeFile(path.join(root, "Cyberpunk.2077.Update.v2.1-GOG.zip"), "zip");
    await writeFile(path.join(root, "Stardew Valley v1.5.zip"), "x".repeat(1000));
    // Called an update, but as big as the game: the full game (the Cyberpunk bug).
    await writeFile(path.join(root, "Cyberpunk.2077.v2.2.Update-GOG.zip"), "x".repeat(950));
    // Named and sized like a patch, with a patch program in it.
    await mkdir(path.join(root, "Updates", "Cyberpunk 2077 Hotfix v2.21"), { recursive: true });
    await writeFile(path.join(root, "Updates", "Cyberpunk 2077 Hotfix v2.21", "patch_cyberpunk_2.21.exe"), "x".repeat(50));
    // A full installer dropped in the Updates folder.
    await mkdir(path.join(root, "Updates", "Stardew Valley v1.6.9"), { recursive: true });
    await writeFile(path.join(root, "Updates", "Stardew Valley v1.6.9", "setup_stardew_valley_1.6.9_(123).exe"), "x".repeat(40));
    await writeFile(path.join(root, "Updates", "Stardew Valley v1.6.9", "setup_stardew_valley_1.6.9_(123)-1.bin"), "x".repeat(40));
    await mkdir(path.join(root, "Updates"), { recursive: true });
    await writeFile(path.join(root, "Updates", "Stardew Valley v1.5 to v1.6 Patch.zip"), "zip");
    await writeFile(path.join(root, "Updates", "patch_stardew_valley_1.6.1.exe"), "exe");
    await mkdir(path.join(root, "DLC"));
    await writeFile(path.join(root, "DLC", "Hollow Knight Godmaster.zip"), "zip");
  });
  after(() => rm(root, { recursive: true, force: true }));

  it("keeps updates out of the library, lists them on their own and matches them to their game", async () => {
    const { ctx, app } = await makeApp(root, { apiToken: "svc" });
    const auth = { authorization: "Bearer svc" };
    await ctx.library.rescan();

    const games = (await app.inject({ url: "/api/games", headers: auth })).json() as Array<{ title: string; kind: string }>;
    const shown = games.map((g) => g.title).sort();
    assert.deepEqual(shown, ["Cyberpunk 2077", "Cyberpunk 2077 v2.2", "Stardew Valley v1 5", "Stardew Valley v1.6.9"]);
    const full = (await app.inject({ url: "/api/games", headers: auth })).json() as Array<{ id: string; title: string; kind: string; baseGameId: string | null; kindReason: { by: string; confidence: string; note: string } | null }>;
    const bySize = full.find((g) => g.title === "Cyberpunk 2077 v2.2")!;
    assert.equal(bySize.kindReason?.by, "size", "as big as the game, so it's the full game");
    assert.equal(bySize.kindReason?.confidence, "high");
    assert.match(bySize.kindReason!.note, /95% of Cyberpunk 2077/);
    assert.equal(full.find((g) => g.title === "Stardew Valley v1.6.9")!.kindReason?.by, "content", "a full installer in Updates is a game");
    assert.equal(full.find((g) => g.title === "Cyberpunk 2077")!.kindReason, null);

    const addons = (await app.inject({ url: "/api/games?kind=addon", headers: auth })).json() as Array<{ id: string; title: string; kind: string; baseGameId: string | null; version: string | null; fromVersion: string | null }>;
    const byTitle = new Map(addons.map((a) => [a.title, a]));
    const cyberpunk = games.find((g) => g.title === "Cyberpunk 2077") as unknown as { id: string };
    const stardew = games.find((g) => g.title === "Stardew Valley v1 5") as unknown as { id: string };
    assert.equal(byTitle.get("Cyberpunk 2077 Update v2.1")?.baseGameId, cyberpunk.id);
    // Covers say whether an update is waiting: the newest version among the game and its updates.
    const latest = new Map((full as unknown as Array<{ title: string; version: string | null; latestVersion: string | null }>).map((g) => [g.title, g]));
    assert.equal(latest.get("Cyberpunk 2077")!.latestVersion, "2.21");
    assert.equal(latest.get("Stardew Valley v1 5")!.version, "1.5");
    assert.match(latest.get("Stardew Valley v1 5")!.latestVersion ?? "", /^1\.6/);
    assert.equal(latest.get("Stardew Valley v1.6.9")!.latestVersion, "1.6.9", "no updates: its own version");
    assert.equal(byTitle.get("Stardew Valley v1.5 to v1.6 Patch")?.baseGameId, stardew.id);
    assert.equal(byTitle.get("Stardew Valley v1.5 to v1.6 Patch")?.fromVersion, "1.5");
    assert.equal(byTitle.get("Stardew Valley v1.5 to v1.6 Patch")?.version, "1.6");
    assert.equal(byTitle.get("patch stardew valley 1.6.1")?.kind, "update", "a loose setup program in Updates counts");
    const dlc = byTitle.get("Hollow Knight Godmaster")!;
    assert.equal(dlc.kind, "dlc");
    assert.equal(dlc.baseGameId, null, "no Hollow Knight on the server: DLC only");
    const hotfix = byTitle.get("Cyberpunk 2077 Hotfix v2.21") as unknown as { kind: string; baseGameId: string; kindReason: { by: string; confidence: string } };
    assert.deepEqual([hotfix.kind, hotfix.baseGameId, hotfix.kindReason.by, hotfix.kindReason.confidence], ["update", cyberpunk.id, "content", "high"]);
    assert.equal((byTitle.get("Cyberpunk 2077 Update v2.1") as unknown as { kindReason: { by: string } }).kindReason.by, "name");

    // The game page lists its updates; the update page names its game.
    const detail = (await app.inject({ url: `/api/games/${stardew.id}`, headers: auth })).json() as { addons: Array<{ title: string }> };
    assert.ok(detail.addons.some((a) => a.title === "Stardew Valley v1.5 to v1.6 Patch"));
    const patch = byTitle.get("Stardew Valley v1.5 to v1.6 Patch")!;
    const patchDetail = (await app.inject({ url: `/api/games/${patch.id}`, headers: auth })).json() as { baseGame: { id: string } | null; needsSetup: unknown };
    assert.equal(patchDetail.baseGame?.id, stardew.id);

    // An admin can fix a wrong match, and turn a misread entry back into a game.
    const fixed = await app.inject({ method: "PUT", url: `/api/games/${dlc.id}/package`, headers: auth, payload: { baseGameId: cyberpunk.id } });
    assert.equal(fixed.statusCode, 200);
    assert.equal((fixed.json() as { baseGameId: string }).baseGameId, cyberpunk.id);
    // ...and say a full-size package really is an update.
    const asUpdate = (await app.inject({ method: "PUT", url: `/api/games/${bySize.id}/package`, headers: auth, payload: { kind: "update" } })).json() as { kind: string; baseGameId: string; kindReason: { by: string } };
    assert.deepEqual([asUpdate.kind, asUpdate.baseGameId, asUpdate.kindReason.by], ["update", cyberpunk.id, "admin"]);
    const asGame = await app.inject({ method: "PUT", url: `/api/games/${dlc.id}/package`, headers: auth, payload: { kind: "game" } });
    assert.equal((asGame.json() as { kind: string }).kind, "game");
    const after = (await app.inject({ url: "/api/games", headers: auth })).json() as Array<{ title: string }>;
    assert.ok(after.some((g) => g.title === "Hollow Knight Godmaster"));
    const bad = await app.inject({ method: "PUT", url: `/api/games/${patch.id}/package`, headers: auth, payload: { baseGameId: "nope" } });
    assert.equal(bad.statusCode, 400);
    await app.close();
  });
});
