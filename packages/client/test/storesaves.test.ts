import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fillTemplate, findStoreSaves, globPaths, matchesPattern } from "../src/storesaves.js";
import { amazonFromUninstall, battlenetFromUninstall, resolveLauncherLink, riotClientPath, riotFromSettings, rockstarFromUninstall } from "../src/stores/launchers.js";

let home: string;
before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "gm-ssave-test-"));
  await mkdir(path.join(home, "AppData", "Roaming", "StardewValley", "Saves", "Farm_1"), { recursive: true });
  await writeFile(path.join(home, "AppData", "Roaming", "StardewValley", "Saves", "Farm_1", "Farm_1"), "farm");
  await mkdir(path.join(home, "LocalLow", "Team Cherry", "Hollow Knight"), { recursive: true });
  for (const f of ["user1.dat", "user2.dat", "shader.cache"]) await writeFile(path.join(home, "LocalLow", "Team Cherry", "Hollow Knight", f), f);
  await mkdir(path.join(home, "Game", "saves"), { recursive: true });
  await writeFile(path.join(home, "Game", "saves", "slot1.sav"), "s");
});
after(() => rm(home, { recursive: true, force: true }));

const env = (name: string) => ({ APPDATA: path.join(home, "AppData", "Roaming"), USERPROFILE: home }[name.toUpperCase()]);

describe("store game saves through Ludusavi's list", () => {
  it("fills placeholders and skips what can't apply", () => {
    assert.equal(fillTemplate("%APPDATA%/StardewValley/Saves", null, env), `${path.join(home, "AppData", "Roaming")}/StardewValley/Saves`);
    assert.equal(fillTemplate("{game}/saves", null, env), null, "not installed here");
    assert.equal(fillTemplate("%NOPE%/x", "/g", env), null);
  });

  it("finds folders and wildcard files, without copying a folder twice", async () => {
    const found = await globPaths(path.join(home, "LocalLow", "Team Cherry", "Hollow Knight", "*.dat"));
    assert.deepEqual(found.map((f) => path.basename(f)).sort(), ["user1.dat", "user2.dat"]);
    const saves = await findStoreSaves(
      [
        { template: "%APPDATA%/StardewValley/Saves", tags: ["save"] },
        { template: "%APPDATA%/StardewValley/Saves/Farm_1", tags: ["save"] },
        { template: "{game}/saves/*.sav", tags: ["save"] },
        { template: "%APPDATA%/Missing", tags: [] },
      ],
      path.join(home, "Game"),
      env,
    );
    // The Farm_1 folder is inside Saves, so only Saves is kept.
    assert.deepEqual(saves.map((s) => path.basename(s.path)).sort(), ["Saves", "slot1.sav"]);
  });

  it("only lets a backup restore into the game's own save places", () => {
    const p = path.join(home, "AppData", "Roaming", "Rockstar", "Profiles", "*");
    assert.equal(matchesPattern(p, path.join(home, "AppData", "Roaming", "Rockstar", "Profiles", "ABC123")), true);
    assert.equal(matchesPattern(p, path.join(home, "AppData", "Roaming", "Rockstar", "Profiles", "ABC123", "..", "..", "..", "Startup")), false);
    assert.equal(matchesPattern(p, path.join(home, "Desktop", "evil.exe")), false);
    assert.equal(matchesPattern(path.join(home, "a", "**", "*.sav"), path.join(home, "a", "b", "c", "x.sav")), true);
  });
});

describe("Amazon, Battle.net, Rockstar and Riot on the PC", () => {
  const keys = new Map<string, Record<string, string>>([
    ["HKCU\\...\\Uninstall\\AmazonGames/Foo", { DisplayName: "Fallout 3™", InstallLocation: "C:\\Amazon Games\\Library\\Fallout 3\\", UninstallString: '"C:\\Users\\me\\AppData\\Local\\Amazon Games\\App\\Amazon Game Remover.exe" -m Game -p amzn1.adg.product.1234-abcd' }],
    ["HKLM\\...\\Uninstall\\Diablo IV", { DisplayName: "Diablo IV", InstallLocation: "C:\\Program Files (x86)\\Diablo IV", UninstallString: '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=fenris --displayname="Diablo IV"' }],
    ["HKLM\\...\\Uninstall\\Grand Theft Auto V", { DisplayName: "Grand Theft Auto V", InstallLocation: "D:\\Rockstar\\GTAV", UninstallString: '"C:\\Program Files\\Rockstar Games\\Launcher\\uninstall.exe" -uninstall=gta5' }],
    ["HKLM\\...\\Uninstall\\Notepad++", { DisplayName: "Notepad++", InstallLocation: "C:\\npp", UninstallString: "C:\\npp\\uninstall.exe" }],
  ]);

  it("reads Windows' installed programs for each launcher", () => {
    assert.deepEqual(amazonFromUninstall(keys), [{ addon: "amazon", store: "Amazon Games", externalId: "amzn1.adg.product.1234-abcd", title: "Fallout 3", installDir: "C:\\Amazon Games\\Library\\Fallout 3", launchUrl: "amazon-games://play/amzn1.adg.product.1234-abcd" }]);
    const bn = battlenetFromUninstall(keys);
    assert.equal(bn.length, 1);
    assert.equal(bn[0]!.launchUrl, "battlenet://Fen");
    const rs = rockstarFromUninstall(keys);
    assert.deepEqual(rs.map((g) => [g.externalId, g.launchUrl, g.installDir]), [["gta5", "lootden-launcher://rockstar/gta5", "D:\\Rockstar\\GTAV"]]);
  });

  it("reads Riot's product settings and finds the Riot Client", () => {
    const g = riotFromSettings("valorant", 'product_install_full_path: "C:/Riot Games/VALORANT/live"\nproduct_install_root: "C:/Riot Games"\n');
    assert.equal(g?.title, "VALORANT");
    assert.equal(g?.launchUrl, "lootden-launcher://riot/valorant");
    assert.equal(riotFromSettings("riot_client", "product_install_full_path: x"), null);
    assert.equal(riotClientPath('{"rc_default":"C:/Riot Games/Riot Client/RiotClientServices.exe"}'), "C:/Riot Games/Riot Client/RiotClientServices.exe");
    assert.equal(riotClientPath("nope"), null);
  });

  it("only turns its own short links into commands", async () => {
    assert.equal(await resolveLauncherLink("steam://rungameid/1"), null);
    assert.equal(await resolveLauncherLink("lootden-launcher://riot/../../evil"), null);
    assert.equal(await resolveLauncherLink("lootden-launcher://other/x"), null);
  });
});
