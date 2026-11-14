import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildKind, ClientDownloads, compareVersions, fileVersion, outdated } from "../src/clients/store.js";

// The downloads list an admin had built up before old builds were pruned.
const BACKLOG = [
  "LootDen-Setup-0.37.0.exe",
  "LootDen-Setup-0.36.0.exe",
  "LootDen-0.37.0-portable.exe",
  "lootden-cli-win-x64.zip",
  "LootDen-0.33.0-linux-amd64.deb",
  "LootDen-0.33.0-linux-x86_64.AppImage",
  "LootDen-0.34.0-linux-amd64.deb",
  "LootDen-0.34.0-linux-x86_64.AppImage",
  "LootDen-0.35.0-linux-amd64.deb",
  "LootDen-0.35.0-linux-arm64.deb",
  "LootDen-0.35.0-linux-x86_64.AppImage",
  "LootDen-0.36.0-linux-amd64.deb",
  "LootDen-0.36.0-linux-arm64.deb",
  "LootDen-0.36.0-linux-x86_64.AppImage",
  "LootDen-0.37.0-linux-amd64.deb",
  "LootDen-0.37.0-linux-arm64.deb",
  "LootDen-0.37.0-linux-x86_64.AppImage",
  "LootDen-linux-arm64-0.35.0.AppImage",
  "LootDen-linux-arm64-0.36.0.AppImage",
  "LootDen-linux-arm64-0.37.0.AppImage",
  "lootden-cli-linux-arm64.tar.gz",
  "lootden-cli-linux-x64.tar.gz",
  "LootDen-0.33.0.apk",
  "LootDen-0.37.0.apk",
  "LootDen-Playnite-0.37.0.pext",
];

describe("pruning old app builds", () => {
  it("reads versions without mistaking arch tags for them", () => {
    assert.equal(fileVersion("LootDen-0.35.0-linux-x86_64.AppImage"), "0.35.0");
    assert.equal(fileVersion("LootDen-linux-arm64-0.35.0.AppImage"), "0.35.0");
    assert.equal(fileVersion("LootDen-Setup-0.38.0-rc.1.exe"), "0.38.0-rc.1");
    assert.equal(fileVersion("lootden-cli-linux-x64.tar.gz"), null);
  });

  it("groups builds of the same thing whatever order the name is in", () => {
    assert.equal(buildKind("LootDen-linux-arm64-0.35.0.AppImage"), buildKind("LootDen-0.38.0-linux-aarch64.AppImage"));
    assert.notEqual(buildKind("LootDen-0.37.0-linux-x86_64.AppImage"), buildKind("LootDen-0.37.0-linux-arm64.AppImage"));
    assert.notEqual(buildKind("LootDen-0.37.0-linux-amd64.deb"), buildKind("LootDen-0.37.0-linux-arm64.deb"));
    assert.notEqual(buildKind("LootDen-Setup-0.37.0.exe"), buildKind("LootDen-0.37.0-portable.exe"));
  });

  it("orders versions by number, a release after its pre-release", () => {
    assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
    assert.ok(compareVersions("0.38.0", "0.38.0-rc.1") > 0);
    assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  });

  it("keeps the newest of each kind and every unversioned file", () => {
    const old = outdated(BACKLOG);
    assert.deepEqual(
      BACKLOG.filter((n) => !old.includes(n)).sort(),
      [
        "LootDen-0.37.0-linux-amd64.deb",
        "LootDen-0.37.0-linux-arm64.deb",
        "LootDen-0.37.0-linux-x86_64.AppImage",
        "LootDen-0.37.0-portable.exe",
        "LootDen-0.37.0.apk",
        "LootDen-Playnite-0.37.0.pext",
        "LootDen-Setup-0.37.0.exe",
        "LootDen-linux-arm64-0.37.0.AppImage",
        "lootden-cli-linux-arm64.tar.gz",
        "lootden-cli-linux-x64.tar.gz",
        "lootden-cli-win-x64.zip",
      ].sort(),
    );
  });

  it("removes the replaced builds when a new release is fetched", async () => {
    const data = await mkdtemp(path.join(os.tmpdir(), "lootden-prune-"));
    try {
      await mkdir(path.join(data, "clients"));
      for (const n of BACKLOG) await writeFile(path.join(data, "clients", n), "old");
      const assets = ["LootDen-0.38.0-linux-arm64.AppImage", "LootDen-0.38.0-linux-amd64.deb", "lootden-cli-linux-x64.tar.gz"];
      const fakeFetch = (async (url: string) => {
        if (url.includes("/releases/latest")) {
          return new Response(JSON.stringify({ tag_name: "v0.38.0", assets: assets.map((name) => ({ name, browser_download_url: `https://dl/${name}` })) }));
        }
        return new Response("new");
      }) as typeof fetch;
      const clients = new ClientDownloads(data, fakeFetch);
      const r = await clients.fetchRelease("you/lootden");
      assert.deepEqual(r.files, assets);
      const left = await readdir(path.join(data, "clients"));
      assert.ok(left.includes("LootDen-0.38.0-linux-arm64.AppImage"));
      assert.ok(!left.includes("LootDen-linux-arm64-0.37.0.AppImage"), "the old-style ARM AppImage is replaced");
      assert.ok(left.includes("LootDen-0.38.0-linux-amd64.deb"));
      assert.ok(!left.some((n) => /0\.3[3-7]\.0-linux-amd64\.deb/.test(n)));
      // Kinds the release didn't ship keep their newest build.
      assert.ok(left.includes("LootDen-0.37.0-linux-x86_64.AppImage"));
      assert.ok(left.includes("LootDen-Setup-0.37.0.exe"));
      assert.ok(!left.includes("LootDen-Setup-0.36.0.exe"));
      assert.ok(r.removed.includes("LootDen-0.33.0.apk"));
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});
