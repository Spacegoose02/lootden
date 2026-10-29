import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressToUrl, cleanBookmarks, DEFAULT_BOOKMARKS, isBrowsable, launcherShortcuts, MAX_BOOKMARKS, siteName } from "../src/browser.js";
import { cleanPolicy, cleanSite, isStoreLaunchUrl, safeSearchUrl, siteAllowed } from "@lootden/shared";

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

describe("browser rules", () => {
  it("reads site names the way admins type them", () => {
    assert.equal(cleanSite("https://www.YouTube.com/watch?v=1"), "youtube.com");
    assert.equal(cleanSite("*.roblox.com"), "roblox.com");
    assert.equal(cleanSite("twitch.tv:443/x"), "twitch.tv");
    assert.equal(cleanSite("192.168.1.5"), "192.168.1.5");
    for (const bad of ["", "not a site", "javascript:alert(1)", "com", "-bad-.com"]) assert.equal(cleanSite(bad), null, bad);
  });

  it("blocks listed sites and their subdomains, and nothing else, when open", () => {
    const p = cleanPolicy({ mode: "open", blocked: ["youtube.com"] });
    assert.equal(siteAllowed("https://www.youtube.com/watch?v=1", p), false);
    assert.equal(siteAllowed("https://m.youtube.com/", p), false);
    assert.equal(siteAllowed("https://notyoutube.com/", p), true, "a lookalike isn't a subdomain");
    assert.equal(siteAllowed("https://twitch.tv/", p), true);
    assert.equal(siteAllowed("file:///C:/Windows", p), false);
    assert.equal(siteAllowed("https://anything.example/", null), true);
  });

  it("opens only kid sites and the admin's extras in kid-safe mode", () => {
    const p = cleanPolicy({ allowed: ["minecraft.net"], blocked: ["abcya.com"] }, true);
    assert.equal(p.mode, "kids");
    assert.equal(siteAllowed("https://pbskids.org/games", p), true);
    assert.equal(siteAllowed("https://www.kiddle.co/s.php?q=cats", p), true);
    assert.equal(siteAllowed("https://www.minecraft.net/", p), true);
    assert.equal(siteAllowed("https://www.abcya.com/", p), false, "blocked beats the kid list");
    assert.equal(siteAllowed("https://www.reddit.com/", p), false);
    assert.equal(cleanPolicy({}, false).mode, "open");
  });

  it("searches Kiddle in kid-safe mode", () => {
    assert.equal(addressToUrl("cute cats", "google", "https://www.kiddle.co/s.php?q="), "https://www.kiddle.co/s.php?q=cute%20cats");
    assert.equal(addressToUrl("pbskids.org", "google", "https://www.kiddle.co/s.php?q="), "https://pbskids.org/");
  });

  it("turns safe search on", () => {
    assert.equal(safeSearchUrl("https://www.google.com/search?q=cats"), "https://www.google.com/search?q=cats&safe=active");
    assert.equal(safeSearchUrl("https://www.google.co.uk/search?q=cats&safe=active"), null);
    assert.equal(safeSearchUrl("https://www.bing.com/search?q=cats"), "https://www.bing.com/search?q=cats&adlt=strict");
    assert.equal(safeSearchUrl("https://duckduckgo.com/?q=cats"), "https://duckduckgo.com/?q=cats&kp=1");
    assert.equal(safeSearchUrl("https://www.google.com/maps"), null);
  });
});
