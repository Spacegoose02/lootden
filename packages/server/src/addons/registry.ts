import { lookup } from "node:dns/promises";
import type { AddonView, StoreGame } from "@lootden/shared";
import { json, now, type Db } from "../db/database.js";
import type { Library } from "../catalog/library.js";
import { titleKey } from "../metadata/calendar.js";
import type { FetchLike } from "../metadata/http.js";
import { cleanTitle } from "../metadata/titles.js";
import { isPrivateAddress } from "../sources/client.js";
import { ADDONS } from "./index.js";
import type { LibraryAddon, OwnedGame } from "./types.js";

const KEY = "addons";
const MASK = "********";

interface AccountRow {
  user_id: number;
  addon: string;
  config: string;
  connected_at: string;
  last_sync_at: string | null;
  error: string | null;
}

interface GameRow {
  addon: string;
  external_id: string;
  title: string;
  cover_url: string | null;
  store_url: string | null;
  launch_url: string | null;
  playtime_seconds: number | null;
  last_played_at: string | null;
}

/**
 * Library add-ons: each person connects their own store accounts on their profile, and the
 * games those accounts own are kept here, synced on connect, on request and twice a day.
 * Admins can switch an add-on off for the whole server.
 */
export class AddonRegistry {
  private syncing = new Map<string, Promise<number>>();

  constructor(
    private readonly db: Db,
    private readonly library: Library,
    private readonly fetchImpl: FetchLike = fetch,
    readonly addons: LibraryAddon[] = ADDONS,
    private readonly resolveHost: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address),
  ) {}

  // ---- Server-wide switches ---------------------------------------------------------

  private switches(): Record<string, { enabled?: boolean }> {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    return json<Record<string, { enabled?: boolean }>>(row?.value, {});
  }

  enabled(id: string): boolean {
    return this.switches()[id]?.enabled !== false;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.addon(id);
    const next = { ...this.switches(), [id]: { enabled } };
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(next));
  }

  private addon(id: string): LibraryAddon {
    const a = this.addons.find((x) => x.id === id);
    if (!a) throw new Error("No such add-on");
    return a;
  }

  // ---- A person's accounts ------------------------------------------------------------

  private account(userId: number, id: string): AccountRow | undefined {
    return this.db.prepare("SELECT * FROM addon_accounts WHERE user_id = ? AND addon = ?").get(userId, id) as AccountRow | undefined;
  }

  list(userId: number): AddonView[] {
    const counts = new Map(
      (this.db.prepare("SELECT addon, COUNT(*) AS n FROM store_games WHERE user_id = ? GROUP BY addon").all(userId) as Array<{ addon: string; n: number }>).map((r) => [r.addon, r.n]),
    );
    return this.addons.map((a) => {
      const row = this.account(userId, a.id);
      const config = json<Record<string, string>>(row?.config, {});
      const masked = Object.fromEntries(a.fields.map((f) => [f.key, f.oneTime ? "" : f.secret && config[f.key] ? MASK : (config[f.key] ?? "")]));
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        homepage: a.homepage ?? null,
        fields: a.fields,
        enabled: this.enabled(a.id),
        account: row ? { config: masked, connectedAt: row.connected_at, lastSyncAt: row.last_sync_at, error: row.error, games: counts.get(a.id) ?? 0 } : null,
      };
    });
  }

  /** Saves the account's settings (a masked secret keeps the stored one), then syncs it. */
  async connect(userId: number, id: string, input: Record<string, unknown>, opts: { allowPrivate?: boolean } = {}): Promise<number> {
    const a = this.addon(id);
    if (!this.enabled(id)) throw new Error(`${a.name} is switched off on this server`);
    const cur = json<Record<string, string>>(this.account(userId, id)?.config, {});
    // Values the add-on saved itself (tokens) carry over; the fields are replaced.
    const config: Record<string, string> = { ...cur };
    for (const f of a.fields) {
      const v = typeof input[f.key] === "string" ? (input[f.key] as string).trim() : undefined;
      config[f.key] = v === undefined || (f.secret && v === MASK) || (f.oneTime && !v) ? (cur[f.key] ?? "") : v;
      if (f.required && !config[f.key]) throw new Error(`${f.label} is needed`);
    }
    this.db
      .prepare(
        `INSERT INTO addon_accounts (user_id, addon, config, connected_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, addon) DO UPDATE SET config = excluded.config, error = NULL`,
      )
      .run(userId, id, JSON.stringify(config), now());
    return this.sync(userId, id, opts);
  }

  disconnect(userId: number, id: string): void {
    this.db.prepare("DELETE FROM store_games WHERE user_id = ? AND addon = ?").run(userId, id);
    this.db.prepare("DELETE FROM addon_accounts WHERE user_id = ? AND addon = ?").run(userId, id);
  }

  /** Fetches the account's games and replaces the stored list. Returns how many it owns. */
  sync(userId: number, id: string, opts: { allowPrivate?: boolean } = {}): Promise<number> {
    const key = `${userId}:${id}`;
    const running = this.syncing.get(key);
    if (running) return running;
    const job = this.runSync(userId, id, !!opts.allowPrivate).finally(() => this.syncing.delete(key));
    this.syncing.set(key, job);
    return job;
  }

  private async runSync(userId: number, id: string, allowPrivate: boolean): Promise<number> {
    const a = this.addon(id);
    const row = this.account(userId, id);
    if (!row) throw new Error(`Connect ${a.name} first`);
    let games: OwnedGame[];
    const config = json<Record<string, string>>(row.config, {});
    // Saved straight away: a sign-in code is used up and a refreshed token replaces the old one, even if the sync then fails.
    const save = (patch: Record<string, string>) => {
      Object.assign(config, patch);
      this.db.prepare("UPDATE addon_accounts SET config = ? WHERE user_id = ? AND addon = ?").run(JSON.stringify(config), userId, id);
    };
    try {
      games = await a.games({ config: { ...config }, fetch: this.guardedFetch(allowPrivate), save });
    } catch (err) {
      const message = (err as Error).message || String(err);
      this.db.prepare("UPDATE addon_accounts SET error = ?, last_sync_at = ? WHERE user_id = ? AND addon = ?").run(message, now(), userId, id);
      throw new Error(`${a.name}: ${message}`);
    }
    const seen = new Set<string>();
    const upsert = this.db.prepare(
      `INSERT INTO store_games (user_id, addon, external_id, title, cover_url, store_url, launch_url, playtime_seconds, last_played_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, addon, external_id) DO UPDATE SET title = excluded.title, cover_url = excluded.cover_url, store_url = excluded.store_url,
         launch_url = excluded.launch_url, playtime_seconds = excluded.playtime_seconds, last_played_at = excluded.last_played_at, synced_at = excluded.synced_at`,
    );
    const at = now();
    this.db.exec("BEGIN");
    try {
      for (const g of games) {
        const ext = String(g.externalId);
        if (!ext || !g.title || seen.has(ext)) continue;
        seen.add(ext);
        const launch = g.launchUrl ?? a.launchUrl?.(ext) ?? null;
        upsert.run(userId, id, ext, g.title, g.coverUrl ?? null, g.storeUrl ?? null, launch, g.playtimeSeconds ?? null, g.lastPlayedAt ?? null, at);
      }
      // Games the account no longer lists (refunded, removed from the list).
      this.db.prepare("DELETE FROM store_games WHERE user_id = ? AND addon = ? AND synced_at <> ?").run(userId, id, at);
      this.db.prepare("UPDATE addon_accounts SET error = NULL, last_sync_at = ? WHERE user_id = ? AND addon = ?").run(at, userId, id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return seen.size;
  }

  /** Every connected account, for the twice-daily sync. Failures are kept on the account. */
  async syncAll(): Promise<void> {
    const rows = this.db.prepare("SELECT a.user_id, a.addon, u.role FROM addon_accounts a JOIN users u ON u.id = a.user_id").all() as Array<{ user_id: number; addon: string; role: string }>;
    for (const r of rows) {
      if (!this.addons.some((a) => a.id === r.addon) || !this.enabled(r.addon)) continue;
      await this.sync(r.user_id, r.addon, { allowPrivate: r.role === "admin" }).catch(() => {});
    }
  }

  // ---- The games ------------------------------------------------------------------------

  /** This person's store games, with the LootDen library game of the same title when there is one. */
  games(userId: number, addon?: string): StoreGame[] {
    const names = new Map(this.addons.map((a) => [a.id, a.name]));
    const rows = (
      addon
        ? this.db.prepare("SELECT * FROM store_games WHERE user_id = ? AND addon = ? ORDER BY title COLLATE NOCASE").all(userId, addon)
        : this.db.prepare("SELECT * FROM store_games WHERE user_id = ? ORDER BY title COLLATE NOCASE").all(userId)
    ) as unknown as GameRow[];
    const library = new Map<string, string>();
    for (const g of this.library.list()) library.set(titleKey(cleanTitle(g.title).query), g.id);
    return rows
      .filter((r) => names.has(r.addon) && this.enabled(r.addon))
      .map((r) => ({
        addon: r.addon,
        store: names.get(r.addon)!,
        externalId: r.external_id,
        title: r.title,
        coverUrl: r.cover_url,
        storeUrl: r.store_url,
        launchUrl: r.launch_url,
        playtimeSeconds: r.playtime_seconds,
        lastPlayedAt: r.last_played_at,
        libraryGameId: library.get(titleKey(cleanTitle(r.title).query)) ?? null,
      }));
  }

  /**
   * fetch for add-ons: 30 second timeout, and no addresses on the server's own network unless
   * an admin set the account up (so a profile can't make the server read the LAN), redirects included.
   */
  private guardedFetch(allowPrivate: boolean): FetchLike {
    return (async (input: string | URL | Request, init: RequestInit = {}) => {
      let url = new URL(input instanceof Request ? input.url : String(input));
      for (let hop = 0; hop < 5; hop++) {
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Add-ons can only call http and https addresses");
        if (!allowPrivate) {
          const host = url.hostname.replace(/^\[|\]$/g, "");
          const ips = await this.resolveHost(host).catch(() => [] as string[]);
          if (ips.some(isPrivateAddress)) throw new Error(`${url.hostname} is on the server's own network; only an admin's account can use it`);
        }
        const res = await this.fetchImpl(url, { ...init, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(30_000) });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (!location) return res;
        url = new URL(location, url);
      }
      throw new Error("Too many redirects");
    }) as FetchLike;
  }
}
