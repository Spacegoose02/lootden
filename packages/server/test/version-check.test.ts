import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { makeApp } from "./helpers.js";

/** GOG says the current installer is 1.6. */
const gogFetch: typeof fetch = async (input) => {
  const url = String(input);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.startsWith("https://embed.gog.com/")) return json({ products: [{ id: 1, title: "Stardew Valley", url: "/game/stardew_valley" }] });
  if (url.startsWith("https://api.gog.com/products/1")) return json({ downloads: { installers: [{ os: "windows", version: "1.6" }] } });
  throw new Error(`Unexpected network call in test: ${url}`);
};

describe("update checks", () => {
  it("counts an update in the library as the version the library has", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gm-versions-"));
    await mkdir(path.join(root, "Stardew Valley v1.5"));
    await writeFile(path.join(root, "Stardew Valley v1.5", "setup.exe"), "exe");
    const { ctx, db } = await makeApp(root, {}, { fetchImpl: gogFetch });
    const game = ctx.library.list().find((g) => g.title.startsWith("Stardew Valley"))!;

    // Only the 1.5 copy: behind GOG's 1.6.
    const before = await ctx.versions.check(game.id);
    assert.deepEqual([before.current, before.behind], ["1.5", true]);

    // The 1.5 to 1.6 patch arrives: the stored answer is out of date and a new check says current.
    await mkdir(path.join(root, "Stardew Valley v1.5 to v1.6 Patch"));
    await writeFile(path.join(root, "Stardew Valley v1.5 to v1.6 Patch", "patch.exe"), "patch");
    await ctx.library.rescan();
    assert.equal(ctx.versions.stale(ctx.versions.get(game.id)!), true);
    const after = await ctx.versions.check(game.id);
    assert.deepEqual([after.current, after.behind], ["1.6", false]);
    assert.equal(ctx.versions.stale(after), false);
    db.close();
  });
});
