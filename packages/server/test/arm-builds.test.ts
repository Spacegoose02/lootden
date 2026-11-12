import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describe as describeFile } from "../src/clients/store.js";

describe("ARM Linux builds", () => {
  it("labels the ARM AppImage, .deb and CLI so handheld players pick the right one", () => {
    assert.deepEqual(describeFile("LootDen-linux-arm64-0.35.0.AppImage"), { platform: "linux", kind: "Desktop app (AppImage, ARM)" });
    assert.deepEqual(describeFile("LootDen-0.35.0-linux-arm64.deb"), { platform: "linux", kind: "Desktop app (Debian/Ubuntu package, ARM)" });
    assert.deepEqual(describeFile("lootden-cli-linux-arm64.tar.gz"), { platform: "linux", kind: "Command-line client (ARM)" });
  });

  it("keeps the x64 labels as they were", () => {
    assert.equal(describeFile("LootDen-0.35.0-linux-x86_64.AppImage").kind, "Desktop app (AppImage)");
    assert.equal(describeFile("LootDen-0.35.0-linux-amd64.deb").kind, "Desktop app (Debian/Ubuntu package)");
    assert.equal(describeFile("lootden-cli-linux-x64.tar.gz").kind, "Command-line client");
  });
});
