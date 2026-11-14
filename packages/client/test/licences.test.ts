import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { GameLicence } from "@lootden/shared";
import type { GameServerClient } from "../src/api.js";
import { downloadLicences, installLicences, LICENCE_FOLDER, RPCS3_EXDATA } from "../src/licences.js";

const ID = "UP0001-NPUB30001_00-ABCDEF0123456789";
const key = Buffer.from("0123456789abcdef");

let work: string;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "lootden-licences-"));
});
after(() => rm(work, { recursive: true, force: true }));

/** Just the two calls the licence code makes. */
function fakeApi(licences: GameLicence[], files: Record<string, Buffer>): GameServerClient {
  return {
    json: async (p: string) => (p.endsWith("/licences") ? licences : assert.fail(p)),
    download: async (p: string) => new Uint8Array(files[decodeURIComponent(p.split("/").pop()!)] ?? assert.fail(p)),
  } as unknown as GameServerClient;
}

describe("PS3 licences on the PC", () => {
  it("keeps the server's licences with the game and copies them into RPCS3's exdata", async () => {
    const game = path.join(work, "Flower");
    const exdata = path.join(work, "rpcs3", RPCS3_EXDATA);
    await mkdir(path.join(game, "PS3_GAME", "USRDIR"), { recursive: true });
    // One that came in the game's own files, one misnamed (skipped), one the wrong size (skipped).
    const own = "UP0001-NPUB30001_00-DLC0000000000001";
    await writeFile(path.join(game, `${own.toLowerCase()}.RAP`), key);
    await writeFile(path.join(game, "license(1).rap"), key);
    await writeFile(path.join(game, "UP0001-NPUB30001_00-TOOBIG0000000001.rap"), Buffer.alloc(32));

    const api = fakeApi([{ name: `${ID}.rap`, contentId: ID, size: 16, uploadedAt: new Date().toISOString() }], { [`${ID}.rap`]: key });
    assert.deepEqual(await downloadLicences(api, "g1", "ps3", game), [`${ID}.rap`]);
    assert.deepEqual(await readFile(path.join(game, LICENCE_FOLDER, `${ID}.rap`)), key);
    assert.deepEqual(await downloadLicences(api, "g1", "ps3", game), [], "unchanged files aren't written again");
    assert.deepEqual(await downloadLicences(api, "g1", "ps2", game), [], "only PS3 games have licences");

    assert.deepEqual((await installLicences(game, exdata)).sort(), [`${ID}.rap`, `${own}.rap`].sort());
    assert.deepEqual((await readdir(exdata)).sort(), [`${ID}.rap`, `${own}.rap`].sort());
    assert.deepEqual(await readFile(path.join(exdata, `${own}.rap`)), key);
    assert.deepEqual(await installLicences(game, exdata), [], "already in place");
  });
});
