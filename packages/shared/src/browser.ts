/**
 * What a person may open in the desktop app's built-in web browser. An admin sets it per person
 * (Settings, Users); kid profiles start in kid-safe mode. The server keeps it, the app applies it.
 */
export interface BrowserPolicy {
  /** "kids": only kid-safe sites (KID_SITES plus `allowed`) and kid-safe search; "open": everything but `blocked`. */
  mode: "open" | "kids";
  /** Extra sites a kid-safe browser may open. */
  allowed: string[];
  /** Sites never opened, in either mode. */
  blocked: string[];
}

/** Sites made for children, open in kid-safe mode without an admin adding them. */
export const KID_SITES = [
  "kiddle.co",
  "pbskids.org",
  "kids.nationalgeographic.com",
  "kids.britannica.com",
  "scratch.mit.edu",
  "code.org",
  "khanacademy.org",
  "starfall.com",
  "abcya.com",
  "funbrain.com",
  "lego.com",
  "nasa.gov",
  "duolingo.com",
];

/** Where a kid-safe browser searches: Kiddle, a search made for children. */
export const KID_SEARCH = "https://www.kiddle.co/s.php?q=";

/** Most sites one list holds, so a mistake can't grow the settings without end. */
export const MAX_SITES = 200;

/**
 * A site as typed by an admin ("https://www.YouTube.com/watch?v=1", "*.roblox.com", "twitch.tv")
 * reduced to its host without www. Null when it isn't a site name.
 */
export function cleanSite(input: unknown): string | null {
  let text = String(input ?? "").trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*\./, "");
  const host = text.split(/[/?#]/)[0]!.split("@").pop()!.replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
  if (host.length > 253 || !/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$|^localhost$|^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  return host;
}

/** A list of sites, cleaned, without duplicates, capped. */
export function cleanSites(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const item of list) {
    const site = cleanSite(item);
    if (site) out.add(site);
    if (out.size >= MAX_SITES) break;
  }
  return [...out];
}

/** A policy from storage or a request, with anything unknown dropped. */
export function cleanPolicy(input: unknown, kidProfile = false): BrowserPolicy {
  const p = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof BrowserPolicy, unknown>>;
  const mode = p.mode === "kids" || p.mode === "open" ? p.mode : kidProfile ? "kids" : "open";
  return { mode, allowed: cleanSites(p.allowed), blocked: cleanSites(p.blocked) };
}

/** Whether the host is the site or one of its subdomains: "youtube.com" covers "m.youtube.com". */
export function onSite(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === site || h.endsWith(`.${site}`);
}

/** Whether a page may open under the policy. Only http and https pages are ever considered. */
export function siteAllowed(url: string, policy: BrowserPolicy | null | undefined): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    host = u.hostname;
  } catch {
    return false;
  }
  if (!policy) return true;
  if (policy.blocked.some((s) => onSite(host, s))) return false;
  if (policy.mode === "open") return true;
  return [...KID_SITES, ...policy.allowed].some((s) => onSite(host, s));
}

/**
 * The same search with the engine's strictest safe search switched on (Google, Bing and
 * DuckDuckGo), or null when the address isn't a search page or already asks for it.
 */
export function safeSearchUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "");
  const want: [string, string] | null =
    /^google\.[a-z.]+$/.test(host) && (u.pathname === "/search" || u.pathname.startsWith("/search/"))
      ? ["safe", "active"]
      : host === "bing.com" && u.pathname.startsWith("/search")
        ? ["adlt", "strict"]
        : host === "duckduckgo.com" && u.searchParams.has("q")
          ? ["kp", "1"]
          : null;
  if (!want || u.searchParams.get(want[0]) === want[1]) return null;
  u.searchParams.set(want[0], want[1]);
  return u.toString();
}
