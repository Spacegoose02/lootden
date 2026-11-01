import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { imageKind, type FamilyWall, type Screenshot } from "@lootden/shared";
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

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b40000000049454e44ae426082", "hex");

describe("screenshot wall", () => {
  it("shares pictures with the family, kid-safe for kids, with reactions", async () => {
    const { app, ctx } = await makeApp(root);
    const dad = await person(app, ctx, "dad", { role: "admin" });
    const kid = await person(app, ctx, "kai", { kidMode: true });
    const games = ctx.library.list({});
    const [safe, grown] = [games[0]!, games[1]!];
    await app.inject({ method: "PATCH", url: `/api/games/${safe.id}`, headers: dad.headers, payload: { kidSafe: true } });
    await app.inject({ method: "PATCH", url: `/api/games/${grown.id}`, headers: dad.headers, payload: { kidSafe: false } });
    const post = (who: { headers: Record<string, string> }, query: string, body: Buffer = PNG) =>
      app.inject({ method: "POST", url: `/api/screenshots?${query}`, headers: { ...who.headers, "content-type": "image/png" }, payload: body });

    assert.equal((await post(dad, "", Buffer.from("not a picture"))).statusCode, 400);
    const mine = await post(dad, `gameId=${encodeURIComponent(grown.id)}&caption=Boss%20down!&width=1920&height=1080`);
    assert.equal(mine.statusCode, 200);
    const grownShot = mine.json() as Screenshot;
    assert.equal(grownShot.game!.title, grown.title);
    assert.equal(grownShot.caption, "Boss down!");
    assert.equal(grownShot.width, 1920);
    const safeShot = (await post(dad, `gameId=${encodeURIComponent(safe.id)}`)).json() as Screenshot;
    const kidShot = (await post(kid, "title=Minecraft")).json() as Screenshot;
    assert.equal(kidShot.game!.title, "Minecraft");
    assert.equal((await post(kid, `gameId=${encodeURIComponent(grown.id)}`)).statusCode, 400, "kids can't post from games they can't see");

    const all = (await app.inject({ url: "/api/screenshots", headers: dad.headers })).json() as Screenshot[];
    assert.deepEqual(all.map((s) => s.id), [kidShot.id, safeShot.id, grownShot.id]);
    const forKid = (await app.inject({ url: "/api/screenshots", headers: kid.headers })).json() as Screenshot[];
    assert.deepEqual(forKid.map((s) => s.id), [kidShot.id, safeShot.id], "no grown-up games on a kid's wall");
    assert.equal((await app.inject({ url: `/api/screenshots/${grownShot.id}/image`, headers: kid.headers })).statusCode, 404);
    const img = await app.inject({ url: `/api/screenshots/${safeShot.id}/image`, headers: kid.headers });
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers["content-type"], "image/png");
    assert.equal(imageKind(img.rawPayload), "png");

    // Reactions toggle.
    assert.equal((await app.inject({ method: "POST", url: `/api/screenshots/${safeShot.id}/react`, headers: kid.headers, payload: { emoji: "💩" } })).statusCode, 400);
    await app.inject({ method: "POST", url: `/api/screenshots/${safeShot.id}/react`, headers: kid.headers, payload: { emoji: "🔥" } });
    const reacted = (await app.inject({ method: "POST", url: `/api/screenshots/${safeShot.id}/react`, headers: dad.headers, payload: { emoji: "🔥" } })).json() as Screenshot;
    assert.deepEqual(reacted.reactions, [{ emoji: "🔥", count: 2, mine: true }]);
    const undone = (await app.inject({ method: "POST", url: `/api/screenshots/${safeShot.id}/react`, headers: dad.headers, payload: { emoji: "🔥" } })).json() as Screenshot;
    assert.deepEqual(undone.reactions, [{ emoji: "🔥", count: 1, mine: false }]);

    // The Den Duty wall summary follows the same rules.
    const wall = (await app.inject({ url: "/api/family/wall", headers: kid.headers })).json() as FamilyWall;
    assert.deepEqual(wall.screenshots.map((s) => s.id), [kidShot.id, safeShot.id]);

    // Only the person who took it, or an admin, deletes it.
    assert.equal((await app.inject({ method: "DELETE", url: `/api/screenshots/${safeShot.id}`, headers: kid.headers })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/screenshots/${kidShot.id}`, headers: dad.headers })).statusCode, 200);
    assert.equal(((await app.inject({ url: "/api/screenshots", headers: dad.headers })).json() as Screenshot[]).length, 2);
  });
});
