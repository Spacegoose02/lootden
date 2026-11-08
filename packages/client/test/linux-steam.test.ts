import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { installedRunners, installRunner, prefixDir, runnerCommand, WINE } from "../src/runners.js";
import { addSteamShortcuts, listSteamShortcuts, parseBinaryVdf, removeSteamShortcuts, shortcutAppId, steamUsers, writeBinaryVdf } from "../src/steamshortcuts.js";

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
