import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import { makeApp } from "./helpers.js";

const SONIC_ROM = Buffer.from("SEGA GENESIS sonic rom bytes");
let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gm-retro-"));
  await mkdir(path.join(root, "Emulation", "genesis"), { recursive: true });
  await mkdir(path.join(root, "Emulation", "nes"), { recursive: true });
  await mkdir(path.join(root, "Emulation", "snes"), { recursive: true });
  // The file name is deliberately unhelpful: ScreenScraper has to match it by checksum.
  await writeFile(path.join(root, "Emulation", "genesis", "sth1 (U) [!].md"), SONIC_ROM);
  await writeFile(path.join(root, "Emulation", "nes", "Super Mario Bros. (World).nes"), "nes rom");
  await writeFile(path.join(root, "Emulation", "snes", "Super Metroid (USA).sfc"), "snes rom");
});
after(() => rm(root, { recursive: true, force: true }));

type Reply = { status?: number; body: unknown; type?: string } | undefined;

function fake(handler: (url: URL) => Reply) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const r = handler(url);
    if (!r) return new Response("not found", { status: 404 });
    const raw = r.body instanceof Uint8Array;
    return new Response(raw ? Buffer.from(r.body as Uint8Array) : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": r.type ?? (raw ? "image/png" : "application/json") },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const SS_CREDS = { devId: "dev", devPassword: "devpass", username: "me", password: "mypass" };
const media = (type: string, region: string) => ({
  type,
  region,
  url: `https://neoclone.screenscraper.fr/api2/mediaJeu.php?devid=dev&devpassword=devpass&softname=LootDen&ssid=me&sspassword=mypass&systemeid=1&jeuid=1&media=${type}(${region})`,
});
const SONIC_SS = {
  id: "1",
  noms: [{ region: "jp", text: "Sonic the Hedgehog (JP)" }, { region: "us", text: "Sonic The Hedgehog" }],
  synopsis: [{ langue: "fr", text: "Un hérisson." }, { langue: "en", text: "A fast hedgehog." }],
  dates: [{ region: "us", text: "1991-06-23" }],
  genres: [{ noms: [{ langue: "en", text: "Platform" }] }],
  note: { text: "17" },
  classifications: [{ type: "ESRB", text: "E" }],
  medias: [media("box-2D", "jp"), media("box-2D", "us"), media("ss", "wor")],
};

function screenscraper(url: URL): Reply {
  if (url.host !== "api.screenscraper.fr" && url.host !== "neoclone.screenscraper.fr") return undefined;
  if (url.host === "neoclone.screenscraper.fr") return url.searchParams.get("devid") === "dev" ? { body: PNG } : { status: 401, body: "login" };
  if (url.searchParams.get("devid") !== "dev" || url.searchParams.get("ssid") !== "me") return { status: 403, body: "Erreur de login" };
  if (url.pathname.endsWith("/jeuInfos.php")) {
    const md5 = createHash("md5").update(SONIC_ROM).digest("hex");
    if (url.searchParams.get("md5") === md5 && url.searchParams.get("systemeid") === "1") return { body: { response: { jeu: SONIC_SS } } };
    return { status: 404, body: "Erreur : Rom/Iso/Dossier non trouvée !" };
  }
  if (url.pathname.endsWith("/jeuRecherche.php")) return { body: { response: { jeux: [{}] } } };
  return undefined;
}

function thegamesdb(url: URL): Reply {
  if (url.host !== "api.thegamesdb.net") return undefined;
  if (url.searchParams.get("apikey") !== "tgdb-key") return { status: 403, body: { status: "Invalid API key" } };
  const boxart = { base_url: { original: "https://cdn.thegamesdb.net/images/original/", medium: "https://cdn.thegamesdb.net/images/medium/" }, data: { "140": [{ type: "boxart", side: "front", filename: "boxart/front/140-1.jpg" }] } };
  if (url.pathname === "/v1/Games/ByGameName") {
    const nes = url.searchParams.get("filter[platform]") === "7" && /mario/i.test(url.searchParams.get("name") ?? "");
    return { body: { data: { games: nes ? [{ id: 140, game_title: "Super Mario Bros.", release_date: "1985-09-13", platform: 7 }] : [] }, include: { boxart } } };
  }
  if (url.pathname === "/v1/Games/ByGameID" && url.searchParams.get("id") === "140") {
    return { body: { data: { games: [{ id: 140, game_title: "Super Mario Bros.", release_date: "1985-09-13", players: 2, rating: "E - Everyone", genres: [1], overview: null }] }, include: { boxart } } };
  }
  if (url.pathname === "/v1/Genres") return { body: { data: { genres: { "1": { id: 1, name: "Platform" } } } } };
  if (url.pathname === "/v1/Games/Images") return { body: { data: { base_url: { original: "https://cdn.thegamesdb.net/images/original/" }, images: { "140": [{ type: "screenshot", filename: "screenshots/140-1.jpg" }] } } } };
  return undefined;
}

/** A minimal deflated zip holding one file, like LaunchBox's Metadata.zip. */
function zip(name: string, content: string): Buffer {
  const data = deflateRawSync(Buffer.from(content));
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + n.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + n.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}

const METADATA_XML = `<?xml version="1.0" standalone="yes"?>
<LaunchBox>
  <Platform><Name>Super Nintendo Entertainment System</Name></Platform>
  <Game>
    <Name>Super Metroid</Name>
    <ReleaseDate>1994-03-19T00:00:00-08:00</ReleaseDate>
    <ReleaseYear>1994</ReleaseYear>
    <Overview>Samus &amp; the last Metroid.</Overview>
    <MaxPlayers>1</MaxPlayers>
    <DatabaseID>1234</DatabaseID>
    <CommunityRating>4.6</CommunityRating>
    <Platform>Super Nintendo Entertainment System</Platform>
    <ESRB>E - Everyone</ESRB>
    <Genres>Action; Platform</Genres>
  </Game>
  <Game>
    <Name>Super Metroid</Name>
    <DatabaseID>999</DatabaseID>
    <Platform>Windows</Platform>
  </Game>
  <Game>
    <Name>Super Mario Bros.</Name>
    <Overview>Mushroom Kingdom adventure.</Overview>
    <DatabaseID>77</DatabaseID>
    <Platform>Nintendo Entertainment System</Platform>
  </Game>
  <GameAlternateName><AlternateName>Metroid III</AlternateName><DatabaseID>1234</DatabaseID><Region>Japan</Region></GameAlternateName>
  <GameImage><DatabaseID>1234</DatabaseID><FileName>a1b2-c3.jpg</FileName><Type>Box - Front</Type><Region>Japan</Region></GameImage>
  <GameImage><DatabaseID>1234</DatabaseID><FileName>d4e5-f6.png</FileName><Type>Box - Front</Type><Region>North America</Region></GameImage>
  <GameImage><DatabaseID>1234</DatabaseID><FileName>shot.png</FileName><Type>Screenshot - Gameplay</Type></GameImage>
  <GameImage><DatabaseID>1234</DatabaseID><FileName>logo.png</FileName><Type>Clear Logo</Type></GameImage>
</LaunchBox>`;

function launchbox(url: URL): Reply {
  if (url.host === "gamesdb.launchbox-app.com" && url.pathname === "/Metadata.zip") return { body: zip("Metadata.xml", METADATA_XML), type: "application/zip" };
  return undefined;
}

const gameOn = (ctx: Awaited<ReturnType<typeof makeApp>>["ctx"], platform: string) => ctx.library.list({}).find((g) => g.platform === platform)!;

describe("retro metadata sources", () => {
  it("matches a ROM on ScreenScraper by checksum and keeps the credentials out of stored and browser links", async () => {
    const f = fake(screenscraper);
    const { ctx, app, db } = await makeApp(root, { apiToken: "svc", screenscraper: SS_CREDS }, { fetchImpl: f.impl });
    const sonic = gameOn(ctx, "genesis");
    await ctx.metadata.autoMatch(sonic.id);
    const game = ctx.library.get(sonic.id)!;
    assert.equal(game.metadata?.provider, "screenscraper");
    assert.equal(game.title, "Sonic The Hedgehog", "US name preferred");
    assert.equal(game.metadata?.summary, "A fast hedgehog.");
    assert.equal(game.rating, 85);
    assert.deepEqual(game.genres, ["Platform"]);

    const row = db.prepare("SELECT cover_url, screenshots FROM metadata WHERE game_id = ?").get(sonic.id) as { cover_url: string; screenshots: string };
    assert.match(row.cover_url, /media=box-2D\(us\)/);
    assert.doesNotMatch(row.cover_url + row.screenshots, /devpass|mypass|devid/);
    assert.equal(game.metadata?.screenshots[0], `/api/games/${sonic.id}/screenshots/0`);
    assert.doesNotMatch(JSON.stringify(game), /screenscraper\.fr/);

    const headers = { authorization: "Bearer svc" };
    const cover = await app.inject({ url: `/api/games/${sonic.id}/cover`, headers });
    assert.equal(cover.statusCode, 200, "the server adds the credentials back when it downloads the image");
    const shot = await app.inject({ url: `/api/games/${sonic.id}/screenshots/0`, headers });
    assert.equal(shot.statusCode, 200);
    assert.equal((await app.inject({ url: `/api/games/${sonic.id}/screenshots/5`, headers })).statusCode, 404);
    await app.close();
  });

  it("matches with TheGamesDB on the right platform", async () => {
    const f = fake(thegamesdb);
    const { ctx } = await makeApp(root, { thegamesdb: { apiKey: "tgdb-key" } }, { fetchImpl: f.impl });
    const mario = gameOn(ctx, "nes");
    await ctx.metadata.autoMatch(mario.id);
    const m = ctx.library.get(mario.id)!.metadata!;
    assert.equal(m.provider, "thegamesdb");
    assert.equal(m.coverUrl, "https://cdn.thegamesdb.net/images/original/boxart/front/140-1.jpg");
    assert.deepEqual(m.screenshots, ["https://cdn.thegamesdb.net/images/original/screenshots/140-1.jpg"]);
    assert.deepEqual(m.genres, ["Platform"]);
    assert.deepEqual(m.ageRatings, [{ organization: "ESRB", rating: "E" }]);
    assert.deepEqual(m.gameModes, ["Multiplayer"]);
  });

  it("downloads and searches the LaunchBox database locally, including alternate names", async () => {
    const f = fake(launchbox);
    const { ctx } = await makeApp(root, { launchbox: { enabled: true } }, { fetchImpl: f.impl });
    await ctx.metadata.launchbox.refresh();
    assert.equal(await ctx.metadata.launchbox.count(), 3);
    assert.match(await ctx.metadata.test("launchbox"), /3 games/);

    const metroid = gameOn(ctx, "snes");
    await ctx.metadata.autoMatch(metroid.id);
    const m = ctx.library.get(metroid.id)!.metadata!;
    assert.equal(m.provider, "launchbox");
    assert.equal(m.providerId, "1234", "the SNES game, not the Windows one");
    assert.equal(m.summary, "Samus & the last Metroid.");
    assert.equal(m.coverUrl, "https://images.launchbox-app.com/d4e5-f6.png", "North American box first");
    assert.deepEqual(m.screenshots, ["https://images.launchbox-app.com/shot.png"]);
    assert.deepEqual(m.genres, ["Action", "Platform"]);
    assert.equal(m.releaseDate, "1994-03-19");
    assert.equal(m.rating, 92);

    const alt = await ctx.metadata.search("Metroid III", null, "snes");
    assert.equal(alt[0]?.providerId, "1234");
    ctx.metadata.launchbox.close();
  });

  it("follows the admin's source order and fills missing details from the next source", async () => {
    const f = fake((url) => screenscraper(url) ?? thegamesdb(url) ?? launchbox(url));
    const { ctx, app } = await makeApp(
      root,
      { apiToken: "svc", screenscraper: SS_CREDS, thegamesdb: { apiKey: "tgdb-key" }, launchbox: { enabled: true } },
      { fetchImpl: f.impl },
    );
    const headers = { authorization: "Bearer svc" };
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/integrations",
      headers,
      payload: {
        metadataOrder: {
          emulated: [
            { id: "thegamesdb", on: true },
            { id: "launchbox", on: true },
            { id: "screenscraper", on: false },
          ],
        },
      },
    });
    assert.equal(put.statusCode, 200);
    const view = put.json();
    assert.deepEqual(
      view.settings.metadataOrder.emulated.map((e: { id: string; on: boolean }) => `${e.id}:${e.on}`),
      ["thegamesdb:true", "launchbox:true", "screenscraper:false", "igdb:true", "rawg:true", "steam:false"],
      "missing sources are appended with their defaults",
    );
    assert.ok(view.ready.includes("screenscraper") && view.ready.includes("launchbox") && !view.ready.includes("igdb"));
    await ctx.metadata.launchbox.refresh();

    const mario = gameOn(ctx, "nes");
    await ctx.metadata.autoMatch(mario.id);
    const m = ctx.library.get(mario.id)!.metadata!;
    assert.equal(m.provider, "thegamesdb");
    assert.equal(m.summary, "Mushroom Kingdom adventure.", "TheGamesDB had no description, LaunchBox filled it");

    // ScreenScraper is off for emulated games now, so the Genesis ROM goes unmatched.
    const sonic = gameOn(ctx, "genesis");
    const before = f.calls.length;
    assert.equal(await ctx.metadata.autoMatch(sonic.id), null);
    assert.ok(!f.calls.slice(before).some((c) => c.includes("screenscraper")));
    ctx.metadata.launchbox.close();
    await app.close();
  });

  it("masks the new secrets and tests each source", async () => {
    const f = fake((url) => screenscraper(url) ?? thegamesdb(url));
    const { app } = await makeApp(root, { apiToken: "svc" }, { fetchImpl: f.impl });
    const headers = { authorization: "Bearer svc" };
    const view = (
      await app.inject({
        method: "PUT",
        url: "/api/settings/integrations",
        headers,
        payload: { screenscraper: SS_CREDS, thegamesdb: { apiKey: "tgdb-key" } },
      })
    ).json();
    assert.equal(view.settings.screenscraper.devId, "dev");
    assert.equal(view.settings.screenscraper.devPassword, "********");
    assert.equal(view.settings.screenscraper.password, "********");
    assert.equal(view.settings.thegamesdb.apiKey, "********");

    const ss = await app.inject({ method: "POST", url: "/api/settings/integrations/screenscraper/test", headers });
    assert.equal(ss.statusCode, 200, ss.body);
    const tg = await app.inject({ method: "POST", url: "/api/settings/integrations/thegamesdb/test", headers });
    assert.match(tg.json().message, /1 results/);
    const lb = await app.inject({ method: "POST", url: "/api/settings/integrations/launchbox/test", headers });
    assert.equal(lb.statusCode, 502);
    await app.close();
  });
});
