import { deckRating, protonTier, type GameCompat } from "@lootden/shared";
import { json, now, type Db } from "../db/database.js";
import type { FetchLike } from "../metadata/http.js";

const WEEK = 7 * 24 * 3600_000;
const UA = { "User-Agent": "Mozilla/5.0 (LootDen)" };

/**
 * How a Steam game runs on Linux and the Steam Deck: ProtonDB's rating and Valve's Deck rating.
 * Both are public and need no key; answers are kept a week.
 */
export class CompatService {
  private readonly pending = new Map<string, Promise<GameCompat>>();

  constructor(
    private readonly db: Db,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  cached(appId: string): GameCompat | null {
    const row = this.db.prepare("SELECT data, fetched_at FROM compat_cache WHERE app_id = ?").get(appId) as { data: string; fetched_at: string } | undefined;
    return row ? json<GameCompat | null>(row.data, null) : null;
  }

  async get(appId: string): Promise<GameCompat> {
    if (!/^\d{1,10}$/.test(appId)) throw new Error("Not a Steam app id");
    const hit = this.cached(appId);
    if (hit && Date.now() - Date.parse(hit.fetchedAt) < WEEK) return hit;
    let p = this.pending.get(appId);
    if (!p) {
      p = this.fetchBoth(appId, hit).finally(() => this.pending.delete(appId));
      this.pending.set(appId, p);
    }
    return p;
  }

  private async fetchBoth(appId: string, old: GameCompat | null): Promise<GameCompat> {
    const [proton, deck] = await Promise.all([this.protondb(appId).catch(() => undefined), this.deck(appId).catch(() => undefined)]);
    // A source that failed keeps last week's answer rather than wiping it.
    const out: GameCompat = {
      steamAppId: appId,
      protondb: proton === undefined ? (old?.protondb ?? null) : proton,
      deck: deck === undefined ? (old?.deck ?? null) : deck,
      fetchedAt: now(),
    };
    this.db
      .prepare("INSERT INTO compat_cache (app_id, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(app_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at")
      .run(appId, JSON.stringify(out), out.fetchedAt);
    return out;
  }

  private async protondb(appId: string): Promise<GameCompat["protondb"]> {
    const res = await this.fetchImpl(`https://www.protondb.com/api/v1/reports/summaries/${appId}.json`, { headers: UA, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`ProtonDB answered ${res.status}`);
    const b = (await res.json()) as { tier?: string; trendingTier?: string; total?: number; confidence?: string };
    const tier = protonTier(b.tier);
    return tier ? { tier, trending: protonTier(b.trendingTier), reports: Number(b.total) || 0, confidence: b.confidence ?? null } : null;
  }

  private async deck(appId: string): Promise<GameCompat["deck"]> {
    const res = await this.fetchImpl(`https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${appId}&l=english`, { headers: UA, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Steam answered ${res.status}`);
    const b = (await res.json()) as { success?: number; results?: { resolved_category?: number } | [] };
    if (!b.results || Array.isArray(b.results)) return null;
    return deckRating(b.results.resolved_category);
  }
}
