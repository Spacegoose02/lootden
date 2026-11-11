import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { KID_SEARCH, KID_SITES, PLATFORMS } from "@lootden/shared";

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

// The built-in browser's rules, kept in Kotlin too (BrowserRules.kt).
const rules = readFileSync(new URL("../../../android/app/src/main/java/app/lootden/android/BrowserRules.kt", import.meta.url), "utf8");
const clientBrowser = readFileSync(new URL("../../../client/src/browser.ts", import.meta.url), "utf8");

describe("the Android app's browser rules", () => {
  it("open the same kid-safe sites and search as the desktop app", () => {
    const sites = rules.match(/val KID_SITES = listOf\(([^)]*)\)/)?.[1] ?? "";
    assert.deepEqual([...sites.matchAll(/"([^"]+)"/g)].map((m) => m[1]), KID_SITES);
    assert.ok(rules.includes(`const val KID_SEARCH = "${KID_SEARCH}"`));
  });

  it("offer the same search engines", () => {
    const desktop = [...clientBrowser.matchAll(/^\s+([a-z]+): \{ name: "([^"]+)", url: "([^"]+)" \}/gm)].map((m) => [m[1], m[2], m[3]]);
    const android = [...rules.matchAll(/"([a-z]+)" to \("([^"]+)" to "([^"]+)"\)/g)].map((m) => [m[1], m[2], m[3]]);
    assert.ok(desktop.length >= 3);
    assert.deepEqual(android, desktop);
  });
});

describe("the Android app's emulators", () => {
  it("offer ARMSX2 for PS2, ahead of NetherSX2 and RetroArch", () => {
    assert.match(kotlin, /Emulator\(\s*"armsx2", "ARMSX2", listOf\("come\.nanodata\.armsx2"/);
    assert.ok(kotlin.includes(`"ps2" to listOf("armsx2", "aethersx2", "retroarch")`));
  });
});

// The page's window.lootden on Android (assets/bridge.js) and what the app answers (AppCore.kt).
const bridgeJs = readFileSync(new URL("../../../android/app/src/main/assets/bridge.js", import.meta.url), "utf8");
const appCore = readFileSync(new URL("../../../android/app/src/main/java/app/lootden/android/AppCore.kt", import.meta.url), "utf8");

describe("the Android app's bridge", () => {
  it("answers every method the page can call", () => {
    const methods = [...(bridgeJs.match(/const METHODS = \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!);
    assert.ok(methods.includes("playInBrowser"));
    assert.deepEqual(methods.filter((m) => !appCore.includes(`"${m}" ->`)), []);
  });
});
