import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

/** Steam's GetPublishedFileDetails: 2618624602 is gone (result 9), 3370862855 is there. */
const steam: typeof fetch = async (input, init) => {
  const url = String(input);
  if (!url.includes("GetPublishedFileDetails")) throw new Error("offline");
  const ids = [...new URLSearchParams(String(init?.body)).entries()].filter(([k]) => k.startsWith("publishedfileids")).map(([, v]) => v);
  const details = ids.map((id) =>
    id === "3370862855"
      ? { publishedfileid: id, result: 1, title: "Realistic Brutal Graphics And Weather", consumer_app_id: 270880, time_updated: 1790000000, file_size: "100" }
      : { publishedfileid: id, result: 9 },
  );
  return new Response(JSON.stringify({ response: { publishedfiledetails: details } }), { headers: { "content-type": "application/json" } });
};

describe("truck mod list", () => {
  it("merges the mod folder, a pasted sheet and Workshop items into one list, keeps checks and load orders", async () => {
    const { app, ctx } = await makeApp(root, {}, { fetchImpl: steam });
    const token = async (name: string, kid = false) => {
      const u = await ctx.users.create({ username: name, password: "password1", role: "user" });
      if (kid) ctx.db.prepare("UPDATE users SET kid_mode = 1 WHERE id = ?").run(u.id);
      return { authorization: `Bearer ${ctx.auth.createApiToken(u.id, "t").token}` };
    };
    const me = await token("goose");
    const kid = await token("kiddo", true);
    const post = (url: string, payload: object, headers = me) => app.inject({ method: "POST", url, headers, payload });

    // From the PC: files grouped into mods.
    const pc = await post("/api/truck-mod-list/import", {
      game: "ats",
      mods: [
        { name: "Coast to Coast v2.22.58.0", files: ["Coast_to_Coast_v2.22.58.0.scs"], modVersion: "2.22.58" },
        { name: "Reforma 2 9 7 158", files: ["Reforma_2_9_7_158.scs"] },
      ],
    });
    assert.equal(pc.statusCode, 200);
    assert.equal(pc.json().added, 2);

    // Then the sheet: same mods by name get the links; new ones are added.
    const sheet = await post("/api/truck-mod-list/import", {
      game: "ats",
      mods: [
        { name: "Coast to Coast", sourceUrl: "https://forum.scssoft.com/viewtopic.php?t=202317", gameVersion: "1.46", category: "Maps" },
        { name: "Reforma Mod", sourceUrl: "https://reformaats.dudaone.com/downloads", category: "Maps" },
        { name: "Island Map", sourceUrl: "https://truckymods.io/american-truck-simulator/maps/island-map", gameVersion: "1.43" },
      ],
    });
    assert.deepEqual([sheet.json().added, sheet.json().updated], [1, 2]);
    const c2c = sheet.json().mods.find((m: { files: string[] }) => m.files.includes("Coast_to_Coast_v2.22.58.0.scs"));
    assert.equal(c2c.name, "Coast to Coast");
    assert.equal(c2c.sourceUrl, "https://forum.scssoft.com/viewtopic.php?t=202317");
    assert.equal(c2c.modVersion, "2.22.58");
    assert.equal(c2c.gameVersion, "1.46");

    // Workshop subscriptions: titles from Steam; a removed item is marked dead.
    const ws = await post("/api/truck-mod-list/workshop", { game: "ats", ids: ["2618624602", "3370862855"] });
    assert.equal(ws.statusCode, 200);
    const rbgw = ws.json().mods.find((m: { workshopId: string }) => m.workshopId === "3370862855");
    assert.equal(rbgw.name, "Realistic Brutal Graphics And Weather");
    assert.equal(rbgw.check.status, "live");
    assert.equal(rbgw.sourceUrl, "https://steamcommunity.com/sharedfiles/filedetails/?id=3370862855");
    const gone = ws.json().mods.find((m: { workshopId: string }) => m.workshopId === "2618624602");
    assert.equal(gone.check.status, "dead");

    // A check from the desktop app is kept; a new link clears it.
    const island = sheet.json().mods.find((m: { name: string }) => m.name === "Island Map");
    const checked = await app.inject({ method: "PATCH", url: `/api/truck-mod-list/${island.id}`, headers: me, payload: { check: { status: "live", checkedAt: "2026-11-01T00:00:00Z", latestVersion: "0.2.1", latestGameVersion: "1.43", note: "x".repeat(500) } } });
    assert.equal(checked.json().check.latestGameVersion, "1.43");
    assert.equal(checked.json().check.note.length, 300);
    const bogus = await app.inject({ method: "PATCH", url: `/api/truck-mod-list/${island.id}`, headers: me, payload: { sourceUrl: "not a link" } });
    assert.equal(bogus.statusCode, 400);
    const relinked = await app.inject({ method: "PATCH", url: `/api/truck-mod-list/${island.id}`, headers: me, payload: { sourceUrl: "https://example.com/island", retired: true } });
    assert.equal(relinked.json().check, null);
    assert.equal(relinked.json().retired, true);

    // Load orders, by name, for every PC.
    const saved = await app.inject({ method: "PUT", url: "/api/truck-load-orders", headers: me, payload: { game: "ats", name: "Main", mods: [{ package: "Coast_to_Coast_v2.22.58.0", name: "Coast to Coast" }, { package: "", name: "Reforma Mod" }] } });
    assert.equal(saved.statusCode, 200);
    const again = await app.inject({ method: "PUT", url: "/api/truck-load-orders", headers: me, payload: { game: "ats", name: "main", mods: [{ package: "x", name: "X" }] } });
    assert.equal(again.json().id, saved.json().id);
    const orders = (await app.inject({ url: "/api/truck-load-orders?game=ats", headers: me })).json();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].updatedBy, "goose");
    assert.equal((await app.inject({ method: "PUT", url: "/api/truck-load-orders", headers: me, payload: { game: "ats", name: "Empty", mods: [] } })).statusCode, 400);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/truck-load-orders/${saved.json().id}`, headers: me })).statusCode, 200);

    // Kid profiles stay out; the list is per game.
    assert.equal((await app.inject({ url: "/api/truck-mod-list?game=ats", headers: kid })).statusCode, 403);
    assert.deepEqual((await app.inject({ url: "/api/truck-mod-list?game=ets2", headers: me })).json(), []);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/truck-mod-list/${island.id}`, headers: me })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/truck-mod-list?game=ats", headers: me })).json().length, 4);
  });
});
