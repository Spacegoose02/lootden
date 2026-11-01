import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanSmartRules, duplicateKey, smartShelfGames } from "@lootden/shared";
import { applyPendingRestore, BackupService, PENDING_RESTORE } from "../src/settings/backups.js";
import { openDatabase } from "../src/db/database.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

async function person(app: Awaited<ReturnType<typeof makeApp>>["app"], ctx: Awaited<ReturnType<typeof makeApp>>["ctx"], username: string, role: "user" | "admin" = "user") {
  const user = await ctx.users.create({ username, password: "password123", role });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
  return { user, headers: { cookie: `gm_session=${login.cookies.find((c) => c.name === "gm_session")!.value}` } };
}

describe("favourites, hidden games, tags and custom fields", () => {
  it("keeps each person's marks and edits many games at once", async () => {
    const { app, ctx } = await makeApp(root);
    const sam = await person(app, ctx, "sam");
    const [a, b] = ctx.library.list({});
    const one = await app.inject({ method: "PATCH", url: `/api/me/marks/${a!.id}`, headers: sam.headers, payload: { favourite: true, tags: ["Co-op", "co-op", " Couch "], fields: { "Mods installed": "Yes" } } });
    assert.equal(one.statusCode, 200);
    assert.deepEqual(one.json().tags, ["Co-op", "Couch"]);
    const bulk = await app.inject({ method: "POST", url: "/api/me/marks/bulk", headers: sam.headers, payload: { keys: [a!.id, b!.id, "store:steam:620"], patch: { addTags: ["Weekend"], hidden: false }, status: "backlog" } });
    assert.equal(bulk.json().changed, 3);
    const marks = (await app.inject({ url: "/api/me/marks", headers: sam.headers })).json();
    assert.deepEqual(marks[a!.id].tags, ["Co-op", "Couch", "Weekend"]);
    assert.equal(marks[a!.id].fields["Mods installed"], "Yes");
    assert.deepEqual(marks["store:steam:620"].tags, ["Weekend"]);
    const tags = (await app.inject({ url: "/api/me/tags", headers: sam.headers })).json();
    assert.deepEqual(tags.tags[0], { name: "Weekend", count: 3 });
    assert.deepEqual(tags.fields, ["Mods installed"]);
    assert.equal(ctx.journal.get(sam.user.id, b!.id).status, "backlog");
    // Removing the last mark drops the row.
    await app.inject({ method: "PATCH", url: `/api/me/marks/${b!.id}`, headers: sam.headers, payload: { tags: [] } });
    assert.equal((await app.inject({ url: "/api/me/marks", headers: sam.headers })).json()[b!.id], undefined);
    const bad = await app.inject({ method: "PATCH", url: `/api/me/marks/${encodeURIComponent("../x")}`, headers: sam.headers, payload: { favourite: true } });
    assert.equal(bad.statusCode, 400);
  });

  it("exports the library as CSV with custom fields, safe for spreadsheets", async () => {
    const { app, ctx } = await makeApp(root);
    const kim = await person(app, ctx, "kim");
    const g = ctx.library.list({})[0]!;
    await app.inject({ method: "PATCH", url: `/api/me/marks/${g.id}`, headers: kim.headers, payload: { tags: ["=cmd"], fields: { Platform: "Deck" } } });
    const csv = await app.inject({ url: "/api/me/export/library.csv", headers: kim.headers });
    assert.equal(csv.statusCode, 200);
    const lines = csv.body.replace(/^﻿/, "").split("\r\n");
    assert.ok(lines[0]!.endsWith(",Platform"));
    const row = lines.find((l) => l.startsWith(csvTitle(g.title)))!;
    assert.ok(row.includes("'=cmd"), "a formula-looking tag is defused");
    assert.ok(row.endsWith(",Deck"));
    const json = (await app.inject({ url: "/api/me/export/library.json", headers: kim.headers })).json();
    assert.equal(json.games.length, ctx.library.list({}).length);
  });
});

const csvTitle = (t: string) => (/[",]/.test(t) ? `"${t}` : t);

describe("smart shelves", () => {
  it("checks rules and fills itself for the person looking", async () => {
    assert.equal(cleanSmartRules({}), null);
    assert.equal(cleanSmartRules({ sort: "random" }), null, "a sort alone isn't a rule");
    assert.deepEqual(cleanSmartRules({ tags: ["Co-op"], minRating: "80", played: false, platform: "../x" }), { tags: ["Co-op"], minRating: 80, played: false });

    const { app, ctx } = await makeApp(root);
    const lee = await person(app, ctx, "lee");
    const games = ctx.library.list({});
    await app.inject({ method: "PATCH", url: `/api/me/marks/${games[0]!.id}`, headers: lee.headers, payload: { tags: ["Co-op"] } });
    await app.inject({ method: "PATCH", url: `/api/me/marks/${games[1]!.id}`, headers: lee.headers, payload: { tags: ["Co-op"], hidden: true } });
    const made = await app.inject({ method: "POST", url: "/api/shelves", headers: lee.headers, payload: { name: "Co-op night", rules: { tags: ["co-op"] } } });
    assert.equal(made.statusCode, 200);
    assert.deepEqual(made.json().rules, { tags: ["co-op"] });
    assert.deepEqual(
      made.json().games.map((g: { id: string }) => g.id),
      [games[0]!.id],
      "hidden games stay off",
    );
    const add = await app.inject({ method: "PUT", url: `/api/shelves/${made.json().id}/games/${games[2]!.id}`, headers: lee.headers });
    assert.equal(add.statusCode, 400);
    const plain = await app.inject({ method: "PATCH", url: `/api/shelves/${made.json().id}`, headers: lee.headers, payload: { rules: null } });
    assert.equal(plain.json().rules, null);
    assert.deepEqual(plain.json().games, []);
  });

  it("sorts and caps, and spots duplicates across stores", () => {
    const g = (id: string, title: string, rating: number) => ({ id, title, rating, genres: ["RPG"], platform: "pc", kind: "game", addedAt: "2026-01-01T00:00:00Z", releaseYear: 2020, controllerSupport: null, kidSafe: null }) as never;
    const ctx = { status: () => null, marks: () => ({ favourite: false, hidden: false, tags: [], fields: {} }), played: () => false, installed: () => false };
    const out = smartShelfGames([g("a", "A", 50), g("b", "B", 90), g("c", "C", 70)], { genres: ["rpg"], sort: "rating", limit: 2 }, ctx);
    assert.deepEqual(
      out.map((x) => x.id),
      ["b", "c"],
    );
    assert.equal(duplicateKey({ title: "The Witcher® 3: Wild Hunt - Game of the Year Edition" }), duplicateKey({ title: "The Witcher 3: Wild Hunt" }));
    assert.equal(duplicateKey({ title: "Portal 2", libraryGameId: "x" }), "lib:x");
  });
});

describe("database backups", () => {
  it("makes, lists, uploads and restores backups", async () => {
    const data = await mkdtemp(path.join(os.tmpdir(), "lootden-backup-"));
    try {
      const { app, ctx } = await makeApp(root, { dataDir: data });
      const admin = await person(app, ctx, "boss", "admin");
      const kid = await person(app, ctx, "kid");
      assert.equal((await app.inject({ url: "/api/backups", headers: kid.headers })).statusCode, 403);
      const made = (await app.inject({ method: "POST", url: "/api/backups", headers: admin.headers })).json();
      assert.equal(made.backups.length, 1);
      const name = made.backups[0].name as string;
      assert.match(name, /^lootden-\d{8}-\d{6}-manual\.db$/);
      const download = await app.inject({ url: `/api/backups/${name}`, headers: admin.headers });
      assert.equal(download.statusCode, 200);
      assert.equal(download.rawPayload.subarray(0, 15).toString(), "SQLite format 3");

      const upload = await app.inject({ method: "POST", url: "/api/backups/upload", headers: { ...admin.headers, "content-type": "application/octet-stream" }, payload: download.rawPayload });
      assert.equal(upload.statusCode, 200);
      assert.equal(upload.json().backups.length, 2);
      const junk = await app.inject({ method: "POST", url: "/api/backups/upload", headers: { ...admin.headers, "content-type": "application/octet-stream" }, payload: Buffer.from("not a database at all") });
      assert.equal(junk.statusCode, 400);
      assert.match(junk.json().error, /isn't a LootDen backup/);

      const staged = (await app.inject({ method: "POST", url: `/api/backups/${name}/restore`, headers: admin.headers })).json();
      assert.equal(staged.pendingRestore, true);
      assert.equal((await app.inject({ url: "/api/backups/..%2Fsecret.key", headers: admin.headers })).statusCode, 400);

      // The next start swaps it in, keeping the old database.
      const live = path.join(data, "lootden.db");
      openDatabase(live).close();
      assert.equal(applyPendingRestore(data, live), true);
      assert.ok(existsSync(`${live}.before-restore`));
      assert.ok(!existsSync(path.join(data, PENDING_RESTORE)));
      const restored = openDatabase(live);
      assert.ok((restored.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n >= 2);
      restored.close();

      ctx.backups.setSettings({ keep: 1 });
      await ctx.backups.prune();
      assert.equal((await ctx.backups.list()).length, 1);
      await writeFile(path.join(data, "bogus.db"), "x");
      await copyFile(path.join(data, "bogus.db"), path.join(data, PENDING_RESTORE));
      assert.throws(() => applyPendingRestore(data, live), /isn't a LootDen backup/);
      assert.ok((await readFile(live)).subarray(0, 15).toString() === "SQLite format 3", "a bad restore leaves the database alone");
      assert.ok(BackupService);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});
