import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { scanStoreGames, type StoreScanner } from "../src/stores/index.js";
import { steamInstalled, steamLibraries } from "../src/stores/steam.js";
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

  it("runs the scanners for this platform and ignores ones that fail", async () => {
    const ok: StoreScanner = { addon: "a", platforms: ["linux", "win32"], scan: async () => [{ addon: "a", externalId: "1", title: "One", installDir: "/x" }] };
    const broken: StoreScanner = { addon: "b", platforms: ["linux", "win32"], scan: async () => { throw new Error("no launcher"); } };
    const elsewhere: StoreScanner = { addon: "c", platforms: ["darwin"], scan: async () => [{ addon: "c", externalId: "2", title: "Two", installDir: "/y" }] };
    assert.deepEqual((await scanStoreGames([ok, broken, elsewhere], "linux")).map((g) => g.title), ["One"]);
  });
});
