import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { browserRomFile, platformFor } from "@lootden/shared";
import { makeApp, makeLibrary, sessionCookie } from "./helpers.js";

let root: string;
let site: string;
before(async () => {
  root = await makeLibrary();
  await mkdir(path.join(root, "Emulation", "ps2"), { recursive: true });
  await writeFile(path.join(root, "Emulation", "ps2", "Okami (USA).iso"), "0123456789");
  site = await mkdtemp(path.join(os.tmpdir(), "gm-sites-"));
  await mkdir(path.join(site, "ps2"));
  await writeFile(path.join(site, "ps2", "index.html"), "<!doctype html><title>TabStationToo</title>");
  await writeFile(path.join(site, "ps2", "pcsx2-wasm.js"), "// emulator");
  await mkdir(path.join(site, "web"));
  await writeFile(path.join(site, "web", "index.html"), "<!doctype html><title>LootDen</title>");
});
after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(site, { recursive: true, force: true });
});

type App = Awaited<ReturnType<typeof makeApp>>;

async function person(app: App["app"], ctx: App["ctx"], username: string, role: "admin" | "user" = "user") {
  await ctx.users.create({ username, password: "password123", role });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
  return { cookie: sessionCookie(login) };
}

describe("PS2 in the browser", () => {
  it("picks a disc TabStationToo can read", () => {
    const ps2 = platformFor("ps2");
    assert.equal(browserRomFile([{ path: "Okami.iso", index: 0 }], ps2)?.path, "Okami.iso");
    assert.equal(browserRomFile([{ path: "a.cue", index: 0 }, { path: "a.bin", index: 1 }], ps2)?.path, "a.bin");
    assert.equal(browserRomFile([{ path: "a.cue", index: 0 }, { path: "a (Track 1).bin", index: 1 }, { path: "a (Track 2).bin", index: 2 }], ps2), null);
    assert.equal(browserRomFile([{ path: "Okami.7z", index: 0 }], ps2), null, "archives need the desktop app");
  });

  it("serves the emulator isolated, opens games in it, and follows the admin's switch", async () => {
    const { app, ctx } = await makeApp(root, {}, { ps2Dir: path.join(site, "ps2"), webDir: path.join(site, "web") });
    const admin = await person(app, ctx, "boss", "admin");
    const kid = await person(app, ctx, "kid");
    const okami = ctx.library.list({}).find((g) => g.platform === "ps2")!;
    const status = () => app.inject({ url: "/api/emulation/ps2-browser", headers: kid }).then((r) => r.json());

    // The emulator's files: cross-origin isolated, so its threads can share memory.
    const page = await app.inject({ url: "/emulators/ps2/index.html" });
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(page.headers["cross-origin-embedder-policy"], "require-corp");
    assert.equal(page.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal((await app.inject({ url: "/emulators/ps2/pcsx2-wasm.js" })).headers["cross-origin-embedder-policy"], "require-corp");

    // No BIOS yet: the play route says what's missing.
    assert.deepEqual(await status(), { enabled: true, installed: true, bios: null, available: false, reason: "An admin needs to upload a PS2 BIOS under Emulation, Emulators and BIOS." });
    const noBios = await app.inject({ url: `/api/games/${okami.id}/play`, headers: kid });
    assert.equal(noBios.statusCode, 400);
    assert.match(noBios.json().error, /PS2 BIOS/);

    const put = (name: string, bytes: number) =>
      app.inject({ method: "PUT", url: `/api/emulation/bios/${name}`, headers: { ...admin, "content-type": "application/octet-stream" }, payload: Buffer.alloc(bytes, 1) });
    // A PS1 BIOS fits the name pattern but not the size.
    assert.equal((await put("scph5501.bin", 512 * 1024)).statusCode, 200);
    assert.equal((await status()).available, false);
    // SCPH-39001.bin reads as a PS1 BIOS by name; its 4 MB says PS2.
    assert.equal((await put("SCPH-39001.bin", 4 * 1024 * 1024)).statusCode, 200);
    assert.equal((await status()).bios, "SCPH-39001.bin");
    assert.equal((await status()).available, true);

    // Play: TabStationToo's page with this server's BIOS and disc, which streams in byte ranges.
    const play = await app.inject({ url: `/api/games/${okami.id}/play`, headers: kid });
    assert.equal(play.statusCode, 302);
    const target = new URL(play.headers.location!, "http://lootden");
    assert.equal(target.pathname, "/emulators/ps2/index.html");
    assert.equal(target.searchParams.get("bios"), "/api/emulation/bios/SCPH-39001.bin");
    assert.equal(target.searchParams.get("disc"), `/api/games/${okami.id}/files/0/Okami%20(USA).iso`);
    const range = await app.inject({ url: target.searchParams.get("disc")!, headers: { ...kid, range: "bytes=2-5" } });
    assert.equal(range.statusCode, 206);
    assert.equal(range.body, "2345");

    // LootDen's play page around it is isolated too, but only for PS2 games.
    const shell = await app.inject({ url: `/play/${okami.id}`, headers: kid });
    assert.equal(shell.statusCode, 200);
    assert.equal(shell.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(shell.headers["cross-origin-embedder-policy"], "credentialless");
    const pc = ctx.library.list({}).find((g) => g.platform === "pc")!;
    assert.equal((await app.inject({ url: `/play/${pc.id}`, headers: kid })).headers["cross-origin-embedder-policy"], undefined);
    assert.equal((await app.inject({ url: "/library", headers: kid })).headers["cross-origin-embedder-policy"], undefined);

    // Only admins flip the switch; off, the button's status, the play route and the files all say no.
    assert.equal((await app.inject({ method: "PUT", url: "/api/emulation/settings", headers: kid, payload: { ps2Browser: false } })).statusCode, 403);
    assert.equal((await app.inject({ method: "PUT", url: "/api/emulation/settings", headers: admin, payload: { ps2Browser: "no" } })).statusCode, 400);
    const off = await app.inject({ method: "PUT", url: "/api/emulation/settings", headers: admin, payload: { ps2Browser: false } });
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().enabled, false);
    assert.equal((await status()).available, false);
    assert.equal((await app.inject({ url: `/api/games/${okami.id}/play`, headers: kid })).statusCode, 403);
    assert.equal((await app.inject({ url: "/emulators/ps2/index.html" })).statusCode, 404);
    assert.equal((await app.inject({ url: `/play/${okami.id}`, headers: kid })).headers["cross-origin-embedder-policy"], undefined);
    assert.equal((await app.inject({ url: "/api/emulation", headers: admin })).json().ps2Browser.enabled, false);

    await app.inject({ method: "PUT", url: "/api/emulation/settings", headers: admin, payload: { ps2Browser: true } });
    assert.equal((await status()).available, true);
    await app.close();
  });

  it("says so when the image doesn't include the emulator", async () => {
    const { app, ctx } = await makeApp(root, {}, { ps2Dir: path.join(site, "missing") });
    const kid = await person(app, ctx, "kid");
    const okami = ctx.library.list({}).find((g) => g.platform === "ps2")!;
    const s = (await app.inject({ url: "/api/emulation/ps2-browser", headers: kid })).json();
    assert.equal(s.installed, false);
    assert.equal(s.available, false);
    assert.equal((await app.inject({ url: `/api/games/${okami.id}/play`, headers: kid })).statusCode, 403);
    assert.equal((await app.inject({ url: "/emulators/ps2/index.html" })).statusCode, 404);
    await app.close();
  });
});
