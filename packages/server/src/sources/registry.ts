import type { Notifier } from "../alerts/notifier.js";
import { json, now, type Db } from "../db/database.js";
import { titleKey } from "../metadata/calendar.js";
import type { FetchLike } from "../metadata/http.js";
import { cleanTitle } from "../metadata/titles.js";
import type { WishlistService } from "../news/wishlist.js";
import { ADAPTERS } from "./adapters/index.js";
import { SourceClient } from "./client.js";
import { cleanDownloads } from "./download.js";
import type { ReleaseInfo, ReleaseSource, SourceConfig } from "./types.js";

const KEY = "sources";
const MASK = "********";

export interface SourceView {
  id: string;
  /** The admin's name for the source when they set one, else the adapter's. */
  name: string;
  /** The adapter's own name, shown when the admin's name is blank. */
  defaultName: string;
  nameable: boolean;
  description: string;
  needsKey: boolean;
  defaultBaseUrl: string;
  config: SourceConfig;
  status: { lastRunAt: string | null; error: string | null; items: number; usedThisHour: number };
}

export type StoredRelease = ReleaseInfo & { source: string; sourceName: string; seenAt: string };

const key = (title: string) => titleKey(cleanTitle(title).query);

/**
 * The release sources an admin has switched on: their settings, a rate-limited client each,
 * a store of what they've listed, and "a wishlist game showed up in a source" alerts.
 */
export class SourceRegistry {
  private clients = new Map<string, { sig: string; client: SourceClient }>();
  private status = new Map<string, { lastRunAt: string | null; error: string | null }>();
  private running: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly wishlist: WishlistService,
    private readonly notifier: Notifier,
    private readonly fetchImpl: FetchLike = fetch,
    readonly adapters: ReleaseSource[] = ADAPTERS,
    private readonly resolveHost?: (host: string) => Promise<string[]>,
  ) {}

  private stored(): Record<string, Partial<SourceConfig>> {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    return json<Record<string, Partial<SourceConfig>>>(row?.value, {});
  }

  config(a: ReleaseSource): SourceConfig {
    const s = this.stored()[a.id] ?? {};
    return {
      enabled: s.enabled ?? false,
      baseUrl: s.baseUrl || a.defaultBaseUrl,
      apiKey: s.apiKey ?? "",
      perMinute: s.perMinute ?? a.limits?.perMinute ?? 6,
      perHour: s.perHour ?? a.limits?.perHour ?? 60,
      extraHosts: s.extraHosts ?? [],
      onMyNetwork: s.onMyNetwork ?? false,
      displayName: a.nameable ? (s.displayName ?? "") : "",
    };
  }

  /** What to call a source: the admin's name for it, or the adapter's. */
  label(a: ReleaseSource, c: SourceConfig = this.config(a)): string {
    return c.displayName || a.name;
  }

  private adapter(id: string): ReleaseSource {
    const a = this.adapters.find((x) => x.id === id);
    if (!a) throw new Error("No such source");
    return a;
  }

  /** Saves a source's settings; a masked key keeps the stored one. */
  save(id: string, patch: Partial<SourceConfig>): SourceView {
    const a = this.adapter(id);
    const cur = this.config(a);
    const next: SourceConfig = {
      enabled: patch.enabled ?? cur.enabled,
      baseUrl: (patch.baseUrl ?? cur.baseUrl).trim(),
      apiKey: patch.apiKey === undefined || patch.apiKey === MASK ? cur.apiKey : patch.apiKey.trim(),
      perMinute: Math.max(1, Math.min(120, Math.round(Number(patch.perMinute ?? cur.perMinute)) || 1)),
      perHour: Math.max(1, Math.min(5000, Math.round(Number(patch.perHour ?? cur.perHour)) || 1)),
      extraHosts: (patch.extraHosts ?? cur.extraHosts).map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9.-]+$/.test(h)),
      onMyNetwork: patch.onMyNetwork ?? cur.onMyNetwork,
      displayName: a.nameable ? String(patch.displayName ?? cur.displayName).trim().slice(0, 80) : "",
    };
    if (next.baseUrl && !/^https?:\/\/[^/]+/i.test(next.baseUrl)) throw new Error("The address must start with http:// or https://");
    if (next.enabled && !next.baseUrl) throw new Error(`${this.label(a, next)} needs an address first`);
    const all = this.stored();
    all[id] = next;
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(all));
    return this.view(a);
  }

  private client(a: ReleaseSource, c: SourceConfig): SourceClient {
    const hosts = [new URL(c.baseUrl).hostname, ...c.extraHosts];
    const sig = JSON.stringify([hosts, c.perMinute, c.perHour, c.onMyNetwork, c.displayName]);
    const hit = this.clients.get(a.id);
    if (hit?.sig === sig) return hit.client;
    const client = new SourceClient(this.label(a, c), { hosts, perMinute: c.perMinute, perHour: c.perHour, allowPrivate: c.onMyNetwork }, this.fetchImpl, this.resolveHost);
    this.clients.set(a.id, { sig, client });
    return client;
  }

  private view(a: ReleaseSource): SourceView {
    const c = this.config(a);
    const st = this.status.get(a.id);
    const items = (this.db.prepare("SELECT COUNT(*) AS n FROM source_items WHERE source = ?").get(a.id) as { n: number }).n;
    return {
      id: a.id,
      name: this.label(a, c),
      defaultName: a.name,
      nameable: !!a.nameable,
      description: a.description,
      needsKey: !!a.needsKey,
      defaultBaseUrl: a.defaultBaseUrl,
      config: { ...c, apiKey: c.apiKey ? MASK : "" },
      status: { lastRunAt: st?.lastRunAt ?? null, error: st?.error ?? null, items, usedThisHour: this.clients.get(a.id)?.client.usedThisHour ?? 0 },
    };
  }

  list(): SourceView[] {
    return this.adapters.map((a) => this.view(a));
  }

  /** Fetches one source now and stores what's new; returns how many items it listed. */
  async refresh(id: string): Promise<number> {
    const a = this.adapter(id);
    const c = this.config(a);
    if (!c.baseUrl) throw new Error(`${this.label(a, c)} needs an address first`);
    try {
      const items = (await a.latest({ config: c, client: this.client(a, c) })).slice(0, 200);
      const fresh = this.store(a, items);
      this.status.set(id, { lastRunAt: now(), error: null });
      await this.alert(a, fresh);
      return items.length;
    } catch (err) {
      this.status.set(id, { lastRunAt: now(), error: (err as Error).message });
      throw err;
    }
  }

  private store(a: ReleaseSource, items: ReleaseInfo[]): ReleaseInfo[] {
    const fresh: ReleaseInfo[] = [];
    const exists = this.db.prepare("SELECT 1 FROM source_items WHERE id = ?");
    const insert = this.db.prepare("INSERT INTO source_items (id, source, title, date, platform, url, image, summary, details, downloads, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    // Links change (mirrors die, new ones get added), so a release seen before still gets the current ones.
    const relink = this.db.prepare("UPDATE source_items SET downloads = ? WHERE id = ?");
    for (const r of items) {
      const id = `${a.id}|${r.id}`.slice(0, 500);
      const downloads = cleanDownloads(r.downloads);
      const links = downloads ? JSON.stringify(downloads) : null;
      if (exists.get(id)) {
        relink.run(links, id);
        continue;
      }
      insert.run(id, a.id, r.title.slice(0, 300), r.date, r.platform, r.url, r.image ?? null, r.summary ?? null, r.details ? JSON.stringify(r.details) : null, links, now());
      fresh.push(r);
    }
    // Keep the newest 500 per source.
    this.db.prepare("DELETE FROM source_items WHERE source = ? AND id NOT IN (SELECT id FROM source_items WHERE source = ? ORDER BY seen_at DESC, rowid DESC LIMIT 500)").run(a.id, a.id);
    return fresh;
  }

  /** A newly listed release whose title matches a wishlist game you don't own yet. */
  private async alert(a: ReleaseSource, fresh: ReleaseInfo[]): Promise<void> {
    if (!fresh.length) return;
    const wanted = new Map(this.wishlist.list().filter((w) => !w.libraryId).map((w) => [key(w.title), w]));
    for (const r of fresh) {
      const w = wanted.get(key(r.title));
      if (w) await this.notifier.send("sources", `${w.title} showed up in ${this.label(a)}`, [r.title, r.date].filter(Boolean).join(" · "), "/wishlist");
    }
  }

  /** The scheduled pass over every switched-on source. One failing source doesn't stop the rest. */
  run(): Promise<void> {
    this.running ??= (async () => {
      for (const a of this.adapters) {
        if (!this.config(a).enabled) continue;
        await this.refresh(a.id).catch(() => null);
      }
    })().finally(() => (this.running = null));
    return this.running;
  }

  private row(r: Record<string, unknown>): StoredRelease {
    const source = String(r.source);
    const a = this.adapters.find((x) => x.id === source);
    return {
      id: String(r.id),
      source,
      sourceName: a ? this.label(a) : source,
      title: String(r.title),
      date: (r.date as string | null) ?? null,
      platform: (r.platform as string | null) ?? null,
      url: (r.url as string | null) ?? null,
      image: (r.image as string | null) ?? null,
      summary: (r.summary as string | null) ?? null,
      details: json<Record<string, string> | undefined>(r.details, undefined),
      downloads: json<StoredRelease["downloads"]>(r.downloads, undefined),
      seenAt: String(r.seen_at),
    };
  }

  /** The newest releases across switched-on sources. */
  latest(limit = 40): StoredRelease[] {
    const on = this.adapters.filter((a) => this.config(a).enabled).map((a) => a.id);
    if (!on.length) return [];
    const rows = this.db
      .prepare(`SELECT * FROM source_items WHERE source IN (${on.map(() => "?").join(",")}) ORDER BY COALESCE(date, substr(seen_at, 1, 10)) DESC, seen_at DESC LIMIT ?`)
      .all(...on, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.row(r));
  }

  /** One stored release, by the id Discover shows. */
  item(id: string): StoredRelease | undefined {
    const r = this.db.prepare("SELECT * FROM source_items WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r && this.row(r);
  }

  /** Stored releases whose title matches (for a wishlist game or a Discover page). */
  forTitle(title: string): StoredRelease[] {
    const k = key(title);
    return this.latest(500).filter((r) => key(r.title) === k);
  }

  /** Asks every switched-on source that can search. */
  async search(query: string): Promise<StoredRelease[]> {
    const out: StoredRelease[] = [];
    for (const a of this.adapters) {
      const c = this.config(a);
      if (!c.enabled || !a.search) continue;
      const items = await a.search({ config: c, client: this.client(a, c) }, query).catch(() => []);
      out.push(...items.map((r) => ({ ...r, source: a.id, sourceName: this.label(a, c), seenAt: now() })));
    }
    return out;
  }
}
