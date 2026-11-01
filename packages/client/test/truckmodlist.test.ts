import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  classifyModPage,
  cleanModUrl,
  findDuplicateModFiles,
  matchLoadOrder,
  modFileKey,
  parseActiveMods,
  parseLoadOrderText,
  parseModSheet,
  profileNameFromFolder,
  siiFormat,
  workshopIdFromPackage,
  workshopPackage,
  writeActiveMods,
} from "@lootden/shared";
import { applyTruckLoadOrder, enableTruckTextSaves, retireTruckModFiles, steamWorkshopSubscriptions, truckProfiles } from "../src/truckmodlist.js";

let work: string;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "gm-truckmodlist-"));
});
after(() => rm(work, { recursive: true, force: true }));

const PROFILE = `SiiNunit
{
user_profile : _nameless.1a2.b3c4 {
 face: 0
 active_mods: 3
 active_mods[0]: "promods-ats-map-v161|ProMods Canada Map Package"
 active_mods[1]: "mod_workshop_package.00000000A4AAEB0A|ATS satellite BG"
 active_mods[2]: "Coast_to_Coast_v2.22.58.0|Coast to Coast \\xc3\\xa9dition \\"C2C\\""
 customization: 0
 profile_name: "Goose"
}
}
`;

describe("truck mod list", () => {
  it("reads a pasted spreadsheet: links cleaned, versions and category in their columns", () => {
    const rows = parseModSheet(
      [
        "Alaska Map Mod\thttps://alaskamod.com/my-account/downloads/\t1.46\t\tMaps\tyes\tyes",
        "Project NextGen\thttps://www.facebook.com/DamianSVW/\t1.44\t1.05.1\tGraphics/Weather\tyes\tyes",
        "Snow Tires\thttps://www.dropbox.com/s/g8ekdomf2jrqwrh/nitrotire.scs?dl=0&fbclid=IwAR22h6\t1.46\t1.0.0\tVehicle addon\tyes\tyes",
        "ATS satellite BG \thttps://steamcommunity.com/sharedfiles/filedetails/?id=2618624602\t1.46\t\tGraphics/Weather\tyes\tyes",
        "More Realistic Truck Stops\thttps://forum.scssoft.com/viewtopic.php?t=311476\t1.46\t\t\tyes\t",
        "Crash Fix for Huge Combo maps",
      ].join("\n"),
    );
    assert.equal(rows.length, 6);
    assert.deepEqual(rows[0], { name: "Alaska Map Mod", sourceUrl: "https://alaskamod.com/my-account/downloads/", workshopId: null, gameVersion: "1.46", modVersion: null, category: "Maps", extra: ["yes", "yes"] });
    assert.equal(rows[1]!.modVersion, "1.05.1");
    assert.equal(rows[2]!.sourceUrl, "https://www.dropbox.com/s/g8ekdomf2jrqwrh/nitrotire.scs?dl=0");
    assert.equal(rows[3]!.workshopId, "2618624602");
    assert.equal(rows[3]!.name, "ATS satellite BG");
    assert.equal(rows[4]!.category, null);
    assert.deepEqual(rows[4]!.extra, ["yes"]);
    assert.equal(rows[5]!.sourceUrl, null);
    assert.equal(cleanModUrl("javascript:alert(1)"), null);
    assert.equal(cleanModUrl("www.promods.net/setup.php?game=ats&utm_source=x"), "https://www.promods.net/setup.php?game=ats");
  });

  it("tells live, dead, moved, renamed, sign-in and blocked pages apart, with the versions they show", () => {
    const at = "2026-11-01T00:00:00.000Z";
    const trucky = classifyModPage(
      {
        url: "https://truckymods.io/american-truck-simulator/maps/project-better-arizona",
        finalUrl: "https://truckymods.io/american-truck-simulator/maps/project-better-arizona",
        httpStatus: 200,
        title: "Project Better Arizona | TruckyMods",
        text: "Project Better Arizona\nCurrent Version: 0.5.3\nGame Version: 1.61 (build 3271)\nLast Updated: 2026-10-05\n",
      },
      "Project Better Arizona",
      at,
    );
    assert.equal(trucky.status, "live");
    assert.equal(trucky.latestVersion, "0.5.3");
    assert.equal(trucky.latestGameVersion, "1.61");
    assert.equal(trucky.lastUpdated, "2026-10-05");
    assert.equal(trucky.finalUrl, null);

    const muo = classifyModPage(
      { url: "https://forum.scssoft.com/viewtopic.php?t=287978", finalUrl: "https://forum.scssoft.com/viewtopic.php?t=287978", httpStatus: 200, title: '[REL] Urban Traffic Overhaul (Formerly "Minor Urban Overhaul") (09/25/2026) - SCS Software', text: "…" },
      "Minor Urban Overhaul",
    );
    assert.equal(muo.status, "renamed");
    assert.equal(muo.lastUpdated, "2026-09-25");

    const login = classifyModPage({ url: "https://alaskamod.com/my-account/downloads/", finalUrl: "https://alaskamod.com/my-account/downloads/", httpStatus: 200, title: "Downloads – Alaska", text: "Login Username or email" }, "Alaska Map Mod");
    assert.equal(login.status, "login");

    const caribbean = classifyModPage({ url: "https://terramaps.net/download/view.php?game=caribbean", finalUrl: "https://terramaps.net/download/", httpStatus: 200, title: "TerraMaps Download Center", text: "Beyond for ATS" }, "Carribean Map");
    assert.equal(caribbean.status, "moved");
    assert.equal(caribbean.finalUrl, "https://terramaps.net/download/");

    const elsewhere = classifyModPage({ url: "https://reformaats.dudaone.com/downloads", finalUrl: "https://reforma.example.com/", httpStatus: 200, title: "Reforma", text: "" }, "Reforma Mod");
    assert.equal(elsewhere.status, "moved");
    assert.match(elsewhere.note!, /reforma\.example\.com/);

    const removed = classifyModPage(
      { url: "https://steamcommunity.com/sharedfiles/filedetails/?id=2618624602", finalUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=2618624602", httpStatus: 200, title: "Steam Workshop::ProMods Background", text: "This item has been removed from the community because it violates Steam Community & Content Guidelines. Item was removed for violating guidelines." },
      "ATS satellite BG",
    );
    assert.equal(removed.status, "dead");

    assert.equal(classifyModPage({ url: "https://x.example/a", finalUrl: "https://x.example/a", httpStatus: 404, title: "Not found", text: "" }, "A").status, "dead");
    assert.equal(classifyModPage({ url: "https://x.example/a", finalUrl: null, httpStatus: 0, title: "", text: "", error: "ERR_NAME_NOT_RESOLVED" }, "A").status, "dead");
    assert.equal(classifyModPage({ url: "https://forum.scssoft.com/viewtopic.php?t=1", finalUrl: "https://forum.scssoft.com/viewtopic.php?t=1", httpStatus: 403, title: "Just a moment...", text: "" }, "A").status, "blocked");
    assert.equal(classifyModPage({ url: "https://www.dropbox.com/s/x/nitrotire.scs?dl=0", finalUrl: null, httpStatus: 200, title: "", text: "", download: true }, "Snow Tires").status, "live");
  });

  it("finds doubles in the mod folder without lumping a mod's parts together", () => {
    const MB = 1024 * 1024;
    const groups = findDuplicateModFiles(
      [
        ["Project_Better_Arizona_0.5.0.1_1.58.scs", 42933],
        ["Project_Better_Arizona_0.5_1.58.scs", 42932],
        ["Reforma_MegaResources_v2_9_7_1_158.scs", 605604],
        ["Reforma_MegaResources_v2_9_7_158.scs", 605603],
        ["Reforma_ProMods_background_FIX_23_158 (1).scs", 1446],
        ["Reforma_ProMods_background_FIX_23_158.scs", 1446],
        ["MAC Global Edition Fix(1).scs", 9254],
        ["MAC Global Edition Fix.scs", 6154],
        ["promods-ats-def-v161[HIGH].scs", 118],
        ["promods-ats-def-v161[ULTRA].scs", 118],
        ["nitromods_tire_chains_NTTF.scs", 56961],
        ["nitrotire.scs", 56961],
        ["More American Cities (Texas - v1.4).scs", 334067],
        ["More American Cities (Utah - v1.3).scs", 56730],
        ["Beyond by TM for ATS 1.scs", 67897],
        ["Beyond by TM for ATS 2.scs", 1154],
        ["Reforma_Baja_Beta_3_4_158.scs", 27685],
      ].map(([file, kb]) => ({ file: file as string, sizeBytes: (kb as number) * 1024 + (kb === 56961 ? 0 : 0) })),
    );
    const sets = groups.map((g) => `${g.reason}: ${g.files.join(" + ")}`);
    assert.ok(sets.includes("versions: Project_Better_Arizona_0.5.0.1_1.58.scs + Project_Better_Arizona_0.5_1.58.scs"), sets.join("\n"));
    assert.ok(sets.includes("versions: Reforma_MegaResources_v2_9_7_158.scs + Reforma_MegaResources_v2_9_7_1_158.scs"), sets.join("\n"));
    assert.ok(sets.some((s) => s.includes("FIX_23_158 (1).scs")));
    assert.ok(sets.some((s) => s.includes("MAC Global Edition Fix(1).scs")));
    assert.ok(sets.some((s) => s.includes("[HIGH]") && s.includes("[ULTRA]")));
    assert.ok(sets.includes("same-file: nitromods_tire_chains_NTTF.scs + nitrotire.scs"), sets.join("\n"));
    assert.ok(!sets.some((s) => s.includes("More American Cities")));
    assert.ok(!sets.some((s) => s.includes("Beyond by TM")));
    assert.ok(MB > 0);
    assert.equal(modFileKey("Coast_to_Coast_v2.22.58.0.scs"), "coast to coast");
  });

  it("reads and rewrites a profile's active mods, top of the Mod Manager first", () => {
    const mods = parseActiveMods(PROFILE);
    assert.deepEqual(
      mods.map((m) => m.package),
      ["promods-ats-map-v161", "mod_workshop_package.00000000A4AAEB0A", "Coast_to_Coast_v2.22.58.0"],
    );
    assert.equal(mods[2]!.name, 'Coast to Coast édition "C2C"');
    assert.equal(workshopIdFromPackage(mods[1]!.package), String(0xa4aaeb0a));
    assert.equal(workshopPackage(String(0xa4aaeb0a)), "mod_workshop_package.00000000A4AAEB0A");

    const next = writeActiveMods(PROFILE, [mods[2]!, mods[0]!]);
    assert.deepEqual(parseActiveMods(next).map((m) => m.name), ['Coast to Coast édition "C2C"', "ProMods Canada Map Package"]);
    assert.match(next, / active_mods: 2\n active_mods\[0\]: "Coast_to_Coast_v2\.22\.58\.0\|Coast to Coast \\xc3\\xa9dition \\"C2C\\""\n/);
    assert.match(next, /customization: 0/);
    assert.match(next, /profile_name: "Goose"/);
    assert.equal(writeActiveMods(next, []).match(/active_mods/g)!.length, 1);

    assert.equal(siiFormat(new TextEncoder().encode("SiiNunit\n{")), "text");
    assert.equal(siiFormat(new Uint8Array([0x53, 0x63, 0x73, 0x43, 1, 2])), "encrypted");
    assert.equal(siiFormat(new TextEncoder().encode("BSII")), "binary");
    assert.equal(profileNameFromFolder("476f6f7365"), "Goose");
  });

  it("lines a saved or typed load order up with the mods on this PC", () => {
    const available = [
      { package: "Coast_to_Coast_v2.22.58.0", name: "Coast to Coast" },
      { package: "promods-ats-map-v161", name: "ProMods Canada Map Package" },
      { package: "Reforma_2_9_7_158", name: "Reforma" },
      { package: "mod_workshop_package.00000000A4AAEB0A", name: "North America Background" },
    ];
    const typed = parseLoadOrderText("1. Promods Canada Map Package\nCoast to Coast\n- Reforma Mod\nIsland Map\n");
    const m = matchLoadOrder(typed, available);
    assert.deepEqual(
      m.map((x) => x.match?.package ?? null),
      ["promods-ats-map-v161", "Coast_to_Coast_v2.22.58.0", "Reforma_2_9_7_158", null],
    );
    // A saved order matches by package first, whatever the name.
    assert.equal(matchLoadOrder([{ package: "mod_workshop_package.00000000A4AAEB0A", name: "Old name" }], available)[0]!.match?.name, "North America Background");
  });

  it("finds profiles, applies a load order with a backup, turns on readable saves and moves old files aside", async () => {
    const game = path.join(work, "American Truck Simulator");
    const mod = path.join(game, "mod");
    const local = path.join(game, "profiles", "476f6f7365");
    const cloud = path.join(game, "steam_profiles", "4f746865");
    await mkdir(local, { recursive: true });
    await mkdir(cloud, { recursive: true });
    await mkdir(mod, { recursive: true });
    await writeFile(path.join(local, "profile.sii"), PROFILE);
    await writeFile(path.join(cloud, "profile.sii"), Buffer.from([0x53, 0x63, 0x73, 0x43, 9, 9, 9]));
    const profiles = await truckProfiles(game);
    assert.equal(profiles.length, 2);
    const goose = profiles.find((p) => p.name === "Goose")!;
    assert.equal(goose.format, "text");
    assert.equal(goose.mods.length, 3);
    const other = profiles.find((p) => p.cloud)!;
    assert.equal(other.format, "encrypted");
    assert.equal(other.name, "Othe");

    const r = await applyTruckLoadOrder(game, local, [goose.mods[2]!]);
    assert.deepEqual(r.profile.mods.map((m) => m.package), ["Coast_to_Coast_v2.22.58.0"]);
    assert.ok(existsSync(r.backup));
    assert.equal(await readFile(r.backup, "utf8"), PROFILE);
    await assert.rejects(applyTruckLoadOrder(game, cloud, []), /coded format/);
    await assert.rejects(applyTruckLoadOrder(game, work, []), /isn't one of the game's profiles/);

    await assert.rejects(enableTruckTextSaves(game), /config\.cfg/);
    await writeFile(path.join(game, "config.cfg"), 'uset g_fps_limit "60"\r\nuset g_save_format "0"\r\n');
    assert.equal(await enableTruckTextSaves(game), true);
    assert.match(await readFile(path.join(game, "config.cfg"), "utf8"), /uset g_save_format "2"\r\n$/);
    assert.equal(await enableTruckTextSaves(game), false);

    await writeFile(path.join(mod, "old.scs"), "old");
    await writeFile(path.join(mod, "new.scs"), "new");
    assert.deepEqual(await retireTruckModFiles(mod, ["old.scs", "../escape.scs", "missing.scs"]), ["old.scs"]);
    assert.deepEqual(await readdir(mod), ["new.scs"]);
    assert.deepEqual(await readdir(path.join(game, "mod-old")), ["old.scs"]);
  });

  it("reads the Workshop items Steam has for a game", async () => {
    const steam = path.join(work, "Steam");
    await mkdir(path.join(steam, "steamapps", "workshop"), { recursive: true });
    await writeFile(
      path.join(steam, "steamapps", "workshop", "appworkshop_270880.acf"),
      `"AppWorkshop"\n{\n\t"appid"\t\t"270880"\n\t"WorkshopItemsInstalled"\n\t{\n\t\t"2618624602"\n\t\t{\n\t\t\t"size"\t\t"10990000"\n\t\t\t"timeupdated"\t\t"1635945540"\n\t\t}\n\t}\n}\n`,
    );
    const subs = await steamWorkshopSubscriptions("270880", [steam]);
    assert.equal(subs.length, 1);
    assert.equal(subs[0]!.id, "2618624602");
    assert.equal(subs[0]!.updatedAt, "2021-11-03T13:19:00.000Z");
    assert.deepEqual(await steamWorkshopSubscriptions("227300", [steam]), []);
  });
});
