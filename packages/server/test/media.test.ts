// Manuals (PDFs in a game's files, or uploaded) and trailer previews for library games.
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
  await writeFile(path.join(root, "The.Sims.4", "Manual.pdf"), "%PDF-1.4 sims manual");
});
after(() => rm(root, { recursive: true, force: true }));

describe("game manuals and previews", () => {
  it("lists PDFs that came with a game, serves them inline, and takes an uploaded manual", async () => {
    const steamCalls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (!url.startsWith("https://store.steampowered.com/api/appdetails")) throw new Error(`Unexpected network call in test: ${url}`);
      steamCalls.push(url);
      return new Response(
        JSON.stringify({ "1222670": { success: true, data: { name: "The Sims 4", movies: [{ name: "Teaser" }, { name: "Launch Trailer", thumbnail: "https://cdn/t.jpg", mp4: { max: "https://cdn/launch.mp4" } }] } } }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const { app, ctx } = await makeApp(root, {}, { fetchImpl });
    const admin = await ctx.users.create({ username: "mom", password: "password1", role: "admin" });
    const kid = await ctx.users.create({ username: "kit", password: "password1", kidMode: true });
    const as = (id: number) => ({ authorization: `Bearer ${ctx.auth.createApiToken(id, "t").token}` });
    const sims = ctx.library.list().find((g) => g.title.includes("Sims"))!;

    const list = await app.inject({ method: "GET", url: `/api/games/${sims.id}/manuals`, headers: as(admin.id) });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(
      list.json().map((m: { name: string; uploaded: boolean }) => [m.name, m.uploaded]),
      [["Manual", false]],
    );
    const pdf = await app.inject({ method: "GET", url: list.json()[0].url, headers: as(admin.id) });
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.headers["content-type"], "application/pdf");
    assert.match(String(pdf.headers["content-disposition"]), /^inline/);
    assert.match(pdf.body, /sims manual/);

    // Kids can't reach games that aren't known to be kid-safe.
    assert.equal((await app.inject({ method: "GET", url: `/api/games/${sims.id}/manuals`, headers: as(kid.id) })).statusCode, 404);

    // Uploads: admins only, and only real PDFs.
    const put = (headers: Record<string, string>, body: string) => app.inject({ method: "PUT", url: `/api/games/${sims.id}/manual`, headers: { ...headers, "content-type": "application/pdf" }, payload: Buffer.from(body) });
    assert.equal((await put(as(admin.id), "not a pdf")).statusCode, 400);
    assert.equal((await put(as(kid.id), "%PDF-1.7 x")).statusCode, 403);
    assert.equal((await put(as(admin.id), "%PDF-1.7 scanned")).statusCode, 200);
    const after = (await app.inject({ method: "GET", url: `/api/games/${sims.id}/manuals`, headers: as(admin.id) })).json();
    assert.equal(after.length, 2);
    assert.equal(after[0].uploaded, true);
    assert.match((await app.inject({ method: "GET", url: after[0].url, headers: as(admin.id) })).body, /scanned/);
    await app.inject({ method: "DELETE", url: `/api/games/${sims.id}/manual`, headers: as(admin.id) });
    assert.equal((await app.inject({ method: "GET", url: `/api/games/${sims.id}/manuals`, headers: as(admin.id) })).json().length, 1);

    // Trailer preview from Steam, picking the launch trailer, asked for once.
    ctx.db
      .prepare("INSERT INTO metadata (game_id, provider, provider_id, name, steam_app_id, locked, fetched_at) VALUES (?, 'steam', '1222670', 'The Sims 4', '1222670', 0, '2020-01-01T00:00:00Z')")
      .run(sims.id);
    const p1 = await app.inject({ method: "GET", url: `/api/games/${sims.id}/preview`, headers: as(admin.id) });
    assert.equal(p1.statusCode, 200, p1.body);
    assert.deepEqual(p1.json().trailer, { url: "https://cdn/launch.mp4", poster: "https://cdn/t.jpg" });
    await app.inject({ method: "GET", url: `/api/games/${sims.id}/preview`, headers: as(admin.id) });
    assert.equal(steamCalls.length, 1, "remembered");

    // A game with no metadata has no preview, and no network call.
    const portal = ctx.library.list().find((g) => g.title.includes("Portal"))!;
    assert.equal((await app.inject({ method: "GET", url: `/api/games/${portal.id}/preview`, headers: as(admin.id) })).json().trailer, null);
    assert.equal(steamCalls.length, 1);
    await app.close();
  });
});
