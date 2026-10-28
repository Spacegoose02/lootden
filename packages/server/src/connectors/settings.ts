import { json, type Db } from "../db/database.js";
import { DEFAULT_TIDY, type TidyOptions } from "./tidy.js";

export interface ReleaseRules {
  /** Every word must appear in the release name (e.g. "GOG"). */
  mustContain: string[];
  /** Releases with any of these words are never picked (e.g. "beta", "soundtrack"). */
  mustNotContain: string[];
  /** Words that make a release more likely to be picked, best first (e.g. uploaders you trust). */
  preferred: string[];
  /** Size limits in MB; 0 means no limit. */
  minSizeMb: number;
  maxSizeMb: number;
  /** Torrents with fewer seeders are skipped. */
  minSeeders: number;
  /** When both are found: "torrent", "usenet" or "any". */
  preferProtocol: "torrent" | "usenet" | "any";
  /** Indexers (as Prowlarr names them) to ignore. */
  blockedIndexers: string[];
}

export interface ConnectorSettings {
  qbittorrent: { url: string; username: string; password: string; category: string; savePath: string };
  transmission: { url: string; username: string; password: string; category: string; savePath: string };
  deluge: { url: string; password: string; category: string; savePath: string };
  /** Which client gets torrents. */
  torrentClient: "qbittorrent" | "transmission" | "deluge";
  sabnzbd: { url: string; apiKey: string; category: string };
  prowlarr: { url: string; apiKey: string; categories: number[] };
  import: {
    /** move (the default) deletes the download once imported; copy keeps torrents seeding; off leaves files alone. */
    mode: "copy" | "move" | "off";
    /** How paths reported by the download clients map to paths inside this container. */
    pathMappings: Array<{ from: string; to: string }>;
    /** Clean-up applied while importing: junk removal, unpacking, renaming and re-zipping. */
    tidy: TidyOptions;
    /**
     * A folder (as this container sees it) where finished downloads land, including ones the
     * clients here don't know about. Its games can be imported from the Downloads page.
     */
    folder: string;
    /** Import new games from that folder on their own once they stop changing. */
    autoImportFolder: boolean;
  };
  /** itch.io API key, so free itch.io games can be added to the library in one click. */
  itch: { apiKey: string };
  /** Picking a release automatically (and ranking search results). */
  rules: ReleaseRules;
  /** Wanted list: wishlist games searched on a schedule through Prowlarr. */
  wanted: { autoSearch: boolean; autoGrab: boolean; intervalHours: number; onlyReleased: boolean };
  /** Alerts in the web UI, and through an Apprise API server to Discord, Telegram, phones... */
  notify: { appriseUrl: string; appriseTargets: string; released: boolean; found: boolean; grabbed: boolean; imported: boolean; updates: boolean; flagged: boolean; sources: boolean; requests: boolean };
  /** Virus scanning before an import joins the library. */
  scan: { clamav: "off" | "clamd" | "clamscan"; clamdHost: string; clamdPort: number; virusTotalKey: string; hold: boolean };
  /** NexusMods API key for trending mods on game pages. */
  nexus: { apiKey: string };
  /** Time to beat from HowLongToBeat (unofficial; IGDB's times are the fallback). */
  hltb: { enabled: boolean };
}

export const DEFAULT_RULES: ReleaseRules = {
  mustContain: [],
  mustNotContain: ["soundtrack", "ost", "artbook", "wallpaper", "trainer", "demo"],
  preferred: [],
  minSizeMb: 0,
  maxSizeMb: 0,
  minSeeders: 1,
  preferProtocol: "any",
  blockedIndexers: [],
};

export const DEFAULT_CONNECTORS: ConnectorSettings = {
  qbittorrent: { url: "", username: "", password: "", category: "games", savePath: "" },
  transmission: { url: "", username: "", password: "", category: "games", savePath: "" },
  deluge: { url: "", password: "", category: "games", savePath: "" },
  torrentClient: "qbittorrent",
  sabnzbd: { url: "", apiKey: "", category: "games" },
  // 4000 = PC games in the Newznab/Torznab category tree that Prowlarr uses.
  prowlarr: { url: "", apiKey: "", categories: [4000] },
  import: { mode: "move", pathMappings: [], tidy: DEFAULT_TIDY, folder: "", autoImportFolder: false },
  itch: { apiKey: "" },
  rules: DEFAULT_RULES,
  wanted: { autoSearch: false, autoGrab: false, intervalHours: 12, onlyReleased: true },
  notify: { appriseUrl: "", appriseTargets: "", released: true, found: true, grabbed: true, imported: true, updates: true, flagged: true, sources: true, requests: true },
  scan: { clamav: "off", clamdHost: "clamav", clamdPort: 3310, virusTotalKey: "", hold: true },
  nexus: { apiKey: "" },
  hltb: { enabled: true },
};

const KEY = "connectors";
const SECRET = "********";
/** Secret fields, masked when sent to the browser and kept when the mask comes back. */
const SECRETS: Array<[keyof ConnectorSettings, string]> = [
  ["qbittorrent", "password"],
  ["transmission", "password"],
  ["deluge", "password"],
  ["sabnzbd", "apiKey"],
  ["prowlarr", "apiKey"],
  ["itch", "apiKey"],
  ["scan", "virusTotalKey"],
  ["nexus", "apiKey"],
];
const SECTIONS = Object.keys(DEFAULT_CONNECTORS).filter((k) => typeof DEFAULT_CONNECTORS[k as keyof ConnectorSettings] === "object") as Array<keyof ConnectorSettings>;

function merge(base: ConnectorSettings, over: Partial<ConnectorSettings>): ConnectorSettings {
  const out = { ...base, ...over } as Record<string, unknown>;
  for (const k of SECTIONS) out[k] = { ...(base[k] as object), ...((over[k] as object | undefined) ?? {}) };
  out.import = { ...(out.import as object), tidy: { ...base.import.tidy, ...over.import?.tidy } };
  return out as unknown as ConnectorSettings;
}

export function loadConnectorSettings(db: Db): ConnectorSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  return merge(DEFAULT_CONNECTORS, json<Partial<ConnectorSettings>>(row?.value, {}));
}

const list = (v: unknown) =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[,\n]/))
    .map((x) => String(x).trim())
    .filter(Boolean);

/** Saves settings; a secret sent back as the mask keeps its stored value. */
export function saveConnectorSettings(db: Db, incoming: Partial<ConnectorSettings>): ConnectorSettings {
  const current = loadConnectorSettings(db);
  const merged = merge(current, incoming);
  for (const [section, field] of SECRETS) {
    const sec = merged[section] as unknown as Record<string, string>;
    if (sec[field] === SECRET) sec[field] = (current[section] as unknown as Record<string, string>)[field]!;
  }
  merged.import.folder = String(merged.import.folder ?? "").trim();
  merged.import.autoImportFolder = Boolean(merged.import.autoImportFolder);
  if (!["zip", "folder"].includes(merged.import.tidy.repack)) throw new Error("Unknown repack option; use zip or folder");
  for (const k of ["qbittorrent", "transmission", "deluge", "sabnzbd", "prowlarr"] as const) merged[k].url = merged[k].url.trim().replace(/\/+$/, "");
  for (const k of ["qbittorrent", "transmission", "deluge", "sabnzbd", "prowlarr"] as const) {
    if (merged[k].url && !/^https?:\/\//i.test(merged[k].url)) throw new Error(`The ${k} address needs to start with http:// or https://`);
  }
  if (!["copy", "move", "off"].includes(merged.import.mode)) throw new Error("Unknown import mode; use copy, move or off");
  if (!["qbittorrent", "transmission", "deluge"].includes(merged.torrentClient)) throw new Error("Unknown torrent client");
  const r = merged.rules;
  merged.rules = {
    mustContain: list(r.mustContain),
    mustNotContain: list(r.mustNotContain),
    preferred: list(r.preferred),
    minSizeMb: Math.max(0, Number(r.minSizeMb) || 0),
    maxSizeMb: Math.max(0, Number(r.maxSizeMb) || 0),
    minSeeders: Math.max(0, Number(r.minSeeders) || 0),
    preferProtocol: ["torrent", "usenet", "any"].includes(r.preferProtocol) ? r.preferProtocol : "any",
    blockedIndexers: list(r.blockedIndexers),
  };
  merged.wanted.intervalHours = Math.min(Math.max(Math.round(Number(merged.wanted.intervalHours) || 12), 1), 168);
  if (!["off", "clamd", "clamscan"].includes(merged.scan.clamav)) throw new Error("Unknown ClamAV mode");
  merged.scan.clamdPort = Number(merged.scan.clamdPort) || 3310;
  merged.notify.appriseUrl = merged.notify.appriseUrl.trim().replace(/\/+$/, "");
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(merged));
  return merged;
}

/** Settings as shown to the admin UI, with secrets masked. */
export function maskedConnectorSettings(s: ConnectorSettings): ConnectorSettings {
  const out = merge(s, {});
  for (const [section, field] of SECRETS) {
    const sec = out[section] as unknown as Record<string, string>;
    sec[field] = sec[field] ? SECRET : "";
  }
  return out;
}
