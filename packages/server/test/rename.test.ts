import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, withLegacyEnv } from "../src/config.js";
import { avatarSvg } from "../src/users/avatars.js";
import { describe as describeFile } from "../src/clients/store.js";

describe("the rename to LootDen", () => {
  it("reads LOOTDEN_ settings and still accepts the GM_ ones", () => {
    assert.equal(loadConfig({ LOOTDEN_PORT: "9001" }).port, 9001);
    assert.equal(loadConfig({ GM_PORT: "9002" }).port, 9002);
    assert.equal(loadConfig({ GM_PORT: "9002", LOOTDEN_PORT: "9003" }).port, 9003);
    assert.equal(withLegacyEnv({ LOOTDEN_WEB_DIR: "/w" }).GM_WEB_DIR, "/w");
  });

  it("names the CLI downloads under both names", () => {
    for (const n of ["lootden.exe", "lootden-cli-win-x64.zip", "gm.exe", "gm-win-x64.zip"]) assert.equal(describeFile(n).kind, "Command-line client", n);
    assert.equal(describeFile("lootden-cli-linux-x64.tar.gz").platform, "linux");
    assert.equal(describeFile("LootDen-Setup-0.7.0.exe").kind, "Desktop app (installer)");
    assert.deepEqual(describeFile("LootDen-0.32.0.apk"), { platform: "android", kind: "Android app" });
  });

  it("draws a raccoon for every seed, the same one each time", () => {
    const a = avatarSvg("4f2a9c0b11de");
    assert.equal(a, avatarSvg("4f2a9c0b11de"));
    assert.notEqual(a, avatarSvg("another"));
    assert.match(a, /^<svg[^>]*viewBox="0 0 64 64"/);
    const pictures = new Set(Array.from({ length: 60 }, (_, i) => avatarSvg(`seed${i}`)));
    assert.equal(pictures.size, 60);
  });
});
