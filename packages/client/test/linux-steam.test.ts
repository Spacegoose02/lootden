import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { installedRunners, installRunner, prefixDir, runnerCommand, WINE } from "../src/runners.js";
import {
  addSteamShortcuts,
  listSteamShortcuts,
  parseBinaryVdf,
  parseTextVdf,
  removeSteamShortcuts,
  setCompatTool,
  shortcutAppId,
  steamRootOf,
  steamUsers,
  writeBinaryVdf,
  writeTextVdf,
} from "../src/steamshortcuts.js";

let work: string;
before(async () => (work = await mkdtemp(path.join(os.tmpdir(), "lootden-linux-"))));
after(async () => rm(work, { recursive: true, force: true }));

describe("Steam shortcuts", () => {
  it("round-trips binary VDF", () => {
    const v = { shortcuts: { "0": { appid: -123, AppName: "Halo", tags: { "0": "LootDen" } } } };
    assert.deepEqual(parseBinaryVdf(writeBinaryVdf(v)), v);
  });

  it("gives the same app id Steam does (CRC-32 with the top bit set)", () => {
    // CRC-32 of "123456789" is CBF43926, which already has the top bit.
    assert.equal(shortcutAppId("", "123456789"), 0xcbf43926);
    assert.ok(shortcutAppId('"/x"', "a") >= 0x80000000);
  });

  it("adds, updates and removes LootDen games, keeping other shortcuts", async () => {
    const root = path.join(work, "steam");
    await mkdir(path.join(root, "userdata", "42", "config"), { recursive: true });
    await mkdir(path.join(root, "userdata", "0"), { recursive: true });
    const [user, ...rest] = await steamUsers([root]);
    assert.equal(user!.id, "42");
    assert.equal(rest.length, 0);
    const file = path.join(user!.dir, "config", "shortcuts.vdf");
    await writeFile(file, writeBinaryVdf({ shortcuts: { "0": { appid: 5, AppName: "Mine", LaunchOptions: "" } } }));

    const game = { gameId: "g1", title: "Portal", appPath: "/opt/LootDen/lootden", art: { cover: { data: Buffer.from("png"), ext: "png" as const } } };
    assert.equal(await addSteamShortcuts(user!, [game]), 1);
    assert.equal(await addSteamShortcuts(user!, [game]), 1); // again: updated, not doubled
    const list = await listSteamShortcuts(user!);
    const appid = shortcutAppId('"/opt/LootDen/lootden"', "Portal");
    assert.deepEqual([...list], [["g1", appid]]);
    const all = parseBinaryVdf(await readFile(file)).shortcuts as Record<string, Record<string, unknown>>;
    assert.equal(Object.keys(all).length, 2);
    assert.deepEqual(await readdir(path.join(user!.dir, "config", "grid")), [`${appid}p.png`]);

    assert.equal(await removeSteamShortcuts(user!), 1);
    const left = parseBinaryVdf(await readFile(file)).shortcuts as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.values(left).map((s) => s.AppName), ["Mine"]);
    assert.deepEqual(await readdir(path.join(user!.dir, "config", "grid")), []);
  });
});

describe("Windows games through Steam's Proton (ARM handhelds)", () => {
  it("adds a Windows game as its own .exe and still knows it as a LootDen game", async () => {
    const root = path.join(work, "steam-arm");
    await mkdir(path.join(root, "userdata", "7", "config"), { recursive: true });
    const [user] = await steamUsers([root]);
    const app = { gameId: "g2", title: "Hades", appPath: "/apps/LootDen.AppImage", art: { cover: { data: Buffer.from("png"), ext: "png" as const } } };
    await addSteamShortcuts(user!, [app]);
    const viaApp = shortcutAppId('"/apps/LootDen.AppImage"', "Hades");

    // Again with the game's .exe: the same entry changes over, and the old art goes.
    await addSteamShortcuts(user!, [{ ...app, directExe: "/games/Hades/Hades.exe" }]);
    const direct = shortcutAppId('"/games/Hades/Hades.exe"', "Hades");
    assert.deepEqual([...(await listSteamShortcuts(user!))], [["g2", direct]]);
    const all = Object.values(parseBinaryVdf(await readFile(path.join(user!.dir, "config", "shortcuts.vdf"))).shortcuts as Record<string, Record<string, unknown>>);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.Exe, '"/games/Hades/Hades.exe"');
    assert.equal(all[0]!.StartDir, '"/games/Hades"');
    assert.equal(all[0]!.LaunchOptions, "");
    assert.deepEqual(await readdir(path.join(user!.dir, "config", "grid")), [`${direct}p.png`]);
    assert.notEqual(viaApp, direct);

    assert.equal(steamRootOf(user!), root);
    assert.equal(await removeSteamShortcuts(user!, ["g2"]), 1);
  });

  it("sets Steam Play for shortcuts, using the tool chosen for all other titles", async () => {
    const root = path.join(work, "steam-compat");
    await mkdir(path.join(root, "config"), { recursive: true });
    const config = [
      '"InstallConfigStore"',
      "{",
      '\t"Software"',
      "\t{",
      '\t\t"valve"',
      "\t\t{",
      '\t\t\t"Steam"',
      "\t\t\t{",
      '\t\t\t\t"AutoUpdateWindowEnabled"\t\t"0"',
      '\t\t\t\t"CompatToolMapping"',
      "\t\t\t\t{",
      '\t\t\t\t\t"0"',
      "\t\t\t\t\t{",
      '\t\t\t\t\t\t"name"\t\t"proton_cachyos_11"',
      '\t\t\t\t\t\t"config"\t\t""',
      '\t\t\t\t\t\t"priority"\t\t"75"',
      "\t\t\t\t\t}",
      "\t\t\t\t}",
      "\t\t\t}",
      "\t\t}",
      "\t}",
      '\t"Path"\t\t"C:\\\\Games \\"x\\""',
      "}",
      "",
    ].join("\n");
    await writeFile(path.join(root, "config", "config.vdf"), config);
    assert.equal(await setCompatTool(root, [3000000001]), "proton_cachyos_11");
    const v = parseTextVdf(await readFile(path.join(root, "config", "config.vdf"), "utf8"));
    const steam = ((v.InstallConfigStore as Record<string, unknown>).Software as Record<string, Record<string, Record<string, unknown>>>).valve!.Steam!;
    assert.deepEqual((steam.CompatToolMapping as Record<string, unknown>)["3000000001"], { name: "proton_cachyos_11", config: "", priority: "250" });
    assert.equal(steam.AutoUpdateWindowEnabled, "0", "other settings stay");
    assert.equal((v.InstallConfigStore as Record<string, unknown>).Path, 'C:\\Games "x"');
    assert.deepEqual(parseTextVdf(writeTextVdf(v)), v);

    // No config.vdf yet (Steam never ran): Proton Experimental.
    assert.equal(await setCompatTool(path.join(work, "steam-new"), [5]), "proton_experimental");
  });
});

describe("Proton and Wine", () => {
  it("starts games through Proton or Wine with their own prefix", () => {
    const tools = path.join(work, "tools");
    const wine = runnerCommand(tools, WINE, "g1", "/games/a.exe");
    assert.deepEqual(wine, { cmd: "wine", args: ["/games/a.exe"], env: { WINEPREFIX: prefixDir(tools, "g1") } });
    const proton = runnerCommand(tools, "GE-Proton9-20", "g1", "/games/a.exe");
    assert.equal(proton.cmd, path.join(tools, "runners", "GE-Proton9-20", "proton"));
    assert.deepEqual(proton.args, ["run", "/games/a.exe"]);
    assert.equal(proton.env.STEAM_COMPAT_DATA_PATH, prefixDir(tools, "g1"));
    assert.throws(() => runnerCommand(tools, "../evil", "g1", "x"));
  });

  it("installs a Proton build only when its checksum matches", async () => {
    const body = Buffer.from("fake tarball");
    const good = createHash("sha512").update(body).digest("hex");
    let sum = good;
    const server = http.createServer((req, res) => {
      if (req.url === "/sum") return res.end(`${sum}  GE-Proton9-20.tar.gz\n`);
      res.setHeader("content-length", body.length);
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const tools = path.join(work, "tools2");
    const release = { name: "GE-Proton9-20", publishedAt: "", url: `${base}/tar`, size: body.length, checksumUrl: `${base}/sum` };
    const untar = async (_a: string, into: string) => {
      await mkdir(path.join(into, "GE-Proton9-20"), { recursive: true });
      await writeFile(path.join(into, "GE-Proton9-20", "proton"), "#!/bin/sh\n");
    };
    try {
      sum = "0".repeat(128);
      await assert.rejects(installRunner(tools, release, { untar }), /SHA-512/);
      assert.deepEqual(await installedRunners(tools), []);
      sum = good;
      assert.equal(await installRunner(tools, release, { untar }), "GE-Proton9-20");
      assert.deepEqual(await installedRunners(tools), ["GE-Proton9-20"]);
      assert.deepEqual((await readdir(path.join(tools, "runners"))).sort(), ["GE-Proton9-20"]);
    } finally {
      server.close();
    }
  });
});
