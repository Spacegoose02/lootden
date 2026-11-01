import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { cleanMac, magicPacket, playedFor, type NowPlaying, type PcInfo, type PresenceAnswer } from "@lootden/shared";
import { broadcastAddresses } from "../src/users/presence.js";
import { makeApp, makeLibrary, sessionCookie } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

type App = Awaited<ReturnType<typeof makeApp>>;

async function person(app: App["app"], ctx: App["ctx"], username: string, extra: { role?: "admin" | "user"; kidMode?: boolean } = {}) {
  const user = await ctx.users.create({ username, password: "password123", displayName: username[0]!.toUpperCase() + username.slice(1), ...extra });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
  return { id: user.id, headers: { cookie: sessionCookie(login) } };
}

describe("now playing", () => {
  it("shows who plays what on which PC, and drops games that stop", async () => {
    const { app, ctx } = await makeApp(root);
    const admin = await person(app, ctx, "mama", { role: "admin" });
    const kid = await person(app, ctx, "mia");
    const portal = ctx.library.list({}).find((g) => /portal/i.test(g.title))!;
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const beat = await app.inject({
      method: "POST",
      url: "/api/me/presence",
      headers: kid.headers,
      payload: {
        device: "DEN-PC",
        playing: [
          { gameId: portal.id, title: "portal", source: "lootden", startedAt },
          { gameId: "store:steam:620", title: "Portal 2", source: "store", store: "Steam", startedAt },
        ],
        pc: { macs: ["1C-69-7A-0B-22-41", "nonsense"], addresses: ["192.168.1.20"], disks: [{ path: "C:\\", freeBytes: 5e10, totalBytes: 5e11 }], sunshine: true },
      },
    });
    assert.equal(beat.statusCode, 200);
    assert.deepEqual((beat.json() as PresenceAnswer).commands, []);

    const board = (await app.inject({ url: "/api/family/now-playing", headers: admin.headers })).json() as NowPlaying[];
    assert.equal(board.length, 2);
    const lib = board.find((b) => b.source === "lootden")!;
    assert.equal(lib.title, portal.title, "LootDen games use the library's title");
    assert.equal(lib.name, "Mia");
    assert.equal(lib.device, "DEN-PC");
    assert.equal(lib.canControl, true);
    const steam = board.find((b) => b.source === "store")!;
    assert.equal(steam.href, "/store/steam/620");
    assert.equal(steam.store, "Steam");

    // The next heartbeat only has the Steam game: Portal stopped.
    await app.inject({ method: "POST", url: "/api/me/presence", headers: kid.headers, payload: { device: "DEN-PC", playing: [{ gameId: "store:steam:620", title: "Portal 2", source: "store", startedAt: new Date().toISOString() }] } });
    const after = (await app.inject({ url: "/api/family/now-playing", headers: admin.headers })).json() as NowPlaying[];
    assert.deepEqual(after.map((b) => b.gameId), ["store:steam:620"]);
    assert.equal(after[0]!.startedAt, steam.startedAt, "a game keeps the time it started");

    const pcs = (await app.inject({ url: "/api/pcs", headers: admin.headers })).json() as PcInfo[];
    assert.equal(pcs[0]!.name, "DEN-PC");
    assert.equal(pcs[0]!.online, true);
    assert.deepEqual(pcs[0]!.macs, ["1c:69:7a:0b:22:41"]);
    assert.equal(pcs[0]!.sunshine, true);
    assert.equal(pcs[0]!.disks[0]!.freeBytes, 5e10);
    assert.equal(pcs[0]!.lastUser, "Mia");
    assert.equal((await app.inject({ url: "/api/pcs", headers: kid.headers })).statusCode, 403, "kids don't manage PCs");
  });

  it("hides grown-up games from kids, but not their own", async () => {
    const { app, ctx } = await makeApp(root);
    const dad = await person(app, ctx, "dad", { role: "admin" });
    const kid = await person(app, ctx, "leo", { kidMode: true });
    await app.inject({ method: "POST", url: "/api/me/presence", headers: dad.headers, payload: { device: "OFFICE", playing: [{ gameId: "store:steam:1", title: "Grim Shooter", source: "store", startedAt: new Date().toISOString() }] } });
    await app.inject({ method: "POST", url: "/api/me/presence", headers: kid.headers, payload: { device: "DEN", playing: [{ gameId: "roblox:42", title: "Roblox", source: "roblox", startedAt: new Date().toISOString() }] } });
    const seen = (await app.inject({ url: "/api/family/now-playing", headers: kid.headers })).json() as NowPlaying[];
    assert.equal(seen.find((s) => s.name === "Dad")!.title, "A game");
    assert.equal(seen.find((s) => s.name === "Dad")!.href, null);
    assert.equal(seen.find((s) => s.name === "Leo")!.title, "Roblox");
    assert.ok(seen.every((s) => !s.canControl));
  });

  it("delivers a parent's message and close on the PC's next heartbeat", async () => {
    const { app, ctx } = await makeApp(root);
    const admin = await person(app, ctx, "boss", { role: "admin" });
    const kid = await person(app, ctx, "ava", { kidMode: true });
    ctx.family.saveSettings({ timeZone: "UTC" });
    await app.inject({ method: "PUT", url: `/api/users/${kid.id}/limits`, headers: admin.headers, payload: { weekdayMinutes: 60, weekendMinutes: 60 } });
    const beat = (game = true) =>
      app.inject({ method: "POST", url: "/api/me/presence", headers: kid.headers, payload: { device: "KIDS-PC", playing: game ? [{ gameId: "roblox:7", title: "Roblox", source: "roblox", startedAt: new Date().toISOString() }] : [] } });
    await beat();
    assert.equal((await app.inject({ method: "POST", url: "/api/pcs/KIDS-PC/message", headers: kid.headers, payload: { text: "hi" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/pcs/KIDS-PC/message", headers: admin.headers, payload: { text: "  Dinner   in 5!  " } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/pcs/KIDS-PC/close", headers: admin.headers, payload: { gameId: "nope" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/pcs/KIDS-PC/close", headers: admin.headers, payload: { gameId: "roblox:7", text: "Bedtime" } })).statusCode, 200);
    const bonus = await app.inject({ method: "POST", url: `/api/family/now-playing/${kid.id}/bonus`, headers: admin.headers, payload: { minutes: 15 } });
    assert.equal(bonus.statusCode, 200);
    assert.equal((bonus.json() as { allowance: { bonusSeconds: number } }).allowance.bonusSeconds, 15 * 60);

    const got = (await beat()).json() as PresenceAnswer;
    assert.deepEqual(
      got.commands.map((c) => [c.kind, c.kind === "message" ? c.text : c.gameId]),
      [
        ["message", "Dinner in 5!"],
        ["close", "roblox:7"],
        ["message", "Boss gave you 15 more minutes!"],
      ],
    );
    assert.equal(got.commands[1]!.from, "Boss");
    assert.deepEqual(((await beat()).json() as PresenceAnswer).commands, [], "each command is delivered once");

    const board = (await app.inject({ url: "/api/family/now-playing", headers: admin.headers })).json() as NowPlaying[];
    assert.ok(board[0]!.remainingSeconds! > 74 * 60 && board[0]!.remainingSeconds! <= 75 * 60, "time left counts the bonus and the game still running");
    assert.equal(((await app.inject({ url: "/api/family/now-playing", headers: kid.headers })).json() as NowPlaying[])[0]!.remainingSeconds !== null, true, "kids see their own time left");
  });

  it("wakes a PC with the magic packet on its network", async () => {
    const sent: Array<{ packet: Uint8Array; to: string[] }> = [];
    const { app, ctx } = await makeApp(root, {}, { wake: async (packet, to) => void sent.push({ packet, to }) });
    const admin = await person(app, ctx, "root", { role: "admin" });
    await app.inject({ method: "POST", url: "/api/me/presence", headers: admin.headers, payload: { device: "TV-PC", playing: [], pc: { addresses: ["10.0.0.9"] } } });
    assert.equal((await app.inject({ method: "POST", url: "/api/pcs/TV-PC/wake", headers: admin.headers })).statusCode, 400, "no MAC known yet");
    assert.equal((await app.inject({ method: "PUT", url: "/api/pcs/TV-PC/mac", headers: admin.headers, payload: { mac: "zz" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url: "/api/pcs/TV-PC/mac", headers: admin.headers, payload: { mac: "AA:BB:CC:DD:EE:01" } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/pcs/TV-PC/wake", headers: admin.headers })).statusCode, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.to, ["255.255.255.255", "10.0.0.255"]);
    assert.equal(sent[0]!.packet.length, 102);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/pcs/TV-PC", headers: admin.headers })).statusCode, 200);
    assert.equal(((await app.inject({ url: "/api/pcs", headers: admin.headers })).json() as PcInfo[]).length, 0);
  });

  it("sends a game to a PC, which installs it on its next heartbeat", async () => {
    const { app, ctx } = await makeApp(root);
    const admin = await person(app, ctx, "pops", { role: "admin" });
    const kid = await person(app, ctx, "zoe", { kidMode: true });
    const other = await person(app, ctx, "sam");
    const portal = ctx.library.list({}).find((g) => /portal/i.test(g.title))!;
    await app.inject({ method: "POST", url: "/api/me/presence", headers: kid.headers, payload: { device: "ZOE-PC", playing: [] } });
    assert.equal((await app.inject({ method: "POST", url: "/api/pcs/ZOE-PC/install", headers: other.headers, payload: { gameId: portal.id } })).statusCode, 403, "not someone else's PC");
    assert.equal((await app.inject({ method: "POST", url: "/api/pcs/ZOE-PC/install", headers: admin.headers, payload: { gameId: "nope" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/pcs/NOWHERE/install", headers: admin.headers, payload: { gameId: portal.id } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/pcs/ZOE-PC/install", headers: admin.headers, payload: { gameId: portal.id } })).statusCode, 200);
    const targets = (await app.inject({ url: "/api/pcs/targets", headers: kid.headers })).json() as Array<{ name: string }>;
    assert.deepEqual(targets.map((t) => t.name), ["ZOE-PC"], "people see the PCs they use");
    assert.deepEqual(((await app.inject({ url: "/api/pcs/targets", headers: other.headers })).json() as unknown[]).length, 0);
    const got = (await app.inject({ method: "POST", url: "/api/me/presence", headers: kid.headers, payload: { device: "ZOE-PC", playing: [] } })).json() as PresenceAnswer;
    assert.deepEqual(got.commands.map((c) => [c.kind, c.kind === "install" ? c.title : ""]), [["install", portal.title]]);
  });

  it("builds magic packets and reads MAC addresses", () => {
    assert.equal(cleanMac("AA-BB-CC-DD-EE-FF"), "aa:bb:cc:dd:ee:ff");
    assert.equal(cleanMac("00:00:00:00:00:00"), null);
    const p = magicPacket("01:02:03:04:05:06");
    assert.deepEqual([...p.slice(0, 6)], [255, 255, 255, 255, 255, 255]);
    assert.deepEqual([...p.slice(96)], [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(broadcastAddresses(["192.168.4.7", "fe80::1"]), ["255.255.255.255", "192.168.4.255"]);
    assert.equal(playedFor(new Date(Date.now() - 65 * 60_000).toISOString()), "1 h 5 min");
  });
});
