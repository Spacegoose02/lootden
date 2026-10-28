import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressToUrl, cleanBookmarks, DEFAULT_BOOKMARKS, isBrowsable, launcherShortcuts, MAX_BOOKMARKS, siteName } from "../src/browser.js";
import { isStoreLaunchUrl } from "@lootden/shared";

describe("built-in browser", () => {
  it("opens web addresses as they are", () => {
    assert.equal(addressToUrl("https://www.youtube.com/watch?v=abc"), "https://www.youtube.com/watch?v=abc");
    assert.equal(addressToUrl("  HTTP://Example.com  "), "http://example.com/");
  });

  it("adds https to site names and http to local ones", () => {
    assert.equal(addressToUrl("youtube.com"), "https://youtube.com/");
    assert.equal(addressToUrl("store.steampowered.com/app/620"), "https://store.steampowered.com/app/620");
    assert.equal(addressToUrl("localhost:8080"), "http://localhost:8080/");
    assert.equal(addressToUrl("192.168.1.5:3000/x"), "http://192.168.1.5:3000/x");
    assert.equal(addressToUrl("tower.local"), "http://tower.local/");
  });

  it("searches for everything else, with the chosen engine", () => {
    assert.equal(addressToUrl("elden ring patch notes"), "https://www.google.com/search?q=elden%20ring%20patch%20notes");
    assert.equal(addressToUrl("hades", "duckduckgo"), "https://duckduckgo.com/?q=hades");
    assert.equal(addressToUrl("v1.2"), "https://www.google.com/search?q=v1.2");
    assert.equal(addressToUrl(""), "");
  });

  it("never opens other schemes from the address bar", () => {
    for (const bad of ["javascript:alert(1)", "file:///C:/Windows", "steam://run/620", "data:text/html,hi", "about:blank", "ms-msdt:/id"]) {
      assert.match(addressToUrl(bad), /^https:\/\/www\.google\.com\/search\?q=/, bad);
    }
  });

  it("only browses http and https pages without credentials", () => {
    assert.ok(isBrowsable("https://discord.com/app"));
    assert.ok(!isBrowsable("file:///etc/passwd"));
    assert.ok(!isBrowsable("javascript:alert(1)"));
    assert.ok(!isBrowsable("https://user:pass@example.com/"));
    assert.ok(!isBrowsable("not a url"));
  });

  it("keeps bookmarks to web pages, titled and without duplicates", () => {
    const list = cleanBookmarks([
      { title: " Tube ", url: "https://youtube.com" },
      { title: "again", url: "https://youtube.com/" },
      { title: "", url: "https://www.gog.com/en" },
      { title: "evil", url: "javascript:alert(1)" },
      { url: 5 },
      null,
    ]);
    assert.deepEqual(list, [
      { title: "Tube", url: "https://youtube.com/" },
      { title: "gog.com", url: "https://www.gog.com/en" },
    ]);
    assert.deepEqual(cleanBookmarks("nope"), []);
    const many = Array.from({ length: 100 }, (_, i) => ({ title: `s${i}`, url: `https://s${i}.example.com/` }));
    assert.equal(cleanBookmarks(many).length, MAX_BOOKMARKS);
    assert.equal(cleanBookmarks(DEFAULT_BOOKMARKS).length, DEFAULT_BOOKMARKS.length);
  });

  it("names pages by host", () => {
    assert.equal(siteName("https://www.twitch.tv/directory"), "twitch.tv");
  });

  it("offers launchers that are allowed to open, Windows-only ones on Windows", () => {
    const win = launcherShortcuts("win32");
    const linux = launcherShortcuts("linux");
    assert.ok(win.some((l) => l.id === "epic") && win.some((l) => l.id === "steam"));
    assert.deepEqual(linux.map((l) => l.id), ["steam", "heroic"]);
    for (const l of [...win, ...linux]) assert.ok(isStoreLaunchUrl(l.url), l.url);
  });
});
