import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { scanStoreGames, type StoreScanner } from "../src/stores/index.js";
import { epicFromHeroic, epicFromManifest } from "../src/stores/epic.js";
import { gogFromHeroic, gogFromRegistry } from "../src/stores/gog.js";
import { steamInstalled, steamLibraries, steamLibraryCover } from "../src/stores/steam.js";
import { parseRegQuery } from "../src/stores/windows.js";
import { ubisoftFromRegistry, ubisoftNames } from "../src/stores/ubisoft.js";
import { scanFolder } from "../src/stores/folders.js";
import { eaFromInstallerData, eaInstallDirs, eaLibraryDirs } from "../src/stores/ea.js";
import { gamingRootFolders, xboxFromConfig } from "../src/stores/xbox.js";
import { parseVdf } from "../src/stores/vdf.js";

let work: string;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "gm-stores-"));
});
after(() => rm(work, { recursive: true, force: true }));

const acf = (appid: string, name: string, flags = "4") => `"AppState"\n{\n\t"appid"\t\t"${appid}"\n\t"name"\t\t"${name}"\n\t"StateFlags"\t\t"${flags}"\n\t"installdir"\t\t"${name}"\n}\n`;

describe("store scanners", () => {
  it("parses Valve's KeyValues files", () => {
    const doc = parseVdf(`// comment\n"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t\t"apps"\n\t\t{\n\t\t\t"620"\t\t"123"\n\t\t}\n\t}\n}`);
    assert.deepEqual(doc, { libraryfolders: { "0": { path: "C:\\Program Files (x86)\\Steam", apps: { "620": "123" } } } });
  });

  it("finds installed Steam games across library folders", async () => {
    const root = path.join(work, "Steam");
    const second = path.join(work, "SteamLibrary");
    await mkdir(path.join(root, "steamapps"), { recursive: true });
    await mkdir(path.join(second, "steamapps"), { recursive: true });
    await writeFile(path.join(root, "steamapps", "libraryfolders.vdf"), `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${root.replace(/\\/g, "\\\\")}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${second.replace(/\\/g, "\\\\")}"\n\t}\n}\n`);
    await writeFile(path.join(root, "steamapps", "appmanifest_620.acf"), acf("620", "Portal 2"));
    await writeFile(path.join(root, "steamapps", "appmanifest_1493710.acf"), acf("1493710", "Proton Experimental"));
    await writeFile(path.join(second, "steamapps", "appmanifest_1145360.acf"), acf("1145360", "Hades"));
    await writeFile(path.join(second, "steamapps", "appmanifest_570.acf"), acf("570", "Dota 2", "1026"));

    const libs = await steamLibraries(root);
    assert.deepEqual(libs.sort(), [root, second].sort());
    const games = (await Promise.all(libs.map(steamInstalled))).flat();
    assert.deepEqual(games.map((g) => [g.externalId, g.title]).sort(), [["1145360", "Hades"], ["620", "Portal 2"]], "skips Proton and games still downloading");
    assert.equal(games.find((g) => g.externalId === "620")!.installDir, path.join(root, "steamapps", "common", "Portal 2"));
  });

  it("finds Steam's own cached covers, old and new layouts", async () => {
    const root = path.join(work, "SteamArt");
    const cache = path.join(root, "appcache", "librarycache");
    await mkdir(path.join(cache, "620"), { recursive: true });
    await mkdir(path.join(cache, "1145360", "a1b2c3"), { recursive: true });
    await writeFile(path.join(cache, "570_library_600x900.jpg"), "jpg");
    await writeFile(path.join(cache, "620", "header.jpg"), "jpg");
    await writeFile(path.join(cache, "620", "library_600x900.jpg"), "jpg");
    await writeFile(path.join(cache, "1145360", "a1b2c3", "library_600x900.jpg"), "jpg");
    await writeFile(path.join(cache, "400_library_600x900.jpg"), "");
    assert.equal(await steamLibraryCover("570", [root]), path.join(cache, "570_library_600x900.jpg"));
    assert.equal(await steamLibraryCover("620", [root]), path.join(cache, "620", "library_600x900.jpg"), "the portrait cover before the wide header");
    assert.equal(await steamLibraryCover("1145360", [root]), path.join(cache, "1145360", "a1b2c3", "library_600x900.jpg"));
    assert.equal(await steamLibraryCover("400", [root]), null, "empty files don't count");
    assert.equal(await steamLibraryCover("../620", [root]), null);
  });

  it("runs the scanners for this platform and ignores ones that fail", async () => {
    const ok: StoreScanner = { addon: "a", name: "A", platforms: ["linux", "win32"], scan: async () => [{ addon: "a", externalId: "1", title: "One", installDir: "/x" }] };
    const broken: StoreScanner = { addon: "b", name: "B", platforms: ["linux", "win32"], scan: async () => { throw new Error("no launcher"); } };
    const elsewhere: StoreScanner = { addon: "c", name: "C", platforms: ["darwin"], scan: async () => [{ addon: "c", externalId: "2", title: "Two", installDir: "/y" }] };
    assert.deepEqual((await scanStoreGames([ok, broken, elsewhere], "linux")).map((g) => g.title), ["One"]);
  });

  it("finds GOG games from Galaxy's registry keys and Heroic", () => {
    const reg = [
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658924",
      "    gameID    REG_SZ    1207658924",
      "    gameName    REG_SZ    Unreal Tournament 2004",
      "    path    REG_SZ    C:\\GOG Games\\UT2004",
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658924\\Extra",
      "    other    REG_DWORD    0x1",
      "",
    ].join("\r\n");
    assert.deepEqual(gogFromRegistry(parseRegQuery(reg)), [{ addon: "gog", store: "GOG", externalId: "1207658924", title: "Unreal Tournament 2004", installDir: "C:\\GOG Games\\UT2004", launchUrl: "goggalaxy://openGameView/1207658924" }]);
    const heroic = JSON.stringify({ installed: [{ appName: "1423049311", install_path: "/home/me/Games/Heroic/Cyberpunk 2077", platform: "windows" }, { appName: "x" }] });
    assert.deepEqual(gogFromHeroic(heroic), [
      { addon: "gog", store: "GOG", externalId: "1423049311", title: "Cyberpunk 2077", installDir: "/home/me/Games/Heroic/Cyberpunk 2077", launchUrl: "heroic://launch?appName=1423049311&runner=gog" },
    ]);
  });

  it("finds Epic games from the launcher's manifests and Heroic", () => {
    const item = (patch: object) => JSON.stringify({ AppName: "Fortnite", DisplayName: "Fortnite", InstallLocation: "C:\\Epic Games\\Fortnite", bIsIncompleteInstall: false, ...patch });
    assert.deepEqual(epicFromManifest(item({})), { addon: "epic", store: "Epic Games", externalId: "Fortnite", title: "Fortnite", installDir: "C:\\Epic Games\\Fortnite" });
    assert.equal(epicFromManifest(item({ bIsIncompleteInstall: true })), null, "still downloading");
    assert.equal(epicFromManifest(item({ AppName: "dlc1", MainGameAppName: "Fortnite" })), null, "DLC");
    const heroic = JSON.stringify({ Sugar: { app_name: "Sugar", title: "Hades", install_path: "/games/Hades" }, Dlc: { app_name: "Dlc", install_path: "/games/x", is_dlc: true } });
    assert.deepEqual(epicFromHeroic(heroic), [{ addon: "epic", store: "Epic Games", externalId: "Sugar", title: "Hades", installDir: "/games/Hades", launchUrl: "heroic://launch?appName=Sugar&runner=legendary" }]);
  });

  it("reads the Xbox app's game folders and MicrosoftGame.config", () => {
    const names = Buffer.from("XboxGames\0Other Games\0", "utf16le");
    const header = Buffer.alloc(8);
    header.write("RGBX", 0, "latin1");
    header.writeUInt32LE(1, 4);
    assert.deepEqual(gamingRootFolders(Buffer.concat([header, names])), ["XboxGames", "Other Games"]);
    assert.deepEqual(gamingRootFolders(Buffer.from("junk")), []);
    const xml = `<?xml version="1.0"?><Game configVersion="1"><Identity Name="Microsoft.Starfield" Publisher="CN=x"/><StoreId>9NCJSXWZTP88</StoreId><TitleId>4ED3C6F2</TitleId><ShellVisuals DefaultDisplayName="Starfield &amp; Friends"/></Game>`;
    assert.deepEqual(xboxFromConfig(xml, "D:\\XboxGames\\Starfield"), {
      addon: "xbox",
      store: "Xbox",
      externalId: String(0x4ed3c6f2),
      title: "Starfield & Friends",
      installDir: "D:\\XboxGames\\Starfield",
      launchUrl: "msxbox://game/?productId=9NCJSXWZTP88",
    });
    assert.equal(xboxFromConfig("<Game/>", "x"), null);
  });

  it("finds Ubisoft Connect games and gives Epic manifests a launcher link", () => {
    const reg = "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\635\r\n    InstallDir    REG_SZ    C:/Games/Assassin's Creed Origins/\r\n";
    assert.deepEqual(ubisoftFromRegistry(parseRegQuery(reg)), [
      { addon: "ubisoft", store: "Ubisoft Connect", externalId: "635", title: "Assassin's Creed Origins", installDir: "C:/Games/Assassin's Creed Origins", launchUrl: "uplay://launch/635/0" },
    ]);
    const m = epicFromManifest(JSON.stringify({ AppName: "Sugar", DisplayName: "Hades", InstallLocation: "C:\\Hades", CatalogNamespace: "min", CatalogItemId: "abc" }));
    assert.equal(m!.launchUrl, "com.epicgames.launcher://apps/min%3Aabc%3ASugar?action=launch&silent=true");
  });

  it("names Ubisoft games from the installed-programs list instead of their folders", () => {
    const installs = parseRegQuery("HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\5266\r\n    InstallDir    REG_SZ    D:/Ubisoft/FarCry6/\r\n");
    const names = ubisoftNames(parseRegQuery("HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Uplay Install 5266\r\n    DisplayName    REG_SZ    Far Cry 6\r\n"));
    assert.equal(ubisoftFromRegistry(installs, names)[0]!.title, "Far Cry 6");
    assert.equal(ubisoftFromRegistry(installs)[0]!.title, "FarCry6", "the folder when Windows doesn't list it");
  });

  it("finds EA app games from their installer data and Windows' installed programs", () => {
    const xml = `<?xml version="1.0"?><DiPManifest version="4.0"><contentIDs><contentID>1035052</contentID><contentID>Origin.OFR.50.0002694</contentID></contentIDs>
      <gameTitles><gameTitle locale="de_DE">Schlacht</gameTitle><gameTitle locale="en_US">Battlefield™ 2042 &amp; More</gameTitle></gameTitles></DiPManifest>`;
    assert.deepEqual(eaFromInstallerData(xml, "C:\\Program Files\\EA Games\\Battlefield 2042"), {
      addon: "ea",
      store: "EA app",
      externalId: "Origin.OFR.50.0002694",
      title: "Battlefield 2042 & More",
      installDir: "C:\\Program Files\\EA Games\\Battlefield 2042",
      launchUrl: "origin2://game/launch?offerIds=Origin.OFR.50.0002694&autoDownload=1",
    });
    const older = eaFromInstallerData("<game><metadata><localeInfo locale=\"en_US\"><title>Mass Effect</title></localeInfo></metadata><contentIDs><contentID>71150</contentID></contentIDs></game>", "D:\\ME");
    assert.equal(older!.title, "Mass Effect");
    assert.equal(older!.externalId, "71150");
    assert.equal(eaFromInstallerData("<DiPManifest/>", "x"), null);

    const reg = parseRegQuery(
      [
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{1234}",
        "    DisplayName    REG_SZ    Battlefield 2042",
        '    InstallLocation    REG_SZ    "D:\\EA\\Battlefield 2042\\"',
        '    UninstallString    REG_SZ    "C:\\Program Files\\Common Files\\EAInstaller\\Battlefield 2042\\Cleanup.exe" uninstall_game -autologging',
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other",
        "    DisplayName    REG_SZ    Not a game",
        "    InstallLocation    REG_SZ    C:\\Other",
        "    UninstallString    REG_SZ    C:\\Other\\uninstall.exe",
        "",
      ].join("\r\n"),
    );
    assert.deepEqual(eaInstallDirs(reg), [{ dir: "D:\\EA\\Battlefield 2042", name: "Battlefield 2042" }]);
    assert.deepEqual(eaLibraryDirs("user.locale=en_US\r\nuser.downloadinplacedir=E:\\EA Games\\\r\n"), ["E:\\EA Games"]);
  });

  it("finds store games in a folder picked on this PC", async () => {
    const picked = path.join(work, "Picked");
    await mkdir(path.join(picked, "steamapps"), { recursive: true });
    await writeFile(path.join(picked, "steamapps", "appmanifest_620.acf"), acf("620", "Portal 2"));
    await mkdir(path.join(picked, "Witcher 3"), { recursive: true });
    await writeFile(path.join(picked, "Witcher 3", "goggame-1207664663.info"), JSON.stringify({ gameId: "1207664663", name: "The Witcher 3: Wild Hunt" }));
    await mkdir(path.join(picked, "Hades", ".egstore"), { recursive: true });
    await writeFile(path.join(picked, "Hades", ".egstore", "X.mancpn"), JSON.stringify({ AppName: "Sugar", CatalogNamespace: "min", CatalogItemId: "abc" }));
    await mkdir(path.join(picked, "Halo", "Content"), { recursive: true });
    await writeFile(path.join(picked, "Halo", "Content", "MicrosoftGame.config"), '<Game><Identity Name="Halo"/><TitleId>1A2B</TitleId><ShellVisuals DefaultDisplayName="Halo Infinite"/></Game>');
    await mkdir(path.join(picked, "Sims 4", "__Installer"), { recursive: true });
    await writeFile(path.join(picked, "Sims 4", "__Installer", "installerdata.xml"), '<DiPManifest><contentIDs><contentID>Origin.OFR.50.0000500</contentID></contentIDs><gameTitles><gameTitle locale="en_US">The Sims™ 4</gameTitle></gameTitles></DiPManifest>');
    await mkdir(path.join(picked, "Just a folder"), { recursive: true });

    const found = (await scanFolder(picked)).map((g) => [g.addon, g.externalId, g.title]).sort();
    assert.deepEqual(found, [
      ["ea", "Origin.OFR.50.0000500", "The Sims 4"],
      ["epic", "Sugar", "Hades"],
      ["gog", "1207664663", "The Witcher 3: Wild Hunt"],
      ["steam", "620", "Portal 2"],
      ["xbox", String(0x1a2b), "Halo Infinite"],
    ]);

    // Per PC: stores switched off are skipped, picked folders are added, and nothing is listed twice.
    const steamHere: StoreScanner = { addon: "steam", name: "Steam", platforms: ["linux", "win32"], scan: async () => [{ addon: "steam", externalId: "620", title: "Portal 2", installDir: "/s" }] };
    const all = await scanStoreGames([steamHere], "linux", { folders: [picked] });
    assert.equal(all.filter((g) => g.externalId === "620").length, 1);
    assert.equal(all.find((g) => g.externalId === "620")!.installDir, "/s", "the launcher's own listing wins");
    const noSteam = await scanStoreGames([steamHere], "linux", { folders: [picked], disabled: ["steam", "xbox", "ea"] });
    assert.deepEqual(noSteam.map((g) => g.addon).sort(), ["epic", "gog"]);
  });
});
