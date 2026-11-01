import type { PriceSettings, WishPrice } from "@lootden/shared";
import { json, now, type Db } from "../db/database.js";
import type { Notifier } from "../alerts/notifier.js";
import type { FetchLike } from "../metadata/http.js";
import type { WishlistService } from "../news/wishlist.js";

const KEY = "prices";
const API = "https://api.isthereanydeal.com";
const DEFAULTS: PriceSettings = { apiKey: "", country: "US", minCut: 0, atLow: true };

interface Row {
  wish_id: number;
  itad_id: string | null;
  itad_slug: string | null;
  price: number | null;
  regular: number | null;
  cut: number;
  shop: string | null;
  url: string | null;
  currency: string | null;
  low: number | null;
  target: number | null;
  alerted: number | null;
  checked_at: string | null;
  error: string | null;
}

interface PriceDeal {
  shop?: { name?: string };
  price?: { amount?: number; currency?: string };
  regular?: { amount?: number };
  cut?: number;
  url?: string;
}

interface PriceAnswer {
  id: string;
  historyLow?: { all?: { amount?: number } | null } | null;
  deals?: PriceDeal[];
}

/** Rounds money to cents so float noise never re-sends an alert. */
const cents = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

/** Whether a price is worth an alert: at or under the target, at the lowest ever, or far enough off. */
export function dealWorthAlert(p: { price: number | null; cut: number; low: number | null; target: number | null }, s: Pick<PriceSettings, "minCut" | "atLow">): boolean {
  if (p.price == null) return false;
  if (p.target != null && p.price <= p.target) return true;
  if (s.atLow && p.low != null && p.cut > 0 && p.price <= p.low) return true;
  return s.minCut > 0 && p.cut >= s.minCut;
}

/**
 * Wishlist prices from IsThereAnyDeal (free API key from isthereanydeal.com/apps/my): the
 * cheapest shop right now, the lowest price ever, and an alert when one goes on sale.
 */
export class PriceService {
  constructor(
    private readonly db: Db,
    private readonly wishlist: WishlistService,
    private readonly notifier: Notifier,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  settings(): PriceSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    return { ...DEFAULTS, ...json<Partial<PriceSettings>>(row?.value ?? "{}", {}) };
  }

  /** What the page sees: the key masked. */
  view(): PriceSettings & { hasKey: boolean } {
    const s = this.settings();
    return { ...s, apiKey: s.apiKey ? "********" : "", hasKey: !!s.apiKey };
  }

  saveSettings(patch: Partial<PriceSettings>): PriceSettings & { hasKey: boolean } {
    const cur = this.settings();
    const next: PriceSettings = {
      apiKey: patch.apiKey === undefined || patch.apiKey === "********" ? cur.apiKey : String(patch.apiKey).trim().slice(0, 100),
      country: patch.country === undefined ? cur.country : /^[A-Za-z]{2}$/.test(String(patch.country)) ? String(patch.country).toUpperCase() : cur.country,
      minCut: patch.minCut === undefined ? cur.minCut : Math.max(0, Math.min(99, Math.round(Number(patch.minCut) || 0))),
      atLow: patch.atLow === undefined ? cur.atLow : !!patch.atLow,
    };
    if (next.country !== cur.country) this.db.prepare("UPDATE wish_prices SET price = NULL, regular = NULL, low = NULL, alerted = NULL").run();
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(next));
    return this.view();
  }

  list(): WishPrice[] {
    const rows = this.db.prepare("SELECT * FROM wish_prices").all() as unknown as Row[];
    return rows.map((r) => ({
      wishId: r.wish_id,
      price: r.price,
      regular: r.regular,
      cut: r.cut,
      shop: r.shop,
      url: r.url,
      currency: r.currency,
      low: r.low,
      target: r.target,
      itadUrl: r.itad_slug ? `https://isthereanydeal.com/game/${encodeURIComponent(r.itad_slug)}/info/` : null,
      checkedAt: r.checked_at,
      error: r.error,
    }));
  }

  setTarget(wishId: number, target: number | null): void {
    if (!this.wishlist.list().some((w) => w.id === wishId)) throw new Error("That game isn't on the wishlist");
    const t = target == null || !Number.isFinite(target) || target <= 0 ? null : cents(target);
    this.db.prepare("INSERT INTO wish_prices (wish_id, target) VALUES (?, ?) ON CONFLICT(wish_id) DO UPDATE SET target = excluded.target, alerted = NULL").run(wishId, t);
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const { apiKey } = this.settings();
    const url = new URL(path, API);
    url.searchParams.set("key", apiKey);
    const res = await this.fetchImpl(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401 || res.status === 403) throw new Error("IsThereAnyDeal refused the API key");
    if (!res.ok) throw new Error(`IsThereAnyDeal answered ${res.status}`);
    return (await res.json()) as T;
  }

  /** IsThereAnyDeal's id for a game: by Steam app id when known, else by title. */
  private async lookup(title: string, steamAppId: number | null): Promise<{ id: string; slug: string | null } | null> {
    const q = steamAppId ? `appid=${steamAppId}` : `title=${encodeURIComponent(title)}`;
    let b = await this.call<{ found?: boolean; game?: { id: string; slug?: string } }>(`/games/lookup/v1?${q}`);
    if (!b.found && steamAppId) b = await this.call(`/games/lookup/v1?title=${encodeURIComponent(title)}`);
    return b.found && b.game?.id ? { id: b.game.id, slug: b.game.slug ?? null } : null;
  }

  /** Checks every wishlist game's price and sends alerts. Returns how many are on sale. */
  async check(): Promise<{ checked: number; onSale: number }> {
    const s = this.settings();
    if (!s.apiKey) throw new Error("Add an IsThereAnyDeal API key first");
    const items = this.wishlist.list().filter((w) => !w.libraryId);
    const rows = new Map((this.db.prepare("SELECT * FROM wish_prices").all() as unknown as Row[]).map((r) => [r.wish_id, r]));
    const ids = new Map<string, number[]>();
    for (const w of items) {
      let r = rows.get(w.id);
      if (!r?.itad_id) {
        try {
          const found = await this.lookup(w.title, w.steamAppId);
          this.db
            .prepare(
              `INSERT INTO wish_prices (wish_id, itad_id, itad_slug, checked_at, error) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(wish_id) DO UPDATE SET itad_id = excluded.itad_id, itad_slug = excluded.itad_slug, checked_at = excluded.checked_at, error = excluded.error`,
            )
            .run(w.id, found?.id ?? null, found?.slug ?? null, now(), found ? null : "Not found on IsThereAnyDeal");
          if (!found) continue;
          r = { ...(r ?? ({ target: null, alerted: null } as Row)), itad_id: found.id };
        } catch (err) {
          if (/refused the API key/.test((err as Error).message)) throw err;
          continue;
        }
      }
      ids.set(r.itad_id!, [...(ids.get(r.itad_id!) ?? []), w.id]);
    }
    const all = [...ids.keys()];
    let onSale = 0;
    for (let i = 0; i < all.length; i += 100) {
      const answers = await this.call<PriceAnswer[]>(`/games/prices/v3?country=${s.country}&nondeals=true&vouchers=false`, { method: "POST", body: JSON.stringify(all.slice(i, i + 100)) });
      for (const a of answers) {
        const best = (a.deals ?? []).filter((d) => d.price?.amount != null).sort((x, y) => x.price!.amount! - y.price!.amount!)[0];
        for (const wishId of ids.get(a.id) ?? []) {
          const before = this.db.prepare("SELECT target, alerted FROM wish_prices WHERE wish_id = ?").get(wishId) as { target: number | null; alerted: number | null } | undefined;
          const p = { price: cents(best?.price?.amount), regular: cents(best?.regular?.amount), cut: Math.round(best?.cut ?? 0), low: cents(a.historyLow?.all?.amount), target: before?.target ?? null };
          if (p.cut > 0) onSale++;
          const worth = dealWorthAlert(p, s);
          // One alert per drop: again only when it gets cheaper than the price last alerted.
          const alert = worth && p.price != null && (before?.alerted == null || p.price < before.alerted);
          this.db
            .prepare("UPDATE wish_prices SET price = ?, regular = ?, cut = ?, shop = ?, url = ?, currency = ?, low = ?, checked_at = ?, error = NULL, alerted = ? WHERE wish_id = ?")
            .run(p.price, p.regular, p.cut, best?.shop?.name ?? null, best?.url ?? null, best?.price?.currency ?? null, p.low, now(), alert ? p.price : worth ? (before?.alerted ?? null) : null, wishId);
          if (alert) {
            const w = items.find((x) => x.id === wishId);
            const money = new Intl.NumberFormat("en", { style: "currency", currency: best?.price?.currency ?? "USD" }).format(p.price!);
            const why = p.target != null && p.price! <= p.target ? "at or under your target" : p.low != null && p.price! <= p.low ? "its lowest price ever" : `${p.cut}% off`;
            await this.notifier.send("deals", `${w?.title ?? "A wishlist game"} is ${money}`, `${why} at ${best?.shop?.name ?? "a shop"}${p.cut ? ` (${p.cut}% off)` : ""}`, "/wishlist");
          }
        }
      }
    }
    return { checked: all.length, onSale };
  }

  /** The twice-daily check; quiet when there's no key. */
  async scheduled(): Promise<void> {
    if (this.settings().apiKey) await this.check();
  }
}
