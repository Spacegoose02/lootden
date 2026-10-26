import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import type { GameDetail, GameSummary, User } from "@lootden/shared";
import { scanLibrary, titleFromSource } from "../src/catalog/scanner.js";
import { parseRange } from "../src/routes/games.js";
import { makeApp, makeLibrary, sessionCookie } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

describe("scanner", () => {
  it("treats each folder and each root archive as one game", async () => {
    const games = await scanLibrary(root);
    assert.deepEqual(
      games.map((g) => g.title),
      ["Grand Theft Auto V", "Portal 2", "The Sims 4"],
    );
    const sims = games.find((g) => g.source === "The.Sims.4")!;
    assert.equal(sims.layout, "folder");
    assert.equal(sims.sizeBytes, 13);
    assert.deepEqual(sims.files.map((f) => f.path), ["Data/assets.bin", "setup.exe"]);
    assert.equal(sims.packed, false);
    assert.equal(games.find((g) => g.source === "Grand Theft Auto V")!.packed, true);
    assert.equal(games.find((g) => g.source === "Portal_2.7z")!.layout, "archive");
  });

  it("keeps ids stable between scans", async () => {
    const [a, b] = [await scanLibrary(root), await scanLibrary(root)];
    assert.deepEqual(a.map((g) => g.id), b.map((g) => g.id));
  });

  it("cleans titles", () => {
    assert.equal(titleFromSource("Some_Game.part1.rar", true), "Some Game");
    assert.equal(titleFromSource("Game.Name.v1.2", false), "Game Name v1 2");
  });
});

describe("parseRange", () => {
  it("handles open, closed, suffix and invalid ranges", () => {
    assert.deepEqual(parseRange("bytes=2-", 10), { start: 2, end: 9 });
    assert.deepEqual(parseRange("bytes=2-4", 10), { start: 2, end: 4 });
    assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
    assert.equal(parseRange("bytes=10-", 10), "invalid");
    assert.equal(parseRange(undefined, 10), null);
  });
});

describe("catalog API", () => {
  it("lists, searches and serves files with ranges", async () => {
    const { app } = await makeApp(root, { apiToken: "svc" });
    const auth = { authorization: "Bearer svc" };
    const all = (await app.inject({ url: "/api/games", headers: auth })).json<GameSummary[]>();
    assert.equal(all.length, 3);
    assert.ok(all.every((g) => g.addedAt && g.coverUrl === null && g.kidSafe === null));
    const found = (await app.inject({ url: "/api/games?search=sims", headers: auth })).json<GameSummary[]>();
    assert.equal(found.length, 1);
    const detail = (await app.inject({ url: `/api/games/${found[0]!.id}`, headers: auth })).json<GameDetail>();
    const asset = detail.files.find((f) => f.path === "Data/assets.bin")!;

    const full = await app.inject({ url: `/api/games/${detail.id}/files/${asset.index}`, headers: auth });
    assert.equal(full.statusCode, 200);
    assert.equal(full.body, "0123456789");

    const partial = await app.inject({ url: `/api/games/${detail.id}/files/${asset.index}`, headers: { ...auth, range: "bytes=4-" } });
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.body, "456789");
    assert.equal(partial.headers["content-range"], "bytes 4-9/10");

    assert.equal((await app.inject({ url: `/api/games/${detail.id}/files/99`, headers: auth })).statusCode, 404);
    assert.equal((await app.inject({ url: "/api/games/nope", headers: auth })).statusCode, 404);
    assert.equal((await app.inject(`/api/games?token=svc`)).statusCode, 200);
    await app.close();
  });

  it("sorts, filters and applies admin overrides", async () => {
    const { app, ctx } = await makeApp(root, { apiToken: "svc" });
    const auth = { authorization: "Bearer svc" };
    const [gta] = ctx.library.list({ search: "grand" });
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/games/${gta!.id}`,
      headers: auth,
      payload: { title: "GTA V", kidSafe: false, controllerSupport: "full" },
    });
    assert.equal(patched.json<GameDetail>().title, "GTA V");
    const pads = (await app.inject({ url: "/api/games?controller=full", headers: auth })).json<GameSummary[]>();
    assert.deepEqual(pads.map((g) => g.title), ["GTA V"]);
    const [sims] = ctx.library.list({ search: "sims" });
    await app.inject({ method: "PATCH", url: `/api/games/${sims!.id}`, headers: auth, payload: { controllerSupport: "partial" } });
    const titles = async (controller: string) =>
      (await app.inject({ url: `/api/games?controller=${controller}`, headers: auth })).json<GameSummary[]>().map((g) => g.title).sort();
    assert.deepEqual(await titles("partial"), ["The Sims 4"]);
    assert.deepEqual(await titles("any"), ["GTA V", "The Sims 4"]);
    const bySize = (await app.inject({ url: "/api/games?sort=size&order=desc", headers: auth })).json<GameSummary[]>();
    assert.equal(bySize[0]!.title, "The Sims 4");
    await app.close();
  });
});

describe("accounts and auth", () => {
  it("requires sign-in, runs first-time setup once, and keeps health public", async () => {
    const { app } = await makeApp(root);
    assert.equal((await app.inject("/api/health")).statusCode, 200);
    assert.equal((await app.inject("/api/games")).statusCode, 401);
    assert.equal((await app.inject("/api/auth/providers")).json().setupRequired, true);

    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "admin", password: "correct horse" } });
    assert.equal(setup.statusCode, 200);
    assert.equal(setup.json<User>().role, "admin");
    const cookie = sessionCookie(setup);
    assert.equal((await app.inject({ url: "/api/games", headers: { cookie } })).statusCode, 200);

    const again = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "x", password: "whatever123" } });
    assert.equal(again.statusCode, 409);
    assert.equal((await app.inject("/api/auth/providers")).json().setupRequired, false);

    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    assert.equal((await app.inject({ url: "/api/games", headers: { cookie } })).statusCode, 401);
    await app.close();
  });

  it("logs in with a password, issues client tokens and blocks wrong passwords", async () => {
    const { app, ctx } = await makeApp(root);
    await ctx.users.create({ username: "sam", password: "password1", displayName: "Sam" });
    const bad = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "sam", password: "nope" } });
    assert.equal(bad.statusCode, 401);

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "SAM", password: "password1", client: true, device: "Ally" } });
    assert.equal(login.statusCode, 200);
    const { token } = login.json<{ token: string }>();
    assert.match(token, /^gmt_/);
    const me = await app.inject({ url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.json().user.displayName, "Sam");
    const tokens = await app.inject({ url: "/api/me/tokens", headers: { authorization: `Bearer ${token}` } });
    assert.equal(tokens.json()[0].name, "Ally");
    assert.equal((await app.inject({ url: "/api/games", headers: { authorization: "Bearer gmt_forged" } })).statusCode, 401);
    await app.close();
  });

  it("limits regular users and hides grown-up games from kid profiles", async () => {
    const { app, ctx } = await makeApp(root);
    const admin = await ctx.users.create({ username: "admin", password: "password1", role: "admin" });
    const kid = await ctx.users.create({ username: "kid", password: "password1", kidMode: true });
    const user = await ctx.users.create({ username: "user", password: "password1" });
    const as = (id: number) => ({ authorization: `Bearer ${ctx.auth.createApiToken(id, "t").token}` });

    const [portal] = ctx.library.list({ search: "portal" });
    const [sims] = ctx.library.list({ search: "sims" });
    ctx.library.setOverrides(portal!.id, { kidSafe: true });

    const kidGames = (await app.inject({ url: "/api/games", headers: as(kid.id) })).json<GameSummary[]>();
    assert.deepEqual(kidGames.map((g) => g.title), ["Portal 2"]);
    assert.equal((await app.inject({ url: `/api/games/${sims!.id}`, headers: as(kid.id) })).statusCode, 404);
    assert.equal((await app.inject({ url: `/api/games/${sims!.id}/files/0`, headers: as(kid.id) })).statusCode, 404);

    assert.equal((await app.inject({ method: "POST", url: "/api/library/rescan", headers: as(user.id) })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/users", headers: as(user.id) })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/users", headers: as(admin.id) })).json().length, 3);
    const del = await app.inject({ method: "DELETE", url: `/api/users/${admin.id}`, headers: as(admin.id) });
    assert.equal(del.statusCode, 409);
    await app.close();
  });

  it("tracks installs and playtime and surfaces them on the home page", async () => {
    const { app, ctx } = await makeApp(root);
    const u = await ctx.users.create({ username: "player", password: "password1" });
    const headers = { authorization: `Bearer ${ctx.auth.createApiToken(u.id, "t").token}` };
    const [sims] = ctx.library.list({ search: "sims" });
    const post = (payload: object) => app.inject({ method: "POST", url: "/api/me/activity", headers, payload });
    assert.equal((await post({ gameId: sims!.id, device: "Desktop", event: "installed", installPath: "D:\\Games\\The Sims 4" })).statusCode, 200);
    await post({ gameId: sims!.id, device: "Desktop", event: "played", seconds: 1800 });
    await post({ gameId: sims!.id, device: "Desktop", event: "played", seconds: 600 });
    const states = (await app.inject({ url: "/api/me/games", headers })).json();
    assert.equal(states[0].playtimeSeconds, 2400);
    assert.equal(states[0].installPath, "D:\\Games\\The Sims 4");
    const home = (await app.inject({ url: "/api/home", headers })).json();
    assert.deepEqual(home.sections.slice(0, 2).map((s: { id: string }) => s.id), ["installed", "continue"], "installed games come first");
    assert.equal(home.sections[0].games[0].id, sims!.id);
    assert.equal(home.sections[1].games[0].id, sims!.id);
    await post({ gameId: sims!.id, device: "Desktop", event: "uninstalled" });
    const after = (await app.inject({ url: "/api/home", headers })).json();
    assert.equal(after.sections[0].id, "continue", "uninstalled games leave the Installed row");
    assert.equal((await post({ gameId: "x", device: "d", event: "bogus" })).statusCode, 400);
    const csv = await app.inject({ url: "/api/me/export/yamtrack.csv", headers });
    assert.match(csv.headers["content-type"] as string, /text\/csv/);
    const lines = csv.body.trim().split("\n");
    assert.equal(lines[0], "media_id,source,media_type,title,image,season_number,episode_number,score,status,notes,start_date,end_date,progress");
    assert.match(lines[1]!, /^,manual,game,The Sims 4,.*,In progress,Exported from LootDen,\d{4}-\d\d-\d\d,,40$/);
    await app.close();
  });

  it("accepts forward-auth headers only from trusted proxies", async () => {
    const { app } = await makeApp(root, {
      headerAuth: { userHeader: "remote-user", emailHeader: "remote-email", nameHeader: "remote-name", groupsHeader: "remote-groups", trustedProxies: ["10.0.0.0/8"], adminGroup: "admins" },
    });
    const headers = { "remote-user": "alex", "remote-email": "alex@example.com", "remote-groups": "admins,gamers" };
    const untrusted = await app.inject({ url: "/api/me", headers, remoteAddress: "192.168.1.9" });
    assert.equal(untrusted.statusCode, 401);
    const trusted = await app.inject({ url: "/api/me", headers, remoteAddress: "10.1.2.3" });
    assert.equal(trusted.statusCode, 200);
    assert.equal(trusted.json().user.username, "alex");
    assert.equal(trusted.json().role, "admin");
    await app.close();
  });

  it("serves deterministic gaming avatars and lets users reroll theirs", async () => {
    const { app, ctx } = await makeApp(root);
    const a = await app.inject("/api/avatars/abc123.svg");
    assert.equal(a.headers["content-type"], "image/svg+xml");
    assert.equal(a.body, (await app.inject("/api/avatars/abc123.svg")).body);
    assert.match(a.body, /^<svg/);
    const u = await ctx.users.create({ username: "rolly", password: "password1" });
    const headers = { authorization: `Bearer ${ctx.auth.createApiToken(u.id, "t").token}` };
    const rerolled = await app.inject({ method: "PATCH", url: "/api/me", headers, payload: { avatar: "random", displayName: "Rolly" } });
    assert.notEqual(rerolled.json<User>().avatar, u.avatar);
    assert.equal(rerolled.json<User>().displayName, "Rolly");
    await app.close();
  });
});
