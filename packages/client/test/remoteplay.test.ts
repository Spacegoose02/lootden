import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { mergeXboxCopies, isStreamFit, isXboxConsoleId, isXboxPlayUrl, isXboxRemoteStreamUrl, isXboxStreamUrl, nextStreamFit, streamFitCss, xboxRemotePlayUrl } from "@lootden/shared";
import type { SevenZip } from "../src/extractor.js";
import { greenlightCommand, greenlightHome, greenlightState, installGreenlight, removeGreenlight, GREENLIGHT_FLATPAK } from "../src/greenlight.js";

const sevenZip: SevenZip = { path: "/nonexistent/7za", supportsRar: false };

let root = "";
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "lootden-remoteplay-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Xbox remote play addresses", () => {
  it("takes a console id only in Xbox's own format", () => {
    assert.ok(isXboxConsoleId("F4001A2B3C4D5E6F"));
    assert.ok(isXboxConsoleId("f4001a2b3c4d5e6f"));
    assert.ok(!isXboxConsoleId("F4001A2B3C4D5E6"));
    assert.ok(!isXboxConsoleId("G4001A2B3C4D5E6F"));
    assert.ok(!isXboxConsoleId(""));
  });

  it("streams one console when it knows which, else opens the console list", () => {
    assert.equal(xboxRemotePlayUrl("f4001a2b3c4d5e6f"), "https://www.xbox.com/play/consoles/launch/F4001A2B3C4D5E6F");
    assert.equal(xboxRemotePlayUrl(null), "https://www.xbox.com/play/consoles");
    // A made-up id would open a page that can't stream: the console list is the honest fallback.
    assert.equal(xboxRemotePlayUrl("my console"), "https://www.xbox.com/play/consoles");
  });

  it("knows an Xbox play page, a stream, and a remote play stream apart", () => {
    const list = "https://www.xbox.com/play/consoles";
    const remote = "https://www.xbox.com/play/consoles/launch/F4001A2B3C4D5E6F";
    const cloud = "https://www.xbox.com/en-US/play/launch/forza-horizon-5/9NKX70BBCDRN";
    for (const url of [list, remote, cloud]) assert.ok(isXboxPlayUrl(url), url);
    assert.ok(!isXboxPlayUrl("https://www.xbox.com/consoles/remote-play"));
    assert.ok(!isXboxPlayUrl("https://xbox.com.example.com/play"));
    assert.ok(!isXboxPlayUrl("http://www.xbox.com/play"));
    assert.deepEqual([list, remote, cloud].map(isXboxStreamUrl), [false, true, true]);
    assert.deepEqual([list, remote, cloud].map(isXboxRemoteStreamUrl), [false, true, false]);
    // Xbox's player moved to play.xbox.com; xbox.com/play forwards there.
    const playList = "https://play.xbox.com/remoteplay";
    const playRemote = "https://play.xbox.com/remoteplay/F4001A2B3C4D5E6F";
    assert.ok(isXboxPlayUrl(playList) && isXboxPlayUrl(playRemote));
    assert.ok(!isXboxPlayUrl("https://play.xbox.com.example.com/remoteplay/F4001A2B3C4D5E6F"));
    assert.deepEqual([playList, playRemote].map(isXboxStreamUrl), [false, true]);
    assert.deepEqual([playList, playRemote].map(isXboxRemoteStreamUrl), [false, true]);
  });
});

describe("how the stream fills a wide screen", () => {
  it("steps through the fit modes", () => {
    assert.equal(nextStreamFit("fit"), "zoom");
    assert.equal(nextStreamFit("zoom"), "stretch");
    assert.equal(nextStreamFit("stretch"), "fit");
    assert.ok(isStreamFit("zoom"));
    assert.ok(!isStreamFit("cover"));
    assert.ok(!isStreamFit(undefined));
  });

  it("pins the stream to the window, and crops or widens it", () => {
    assert.match(streamFitCss("fit"), /object-fit: contain !important/);
    assert.match(streamFitCss("zoom")!, /object-fit: cover !important/);
    assert.match(streamFitCss("stretch")!, /object-fit: fill !important/);
    // Pinned to the window, so a 16:9 box around the video can't keep the bars.
    assert.match(streamFitCss("zoom")!, /position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important/);
    // The style has to beat Xbox's own sizing on the video itself.
    for (const fit of ["fit", "zoom", "stretch"] as const) assert.match(streamFitCss(fit), /video \{ position: fixed/);
  });
});

describe("Greenlight", () => {
  const release = (tag: string) => [
    {
      tag_name: tag,
      prerelease: false,
      draft: false,
      assets: [
        {
          name: `Greenlight-Setup-${tag.replace(/^v/, "")}.exe`,
          browser_download_url: `https://github.com/unknownskl/greenlight/releases/download/${tag}/setup.exe`,
        },
        {
          name: `Greenlight-${tag.replace(/^v/, "")}-win.zip`,
          browser_download_url: `https://github.com/unknownskl/greenlight/releases/download/${tag}/win.zip`,
        },
        {
          name: `Greenlight-${tag.replace(/^v/, "")}.AppImage`,
          browser_download_url: `https://github.com/unknownskl/greenlight/releases/download/${tag}/app.AppImage`,
        },
      ],
    },
  ];

  function fakeFetch(tag = "v2.4.2") {
    const got: string[] = [];
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("api.github.com")) return new Response(JSON.stringify(release(tag)));
      got.push(String(url));
      return new Response("app");
    }) as unknown as typeof fetch;
    return { fetchImpl, got };
  }

  it("downloads the Linux AppImage, makes it runnable and remembers it", async () => {
    const toolsDir = path.join(root, "linux");
    const { fetchImpl, got } = fakeFetch();
    const done = await installGreenlight({
      toolsDir,
      sevenZip,
      fetchImpl,
      platform: "linux",
      flatpaks: async () => new Set(),
    });
    assert.equal(path.basename(done.exe), "Greenlight-2.4.2.AppImage");
    assert.equal(done.version, "v2.4.2");
    assert.deepEqual(got, ["https://github.com/unknownskl/greenlight/releases/download/v2.4.2/app.AppImage"]);
    assert.equal((await stat(done.exe)).mode & 0o111, 0o111);
    const manifest = JSON.parse(await readFile(path.join(toolsDir, "lootden-tools.json"), "utf8")) as { greenlight: { version: string; exe: string } };
    assert.equal(manifest.greenlight.version, "v2.4.2");
    // The program is remembered inside the tools folder, so the folder can move.
    assert.ok(!path.isAbsolute(manifest.greenlight.exe));

    const state = await greenlightState({
      toolsDir,
      platform: "linux",
      flatpaks: async () => new Set(),
    });
    assert.deepEqual([state.supported, state.version, state.managed], [true, "v2.4.2", true]);
    assert.equal(state.exe, done.exe);

    // An update replaces the AppImage rather than leaving both versions behind.
    const next = fakeFetch("v2.5.0");
    const updated = await installGreenlight({
      toolsDir,
      sevenZip,
      fetchImpl: next.fetchImpl,
      platform: "linux",
      flatpaks: async () => new Set(),
    });
    assert.equal(path.basename(updated.exe), "Greenlight-2.5.0.AppImage");
    await assert.rejects(stat(done.exe));

    await removeGreenlight(toolsDir);
    assert.equal(
      (
        await greenlightState({
          toolsDir,
          platform: "linux",
          flatpaks: async () => new Set(),
        })
      ).exe,
      null,
    );
    await assert.rejects(stat(greenlightHome(toolsDir)));
  });

  it("uses a Flatpak copy on Linux instead of downloading", async () => {
    const toolsDir = path.join(root, "flatpak");
    const { fetchImpl, got } = fakeFetch();
    const done = await installGreenlight({
      toolsDir,
      sevenZip,
      fetchImpl,
      platform: "linux",
      flatpaks: async () => new Set([GREENLIGHT_FLATPAK]),
    });
    assert.deepEqual([done.exe, done.version], [`flatpak:${GREENLIGHT_FLATPAK}`, "Flatpak"]);
    assert.deepEqual(got, []);
    const state = await greenlightState({
      toolsDir,
      platform: "linux",
      flatpaks: async () => new Set([GREENLIGHT_FLATPAK]),
    });
    assert.deepEqual([state.exe, state.managed], [`flatpak:${GREENLIGHT_FLATPAK}`, false]);
  });

  it("takes the portable Windows build, not the installer", async () => {
    const toolsDir = path.join(root, "win");
    const { fetchImpl, got } = fakeFetch();
    // 7-Zip isn't there in tests: the unpack fails, but the asset it picked is what matters.
    await assert.rejects(installGreenlight({ toolsDir, sevenZip, fetchImpl, platform: "win32" }));
    assert.deepEqual(got, ["https://github.com/unknownskl/greenlight/releases/download/v2.4.2/win.zip"]);
  });

  it("forgets a copy that isn't on this PC any more", async () => {
    const toolsDir = path.join(root, "gone");
    const { fetchImpl } = fakeFetch();
    const done = await installGreenlight({
      toolsDir,
      sevenZip,
      fetchImpl,
      platform: "linux",
      flatpaks: async () => new Set(),
    });
    await rm(done.exe, { force: true });
    assert.equal(
      (
        await greenlightState({
          toolsDir,
          platform: "linux",
          flatpaks: async () => new Set(),
        })
      ).exe,
      null,
    );
  });

  it("builds the command that streams one console", async () => {
    assert.deepEqual(greenlightCommand("C:\\Tools\\greenlight\\Greenlight.exe", "f4001a2b3c4d5e6f"), {
      cmd: "C:\\Tools\\greenlight\\Greenlight.exe",
      args: ["--fullscreen", "--connect=F4001A2B3C4D5E6F"],
    });
    assert.deepEqual(
      greenlightCommand("/tools/Greenlight.AppImage", null, {
        fullscreen: false,
      }),
      { cmd: "/tools/Greenlight.AppImage", args: [] },
    );
    assert.deepEqual(greenlightCommand(`flatpak:${GREENLIGHT_FLATPAK}`, "F4001A2B3C4D5E6F"), {
      cmd: "flatpak",
      args: ["run", GREENLIGHT_FLATPAK, "--fullscreen", "--connect=F4001A2B3C4D5E6F"],
    });
  });

  it("finds Greenlight the person installed themselves on Windows", async (t) => {
    const local = path.join(root, "local-programs");
    const programs = path.join(local, "Programs", "greenlight");
    await mkdir(programs, { recursive: true });
    await writeFile(path.join(programs, "Greenlight.exe"), "");
    t.after(() => {
      delete process.env.LOCALAPPDATA;
    });
    process.env.LOCALAPPDATA = local;
    const state = await greenlightState({
      toolsDir: path.join(root, "nothing-here"),
      platform: "win32",
      flatpaks: async () => new Set(),
    });
    assert.equal(state.exe, path.join(programs, "Greenlight.exe"));
    assert.equal(state.managed, false);
  });
});

describe("Xbox games listed twice", () => {
  const game = (addon: string, id: string, extra: Record<string, unknown> = {}) => ({ addon, externalId: id, title: `Game ${id}`, coverUrl: null as string | null, storeUrl: null as string | null, playtimeSeconds: null as number | null, lastPlayedAt: null as string | null, ...extra });

  it("keeps the console's copy, with what the other copy knows", () => {
    const merged = mergeXboxCopies([
      game("xbox", "1", { coverUrl: "https://a/gta.png", storeUrl: "https://xbox.com/gta", playtimeSeconds: 3600, lastPlayedAt: "2026-11-20T10:00:00Z" }),
      game("xbox-console", "1", { lastPlayedAt: "2026-11-01T10:00:00Z" }),
      game("xbox", "2"),
      game("steam", "1"),
    ]);
    assert.deepEqual(merged.map((g) => `${g.addon}:${g.externalId}`), ["xbox-console:1", "xbox:2", "steam:1"]);
    assert.deepEqual([merged[0]!.coverUrl, merged[0]!.storeUrl, merged[0]!.playtimeSeconds, merged[0]!.lastPlayedAt], ["https://a/gta.png", "https://xbox.com/gta", 3600, "2026-11-20T10:00:00Z"]);
  });

  it("leaves a copy installed on this PC alone", () => {
    const games = [game("xbox", "1"), game("xbox-console", "1")];
    assert.equal(mergeXboxCopies(games, (g) => g.addon === "xbox").length, 2);
  });
});
