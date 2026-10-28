import { XMLParser } from "fast-xml-parser";
import { json, now, type Db } from "../db/database.js";
import type { Library } from "../catalog/library.js";
import { titleKey } from "../metadata/calendar.js";
import { cleanTitle } from "../metadata/titles.js";
import type { FetchLike } from "../metadata/http.js";

export type WishSource = { kind: "steam" | "manual"; name: string } | { kind: "feed"; id: number; name: string };

export interface WishItem {
  id: number;
  title: string;
  steamAppId: number | null;
  url: string | null;
  image: string | null;
  /** YYYY-MM-DD when known. */
  releaseDate: string | null;
  /** The store's wording when there's no exact day ("Q1 2027", "Coming soon"). */
  dateText: string | null;
  sources: WishSource[];
  addedAt: string;
  /** The library game with the same title, once it's in. */
  libraryId: string | null;
  /** On the wanted list: searched for on a schedule until it's in the library. */
  monitored: boolean;
  searchedAt: string | null;
  /** The best release the last search found (allowed by the release rules). */
  found: FoundRelease | null;
  /** The download started for it, if any. */
  downloadId: number | null;
}

export interface FoundRelease {
  title: string;
  indexer: string;
  sizeBytes: number;
  protocol: "torrent" | "usenet";
  seeders: number | null;
  url: string;
}

export interface WishFeed {
  id: number;
  url: string;
  name: string;
  checkedAt: string | null;
  error: string | null;
  itemCount: number;
}

export interface SteamLink {
  steamId: string;
  profile: string;
  syncedAt: string | null;
  error: string | null;
  count: number;
  /** Re-sync on the six-hourly timer (the Sync button always works). */
  autoSync?: boolean;
}

interface Row {
  id: number;
  title: string;
  title_key: string;
  steam_app_id: number | null;
  url: string | null;
  image: string | null;
  release_date: string | null;
  date_text: string | null;
  sources: string;
  added_at: string;
  hidden: number;
  monitored: number;
  searched_at: string | null;
  found: string | null;
  download_id: number | null;
}

export interface WishInput {
  title: string;
  steamAppId?: number | null;
  url?: string | null;
  image?: string | null;
  releaseDate?: string | null;
  dateText?: string | null;
}

const UA = { "User-Agent": "Mozilla/5.0 (LootDen)" };
const STEAM_KEY = "wishlist_steam";
const arr = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => (v == null ? "" : typeof v === "object" ? String((v as Record<string, unknown>)["#text"] ?? "") : String(v)).trim();
const steamAppIn = (s: string | null | undefined) => {
  const m = s?.match(/store\.steampowered\.com\/app\/(\d+)/);
  return m ? Number(m[1]) : null;
};

/** "Game.Name.v1.2-GROUP" style names become "Game Name"; ordinary titles ("Half-Life 2") are left alone. */
export function listTitle(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t.includes(" ") && /[._]/.test(t)) return cleanTitle(t).query;
  return t.replace(/\s*\[[^\]]*\]/g, "").trim() || t;
}

/** Items of an RSS 2.0 or Atom feed, as wishlist entries. */
export function parseListFeed(xml: string): { title: string; items: WishInput[] } {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" }).parse(xml);
  const channel = doc?.rss?.channel ?? doc?.["rdf:RDF"]?.channel;
  const rssItems = arr(doc?.rss?.channel?.item ?? doc?.["rdf:RDF"]?.item) as Array<Record<string, unknown>>;
  if (channel || rssItems.length) {
    return {
      title: text(channel?.title),
      items: rssItems.flatMap((i) => {
        const title = listTitle(text(i.title));
        if (!title) return [];
        const url = text(i.link) || text(i.guid) || null;
        const enclosure = i.enclosure as Record<string, string> | undefined;
        const thumb = (i["media:thumbnail"] ?? (i["media:content"] as Record<string, unknown> | undefined)) as Record<string, string> | undefined;
        const img = enclosure?.["@type"]?.startsWith("image") ? enclosure["@url"] : thumb?.["@url"] ?? text(i.description).match(/<img[^>]+src="([^"]+)"/)?.[1];
        return [{ title, url, image: img ?? null, steamAppId: steamAppIn(url) ?? steamAppIn(text(i.description)) }];
      }),
    };
  }
  if (doc?.feed) {
    const entries = arr(doc.feed.entry) as Array<Record<string, unknown>>;
    return {
      title: text(doc.feed.title),
      items: entries.flatMap((e) => {
        const title = listTitle(text(e.title));
        if (!title) return [];
        const links = arr(e.link as Record<string, string> | Array<Record<string, string>>);
        const url = (links.find((l) => !l["@rel"] || l["@rel"] === "alternate") ?? links[0])?.["@href"] ?? null;
        const thumb = (e["media:group"] as Record<string, Record<string, string>> | undefined)?.["media:thumbnail"]?.["@url"];
        return [{ title, url, image: thumb ?? null, steamAppId: steamAppIn(url) }];
      }),
    };
  }
  throw new Error("That address isn't an RSS or Atom feed");
}

/** A Steam profile link, vanity name or 17-digit id, as the 64-bit id. */
export async function resolveSteamId(input: string, fetchImpl: FetchLike): Promise<string> {
  const ref = input.trim().replace(/\/+$/, "");
  const direct = ref.match(/(?:profiles\/)?(7656\d{13})$/)?.[1];
  if (direct) return direct;
  const vanity = ref.match(/steamcommunity\.com\/id\/([^/?#]+)/)?.[1] ?? (/^[\w-]{2,32}$/.test(ref) ? ref : null);
  if (!vanity) throw new Error("Paste your Steam profile link, custom URL name or 17-digit Steam ID");
  const res = await fetchImpl(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`, { headers: UA });
  if (!res.ok) throw new Error(`Steam answered ${res.status}`);
  const id = (await res.text()).match(/<steamID64>(\d{17})<\/steamID64>/)?.[1];
  if (!id) throw new Error(`No Steam profile called "${vanity}"`);
  return id;
}

interface StoreItem {
  appid?: number;
  id?: number;
  name?: string;
  release?: { steam_release_date?: number; is_coming_soon?: boolean; custom_release_date_message?: string; coming_soon_display?: string };
}

const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

/**
 * The household wishlist. Sources: one Steam profile's public wishlist, any number of RSS/Atom
 * list feeds, and titles added by hand. The same game from two sources is one entry (matched on
 * the Steam app id, else the normalized title); removing an entry keeps it from coming back.
 */
export class WishlistService {
  private syncing: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly library: Library,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  steam(): SteamLink | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(STEAM_KEY) as { value: string } | undefined;
    return row ? json<SteamLink | null>(row.value, null) : null;
  }

  private saveSteam(link: SteamLink | null): void {
    if (!link) this.db.prepare("DELETE FROM settings WHERE key = ?").run(STEAM_KEY);
    else this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(STEAM_KEY, JSON.stringify(link));
  }

  feeds(): WishFeed[] {
    return (this.db.prepare("SELECT * FROM wishlist_feeds ORDER BY name").all() as Array<Record<string, unknown>>).map((r) => ({
      id: Number(r.id),
      url: String(r.url),
      name: String(r.name),
      checkedAt: (r.checked_at as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      itemCount: Number(r.item_count),
    }));
  }

  /** Visible entries, newest first, each linked to the library game when there is one. */
  list(): WishItem[] {
    const byTitle = new Map(this.library.list({}).map((g) => [titleKey(g.title), g.id]));
    return (this.db.prepare("SELECT * FROM wishlist WHERE hidden = 0 ORDER BY added_at DESC, id DESC").all() as unknown as Row[]).map((r) => ({
      id: r.id,
      title: r.title,
      steamAppId: r.steam_app_id,
      url: r.url,
      image: r.image,
      releaseDate: r.release_date,
      dateText: r.date_text,
      sources: json<WishSource[]>(r.sources, []),
      addedAt: r.added_at,
      libraryId: byTitle.get(r.title_key) ?? null,
      monitored: r.monitored === 1,
      searchedAt: r.searched_at,
      found: json<FoundRelease | null>(r.found, null),
      downloadId: r.download_id,
    }));
  }

  /** Title keys of everything on the wishlist (for marking the calendar). */
  keys(): Set<string> {
    return new Set((this.db.prepare("SELECT title_key FROM wishlist WHERE hidden = 0").all() as Array<{ title_key: string }>).map((r) => r.title_key));
  }

  /** Adds an entry or merges it into the one already there. "hidden" means it was removed before. */
  upsert(input: WishInput, source: WishSource): "added" | "merged" | "hidden" {
    const key = titleKey(input.title);
    if (!key) return "hidden";
    const existing = ((input.steamAppId ? this.db.prepare("SELECT * FROM wishlist WHERE steam_app_id = ?").get(input.steamAppId) : undefined) ??
      this.db.prepare("SELECT * FROM wishlist WHERE title_key = ?").get(key)) as Row | undefined;
    if (!existing) {
      this.db
        .prepare("INSERT INTO wishlist (title, title_key, steam_app_id, url, image, release_date, date_text, sources, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.title, key, input.steamAppId ?? null, input.url ?? null, input.image ?? null, input.releaseDate ?? null, input.dateText ?? null, JSON.stringify([source]), now());
      return "added";
    }
    const sources = json<WishSource[]>(existing.sources, []);
    if (!sources.some((s) => sameSource(s, source))) sources.push(source);
    // Steam knows the real name and date best; other sources only fill gaps.
    const steam = source.kind === "steam";
    this.db
      .prepare("UPDATE wishlist SET title = ?, steam_app_id = ?, url = ?, image = ?, release_date = ?, date_text = ?, sources = ? WHERE id = ?")
      .run(
        steam ? input.title : existing.title,
        existing.steam_app_id ?? input.steamAppId ?? null,
        steam ? (input.url ?? existing.url) : (existing.url ?? input.url ?? null),
        steam ? (input.image ?? existing.image) : (existing.image ?? input.image ?? null),
        steam ? (input.releaseDate ?? null) : (existing.release_date ?? input.releaseDate ?? null),
        steam ? (input.dateText ?? null) : (existing.date_text ?? input.dateText ?? null),
        JSON.stringify(sources),
        existing.id,
      );
    return existing.hidden ? "hidden" : "merged";
  }

  /** Drops one source from entries that no longer have it; entries left with no source go. */
  private dropSource(match: (s: WishSource) => boolean, keepIds: Set<number> = new Set()): void {
    for (const r of this.db.prepare("SELECT id, sources FROM wishlist").all() as Array<{ id: number; sources: string }>) {
      if (keepIds.has(r.id)) continue;
      const sources = json<WishSource[]>(r.sources, []);
      const left = sources.filter((s) => !match(s));
      if (left.length === sources.length) continue;
      if (left.length) this.db.prepare("UPDATE wishlist SET sources = ? WHERE id = ?").run(JSON.stringify(left), r.id);
      else this.db.prepare("DELETE FROM wishlist WHERE id = ? AND hidden = 0").run(r.id);
    }
  }

  addManual(title: string, url: string | null): WishItem {
    const t = title.trim();
    if (!t) throw new Error("Which game?");
    this.upsert({ title: t, url, steamAppId: steamAppIn(url) }, { kind: "manual", name: "Added by hand" });
    // Adding by hand brings back an entry removed earlier.
    this.db.prepare("UPDATE wishlist SET hidden = 0 WHERE title_key = ?").run(titleKey(t));
    const key = titleKey(t);
    return this.list().find((i) => titleKey(i.title) === key)!;
  }

  /** Brings back an entry removed earlier (an approved request asks for it again); returns it. */
  restore(title: string): WishItem | undefined {
    const key = titleKey(title);
    this.db.prepare("UPDATE wishlist SET hidden = 0 WHERE title_key = ?").run(key);
    return this.list().find((i) => titleKey(i.title) === key);
  }

  /** Removes an entry; syncing won't add it again. */
  remove(id: number): void {
    this.db.prepare("UPDATE wishlist SET hidden = 1 WHERE id = ?").run(id);
  }

  /** Turns the six-hourly Steam sync on or off without touching the linked profile. */
  setAutoSync(on: boolean): void {
    const link = this.steam();
    if (link) this.saveSteam({ ...link, autoSync: on });
  }

  async linkSteam(profile: string, autoSync?: boolean): Promise<SteamLink> {
    if (!profile.trim()) {
      this.saveSteam(null);
      this.dropSource((s) => s.kind === "steam");
      return { steamId: "", profile: "", syncedAt: null, error: null, count: 0 };
    }
    const steamId = await resolveSteamId(profile, this.fetchImpl);
    this.saveSteam({ steamId, profile: profile.trim(), syncedAt: null, error: null, count: 0, autoSync: autoSync ?? this.steam()?.autoSync ?? true });
    await this.syncSteam();
    return this.steam()!;
  }

  async addFeed(url: string, name?: string): Promise<WishFeed> {
    const u = new URL(url.trim());
    if (!/^https?:$/.test(u.protocol)) throw new Error("Feeds need an http(s) address");
    const parsed = parseListFeed(await this.fetchText(u.toString()));
    const r = this.db
      .prepare("INSERT INTO wishlist_feeds (url, name) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET name = excluded.name RETURNING id")
      .get(u.toString(), name?.trim() || parsed.title || u.hostname) as { id: number };
    await this.syncFeed(this.feeds().find((f) => f.id === r.id)!);
    return this.feeds().find((f) => f.id === r.id)!;
  }

  /** Removes a feed and the entries only it brought in. */
  removeFeed(id: number): void {
    this.db.prepare("DELETE FROM wishlist_feeds WHERE id = ?").run(id);
    this.dropSource((s) => s.kind === "feed" && s.id === id);
  }

  /** Re-reads Steam and every feed; runs on a timer and from the Sync button. */
  syncAll(scheduled = false): Promise<void> {
    this.syncing ??= (async () => {
      const steam = this.steam();
      if (steam?.steamId && (!scheduled || steam.autoSync !== false)) await this.syncSteam().catch(() => {});
      for (const f of this.feeds()) await this.syncFeed(f).catch(() => {});
    })().finally(() => (this.syncing = null));
    return this.syncing;
  }

  async syncFeed(feed: WishFeed): Promise<{ added: number; merged: number }> {
    const counts = { added: 0, merged: 0 };
    try {
      const { items } = parseListFeed(await this.fetchText(feed.url));
      for (const i of items) {
        const r = this.upsert(i, { kind: "feed", id: feed.id, name: feed.name });
        if (r !== "hidden") counts[r]++;
      }
      this.db.prepare("UPDATE wishlist_feeds SET checked_at = ?, error = NULL, item_count = ? WHERE id = ?").run(now(), items.length, feed.id);
    } catch (err) {
      this.db.prepare("UPDATE wishlist_feeds SET checked_at = ?, error = ? WHERE id = ?").run(now(), (err as Error).message, feed.id);
      throw err;
    }
    return counts;
  }

  /** Mirrors the linked profile's public Steam wishlist. */
  async syncSteam(): Promise<number> {
    const link = this.steam();
    if (!link?.steamId) return 0;
    try {
      const res = await this.fetchImpl(`https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${link.steamId}`, { headers: UA });
      if (!res.ok) throw new Error(`Steam answered ${res.status}`);
      const appIds = (((await res.json()) as { response?: { items?: Array<{ appid: number }> } }).response?.items ?? []).map((i) => i.appid);
      if (!appIds.length) {
        // A private wishlist looks the same as an empty one.
        if (!link.count) throw new Error("The wishlist is empty or private; set Game details to Public in Steam's privacy settings");
      }
      const details = await this.storeItems(appIds);
      const keep = new Set<number>();
      for (const appId of appIds) {
        const d = details.get(appId);
        const release = d?.release;
        const coming = release?.is_coming_soon;
        this.upsert(
          {
            title: d?.name ?? `Steam app ${appId}`,
            steamAppId: appId,
            url: `https://store.steampowered.com/app/${appId}/`,
            image: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
            releaseDate: release?.steam_release_date && !release.custom_release_date_message ? day(release.steam_release_date) : null,
            dateText: coming ? (release?.custom_release_date_message ?? release?.coming_soon_display ?? "Coming soon") : null,
          },
          { kind: "steam", name: "Steam wishlist" },
        );
        const row = this.db.prepare("SELECT id FROM wishlist WHERE steam_app_id = ?").get(appId) as { id: number } | undefined;
        if (row) keep.add(row.id);
      }
      // Games taken off the Steam wishlist leave here too (unless another source still has them).
      this.dropSource((s) => s.kind === "steam", keep);
      this.saveSteam({ ...link, syncedAt: now(), error: null, count: appIds.length });
      return appIds.length;
    } catch (err) {
      this.saveSteam({ ...link, syncedAt: now(), error: (err as Error).message });
      throw err;
    }
  }

  /** Names and release dates for Steam apps, 100 at a time. */
  private async storeItems(appIds: number[]): Promise<Map<number, StoreItem>> {
    const out = new Map<number, StoreItem>();
    for (let i = 0; i < appIds.length; i += 100) {
      const input = {
        ids: appIds.slice(i, i + 100).map((appid) => ({ appid })),
        context: { language: "english", country_code: "US" },
        data_request: { include_release: true },
      };
      try {
        const res = await this.fetchImpl(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`, { headers: UA });
        if (!res.ok) continue;
        for (const it of ((await res.json()) as { response?: { store_items?: StoreItem[] } }).response?.store_items ?? []) {
          const id = it.appid ?? it.id;
          if (id && it.name) out.set(id, it);
        }
      } catch {
        /* names fall back to "Steam app 123" and fill in on the next sync */
      }
    }
    return out;
  }

  private async fetchText(url: string): Promise<string> {
    const res = await this.fetchImpl(url, { headers: { ...UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
    return res.text();
  }
}

function sameSource(a: WishSource, b: WishSource): boolean {
  return a.kind === b.kind && (a.kind !== "feed" || (b.kind === "feed" && a.id === b.id));
}
