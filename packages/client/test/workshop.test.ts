import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { installWorkshopItem, listWorkshopItems, removeWorkshopItem, steamCmdResult } from "../src/workshop.js";

let work: string;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "gm-workshop-"));
});
after(() => rm(work, { recursive: true, force: true }));

describe("Steam Workshop on this PC", () => {
  it("reads what SteamCMD says about a download", () => {
    assert.deepEqual(steamCmdResult('Downloading item 123 ...\nSuccess. Downloaded item 123 to "/w/steamapps/workshop/content/620/123" (2048 bytes)', "123"), { dir: "/w/steamapps/workshop/content/620/123" });
    assert.match((steamCmdResult("ERROR! Download item 123 failed (Failure).", "123") as { error: string }).error, /signing in/);
    assert.match((steamCmdResult("ERROR! Download item 123 failed (File Not Found).", "123") as { error: string }).error, /doesn't exist/);
    assert.ok("error" in steamCmdResult("Steam>quit", "123"));
  });

  it("copies items into the mods folder, lists them and removes only its own", async () => {
    const game = path.join(work, "Portal 2");
    const content = path.join(work, "content", "123");
    await mkdir(path.join(content, "maps"), { recursive: true });
    await writeFile(path.join(content, "maps", "hat.bsp"), "map");
    await mkdir(path.join(game, "Mods", "456"), { recursive: true });
    await writeFile(path.join(game, "Mods", "456", "theirs.txt"), "someone else's mod");

    const item = await installWorkshopItem(content, game, "Mods", { id: "123", title: "Hats" });
    assert.equal(item.dir, path.join(game, "Mods", "123"));
    assert.equal(await readFile(path.join(game, "Mods", "123", "maps", "hat.bsp"), "utf8"), "map");
    assert.deepEqual((await listWorkshopItems(game, "Mods")).map((i) => [i.id, i.title]), [["123", "Hats"]]);

    await assert.rejects(removeWorkshopItem(game, "Mods", "456"), /didn't install/);
    await assert.rejects(installWorkshopItem(content, game, "../Elsewhere", { id: "123", title: "Hats" }));
    await assert.rejects(installWorkshopItem(content, game, "", { id: "123", title: "Hats" }), /mods folder/);
    await assert.rejects(removeWorkshopItem(game, "Mods", "../456"));

    await removeWorkshopItem(game, "Mods", "123");
    assert.ok(!existsSync(path.join(game, "Mods", "123")));
    assert.ok(existsSync(path.join(game, "Mods", "456", "theirs.txt")));
  });
});
