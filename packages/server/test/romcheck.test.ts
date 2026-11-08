import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { headerBytes, parseDat, zipEntries } from "../src/emulation/romcheck.js";
import { makeApp, makeLibrary, sessionCookie } from "./helpers.js";

let root: string;
const rom = Buffer.alloc(4096, 7);
const nesBody = Buffer.alloc(8192, 3);
const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");

/** A stored (uncompressed) one-file zip. */
function zip(name: string, data: Buffer, crc: number): Buffer {
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12);
  end.writeUInt32LE(30 + n.length + data.length, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}

const DAT = `<?xml version="1.0"?>
<datafile>
  <header><name>Nintendo - Super Nintendo Entertainment System</name><version>20261101</version></header>
  <game name="Test Game (USA)"><rom name="Test Game (USA).sfc" size="4096" crc="00000000" sha1="${sha1(rom)}"/></game>
  <game name="Zipped &amp; Fine (Europe)"><rom name="z.sfc" size="5" crc="0000abcd"/></game>
  <game name="Plumber (Japan)"><rom name="p.nes" size="8192" crc="ffffffff" sha1="${sha1(nesBody)}"/></game>
</datafile>`;

before(async () => {
  root = await makeLibrary();
  const snes = path.join(root, "Emulation", "snes");
  await mkdir(snes, { recursive: true });
  await writeFile(path.join(snes, "Test Game (USA).sfc"), rom);
  await writeFile(path.join(snes, "My Hack.sfc"), Buffer.alloc(4096, 9));
  await writeFile(path.join(snes, "Zipped.zip"), zip("z.sfc", Buffer.from("hello"), 0xabcd));
  const nes = path.join(root, "Emulation", "nes");
  await mkdir(nes, { recursive: true });
  // An iNES header No-Intro's headerless DAT doesn't count.
  await writeFile(path.join(nes, "Plumber.nes"), Buffer.concat([Buffer.from("NES\x1a"), Buffer.alloc(12), nesBody]));
});
after(async () => rm(root, { recursive: true, force: true }));

describe("ROM checks", () => {
  it("reads No-Intro DATs and zip directories, and spots headers", async () => {
    const dat = parseDat(DAT);
    assert.equal(dat.name, "Nintendo - Super Nintendo Entertainment System");
    assert.equal(dat.version, "20261101");
    assert.equal(dat.roms.length, 3);
    assert.equal(dat.roms[1]!.game, "Zipped & Fine (Europe)");
    assert.throws(() => parseDat("<html></html>"));
    const z = path.join(root, "Emulation", "snes", "Zipped.zip");
    assert.deepEqual(await zipEntries(z), [{ name: "z.sfc", crc: "0000abcd", size: 5 }]);
    assert.equal(headerBytes("a.nes", 8208, Buffer.from("NES\x1a")), 16);
    assert.equal(headerBytes("a.smc", 4096 + 512, Buffer.alloc(16)), 512);
    assert.equal(headerBytes("a.sfc", 4096, Buffer.alloc(16)), 0);
  });

  it("checks games against uploaded DATs", async () => {
    const { app, ctx } = await makeApp(root);
    await ctx.users.create({ username: "boss", password: "password123", role: "admin" });
    const cookie = sessionCookie(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "boss", password: "password123" } }));
    const headers = { cookie };
    const game = (title: string) => ctx.library.list({}).find((g) => g.title.startsWith(title))!;

    assert.equal((await app.inject({ method: "POST", url: `/api/games/${game("Test Game").id}/rom-check`, headers })).statusCode, 400, "no DAT yet");
    const up = await app.inject({ method: "POST", url: "/api/emulation/dats", headers: { ...headers, "content-type": "text/xml" }, payload: DAT });
    assert.equal(up.statusCode, 200, up.body);
    assert.equal(up.json().games, 3);

    const check = async (title: string) => (await app.inject({ method: "POST", url: `/api/games/${game(title).id}/rom-check`, headers })).json();
    const good = await check("Test Game");
    assert.equal(good.status, "verified");
    assert.equal(good.matched, "Test Game (USA)");
    assert.equal((await check("My Hack")).status, "unknown");
    assert.equal((await check("Zipped")).status, "verified");
    assert.equal((await check("Plumber")).matched, "Plumber (Japan)");
    const saved = await app.inject({ url: `/api/games/${game("Test Game").id}/rom-check`, headers });
    assert.equal(saved.json().status, "verified");

    // Upload again: replaced, not doubled.
    await app.inject({ method: "POST", url: "/api/emulation/dats", headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from(DAT) });
    const list = (await app.inject({ url: "/api/emulation/dats", headers })).json();
    assert.equal(list.dats.length, 1);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/emulation/dats/${list.dats[0].id}`, headers })).statusCode, 200);
  });

  it("keeps browser save states apart from in-game saves", async () => {
    const { app, ctx } = await makeApp(root);
    await ctx.users.create({ username: "kid", password: "password123" });
    const cookie = sessionCookie(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "kid", password: "password123" } }));
    const id = ctx.library.list({}).find((g) => g.title.startsWith("Test Game"))!.id;
    const post = (runner?: string) =>
      app.inject({ method: "POST", url: `/api/games/${id}/saves?device=Browser${runner ? `&runner=${runner}` : ""}`, headers: { cookie, "content-type": "application/octet-stream" }, payload: zip("x", Buffer.from("s"), 0) });
    assert.equal((await post()).statusCode, 200);
    const state = await post("state:browser");
    assert.equal(state.statusCode, 200, state.body);
    assert.equal(state.json().runner, "state:browser");
    assert.equal((await post("state:evil")).statusCode, 400);
    const latest = (await app.inject({ url: "/api/saves", headers: { cookie } })).json() as Array<{ runner: string | null }>;
    assert.deepEqual(latest.map((s) => s.runner), [null], "the newest save per game is never a state");
  });
});
