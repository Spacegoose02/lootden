import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { contentIdIn, pkgContentId, rapFileName } from "@lootden/shared";
import { makeApp, makeLibrary, sessionCookie } from "./helpers.js";

const CONTENT_ID = "UP0001-NPUB30001_00-ABCDEF0123456789";

/** The start of a PS3 package: magic, then its content id at 0x30. */
function pkgHead(contentId: string): Buffer {
  const head = Buffer.alloc(0x100);
  head.write("\x7fPKG", 0, "latin1");
  head.write(contentId, 0x30, "ascii");
  return head;
}

let root: string;
before(async () => {
  root = await makeLibrary();
  await mkdir(path.join(root, "Emulation", "ps3", "Flower"), { recursive: true });
  await writeFile(path.join(root, "Emulation", "ps3", "Flower", "Flower.pkg"), pkgHead(CONTENT_ID));
  await mkdir(path.join(root, "Emulation", "ps2"), { recursive: true });
  await writeFile(path.join(root, "Emulation", "ps2", "Okami.iso"), "0123456789");
});
after(() => rm(root, { recursive: true, force: true }));

type App = Awaited<ReturnType<typeof makeApp>>;
async function person(app: App["app"], ctx: App["ctx"], username: string, role: "admin" | "user" = "user") {
  await ctx.users.create({ username, password: "password123", role });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
  return { cookie: sessionCookie(login) };
}

describe("PS3 licences", () => {
  it("reads content ids from names and packages", () => {
    assert.equal(contentIdIn("up0001-npub30001_00-abcdef0123456789.rap"), CONTENT_ID);
    assert.equal(contentIdIn("license(1).rap"), null);
    assert.equal(rapFileName(CONTENT_ID.toLowerCase()), `${CONTENT_ID}.rap`);
    assert.throws(() => rapFileName("nope"));
    assert.equal(pkgContentId(pkgHead(CONTENT_ID)), CONTENT_ID);
    assert.equal(pkgContentId(Buffer.alloc(0x100)), null);
  });

  it("lets admins upload .rap files per PS3 game and players fetch them", async () => {
    const { app, ctx } = await makeApp(root);
    const admin = await person(app, ctx, "boss", "admin");
    const player = await person(app, ctx, "player");
    const flower = ctx.library.list({}).find((g) => g.platform === "ps3")!;
    const okami = ctx.library.list({}).find((g) => g.platform === "ps2")!;
    const key = Buffer.from("0123456789abcdef");
    const put = (gameId: string, name: string, data: Buffer, who = admin) =>
      app.inject({ method: "PUT", url: `/api/games/${gameId}/licences/${encodeURIComponent(name)}`, headers: { ...who, "content-type": "application/octet-stream" }, payload: data });

    assert.deepEqual((await app.inject({ url: `/api/games/${flower.id}/licences`, headers: player })).json(), []);
    assert.equal((await put(flower.id, `${CONTENT_ID}.rap`, key, player)).statusCode, 403);
    assert.match((await put(flower.id, `${CONTENT_ID}.rap`, Buffer.alloc(20))).json().error, /16 bytes/);
    assert.match((await put(okami.id, `${CONTENT_ID}.rap`, key)).json().error, /PS3 games/);
    assert.match((await put(flower.id, `${CONTENT_ID}.edat`, key)).json().error, /\.rap/);

    // A licence saved under another name takes its content id from the game's package.
    const up = await put(flower.id, "license(1).rap", key);
    assert.equal(up.statusCode, 200, up.body);
    assert.equal(up.json().name, `${CONTENT_ID}.rap`);

    const list = (await app.inject({ url: `/api/games/${flower.id}/licences`, headers: player })).json();
    assert.deepEqual(list.map((l: { name: string; contentId: string; size: number }) => [l.name, l.contentId, l.size]), [[`${CONTENT_ID}.rap`, CONTENT_ID, 16]]);
    const file = await app.inject({ url: `/api/games/${flower.id}/licences/${CONTENT_ID}.rap`, headers: player });
    assert.equal(file.statusCode, 200);
    assert.deepEqual(file.rawPayload, key);
    assert.equal((await app.inject({ url: `/api/games/${flower.id}/licences/..%2F..%2Fsecret.key`, headers: player })).statusCode, 404);

    // A second licence (DLC) by its own name, then deleting.
    const dlc = "UP0001-NPUB30001_00-DLC0000000000001";
    assert.equal((await put(flower.id, `${dlc.toLowerCase()}.rap`, key)).json().name, `${dlc}.rap`);
    assert.equal((await app.inject({ url: `/api/games/${flower.id}/licences`, headers: player })).json().length, 2);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/games/${flower.id}/licences/${dlc}.rap`, headers: player })).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/games/${flower.id}/licences/${dlc}.rap`, headers: admin })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/games/${flower.id}/licences`, headers: player })).json().length, 1);
  });
});
