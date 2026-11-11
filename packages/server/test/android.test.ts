import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PLATFORMS } from "@lootden/shared";

// The Android app (packages/android) keeps its own copy of the systems it plays, in Kotlin.
const kotlin = readFileSync(new URL("../../../android/app/src/main/java/app/lootden/android/Emulators.kt", import.meta.url), "utf8");
const androidPlatforms = [...kotlin.matchAll(/Platform\("([a-z0-9]+)", "([^"]+)", listOf\(([^)]*)\)\)/g)].map((m) => ({
  id: m[1]!,
  extensions: [...m[3]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!),
}));

describe("the Android app's systems", () => {
  it("match the shared platforms, so a game installs into the same folder with the same file picked", () => {
    assert.ok(androidPlatforms.length > 10);
    for (const p of androidPlatforms) {
      const shared = PLATFORMS.find((x) => x.id === p.id);
      assert.ok(shared, `${p.id} is a LootDen platform`);
      assert.deepEqual(p.extensions, shared.extensions, `${p.id}'s file types`);
    }
  });

  it("covers every console LootDen has an emulator for, except the ones Android can't play", () => {
    const skipped = new Set(["ps3", "xbox"]);
    const wanted = PLATFORMS.filter((p) => p.emulator && !skipped.has(p.id)).map((p) => p.id);
    assert.deepEqual(wanted.filter((id) => !androidPlatforms.some((p) => p.id === id)), []);
  });

  it("has a RetroArch core for each of them", () => {
    const cores = [...kotlin.matchAll(/"([a-z0-9]+)" to "([a-z0-9_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(androidPlatforms.map((p) => p.id).filter((id) => !cores.includes(id)), []);
  });
});
