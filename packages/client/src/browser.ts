import { isStoreLaunchUrl } from "@lootden/shared";

/**
 * The desktop app's built-in web browser: what the address bar turns typed text into, which
 * pages it will open, and the sites and launchers on its start page. Kept here, away from
 * Electron, so the rules are tested.
 */

export interface Bookmark {
  title: string;
  url: string;
}

export type SearchEngine = "google" | "bing" | "duckduckgo";

export const SEARCH_ENGINES: Record<SearchEngine, { name: string; url: string }> = {
  google: { name: "Google", url: "https://www.google.com/search?q=" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
};

/** Sites a gaming PC reaches for, shown until the person changes the list. */
export const DEFAULT_BOOKMARKS: Bookmark[] = [
  { title: "YouTube", url: "https://www.youtube.com/" },
  { title: "Twitch", url: "https://www.twitch.tv/" },
  { title: "Discord", url: "https://discord.com/app" },
  { title: "Xbox Cloud Gaming", url: "https://www.xbox.com/play" },
  { title: "GeForce NOW", url: "https://play.geforcenow.com/" },
  { title: "Steam Store", url: "https://store.steampowered.com/" },
  { title: "GOG", url: "https://www.gog.com/" },
  { title: "Epic Games Store", url: "https://store.epicgames.com/" },
  { title: "PCGamingWiki", url: "https://www.pcgamingwiki.com/" },
  { title: "Reddit", url: "https://www.reddit.com/" },
];

/** The start page in kid-safe mode, which can't be changed there. */
export const KID_BOOKMARKS: Bookmark[] = [
  { title: "Kiddle", url: "https://www.kiddle.co/" },
  { title: "PBS Kids", url: "https://pbskids.org/" },
  { title: "Nat Geo Kids", url: "https://kids.nationalgeographic.com/" },
  { title: "Scratch", url: "https://scratch.mit.edu/" },
  { title: "Code.org", url: "https://code.org/" },
  { title: "Khan Academy", url: "https://www.khanacademy.org/" },
  { title: "ABCya", url: "https://www.abcya.com/" },
  { title: "Starfall", url: "https://www.starfall.com/" },
  { title: "LEGO", url: "https://www.lego.com/kids" },
  { title: "NASA", url: "https://www.nasa.gov/" },
];

/** Most a person can keep, so a broken page can't grow the settings file without end. */
export const MAX_BOOKMARKS = 60;

/** Only web pages open in the browser. file:, javascript:, data: and the rest never do. */
export function isBrowsable(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * What the address bar opens for typed text: a full web address as it is, something that
 * looks like a site name ("youtube.com", "localhost:8080", "192.168.1.5") over https (http
 * for local names), and anything else as a search (on searchBase when given, Kiddle for kids).
 */
export function addressToUrl(input: string, engine: SearchEngine = "google", searchBase?: string): string {
  const text = input.trim();
  const search = () => `${searchBase ?? (SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.google).url}${encodeURIComponent(text)}`;
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return isBrowsable(text) ? new URL(text).toString() : search();
  // Any other scheme ("javascript:", "file:", "steam:") is searched for, never opened.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) && !/^[\w-]+(\.[\w-]+)*:\d+/.test(text)) return search();
  if (/\s/.test(text)) return search();
  const host = text.split(/[/?#]/)[0]!;
  const local = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/i.test(host) || /^[\w-]+\.(local|lan|home|internal)(:\d+)?$/i.test(host);
  const site = /^([a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62}(:\d+)?$/i.test(host);
  if (!local && !site) return search();
  const url = `${local ? "http" : "https"}://${text}`;
  return isBrowsable(url) ? new URL(url).toString() : search();
}

/** A short name for a page with no title: its host without www. */
export function siteName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Bookmarks from the settings file or the page: web pages only, titled, no duplicates, capped. */
export function cleanBookmarks(list: unknown): Bookmark[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: Bookmark[] = [];
  for (const item of list) {
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    if (!isBrowsable(url)) continue;
    const href = new URL(url).toString();
    if (seen.has(href)) continue;
    seen.add(href);
    const title = (typeof item?.title === "string" ? item.title.trim() : "").slice(0, 80) || siteName(href);
    out.push({ title, url: href });
    if (out.length >= MAX_BOOKMARKS) break;
  }
  return out;
}

export interface LauncherShortcut {
  id: string;
  name: string;
  url: string;
}

/** Other stores' launchers, opened from the browser's start page. Windows-only ones are left out elsewhere. */
export function launcherShortcuts(platform: string): LauncherShortcut[] {
  const all: Array<LauncherShortcut & { windowsOnly?: boolean }> = [
    { id: "steam", name: "Steam Big Picture", url: "steam://open/bigpicture" },
    { id: "epic", name: "Epic Games", url: "com.epicgames.launcher://store", windowsOnly: true },
    { id: "gog", name: "GOG Galaxy", url: "goggalaxy://openGalaxy", windowsOnly: true },
    { id: "xbox", name: "Xbox app", url: "msxbox://", windowsOnly: true },
    { id: "ubisoft", name: "Ubisoft Connect", url: "uplay://", windowsOnly: true },
    { id: "ea", name: "EA app", url: "origin2://", windowsOnly: true },
    { id: "battlenet", name: "Battle.net", url: "battlenet://", windowsOnly: true },
    { id: "heroic", name: "Heroic", url: "heroic://", windowsOnly: false },
  ];
  return all
    .filter((l) => (platform === "win32" ? l.id !== "heroic" : !l.windowsOnly))
    .filter((l) => isStoreLaunchUrl(l.url))
    .map(({ id, name, url }) => ({ id, name, url }));
}
