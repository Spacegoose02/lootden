/*
 * Example adapter: a plain JSON feed you host yourself.
 *
 * Copy this file to make your own source. An adapter is an object with an id, a name, a
 * default address and a latest() function that returns ReleaseInfo items. LootDen gives
 * latest() a `client` whose fetch only reaches the source's own host (plus any extra hosts
 * set in Settings), keeps to the rate limits set there, times out, and waits and retries
 * when the server answers 429. Then list the adapter in adapters/index.ts.
 *
 * This one reads JSON Feed 1.1 (https://jsonfeed.org), or the simpler shape below, and
 * follows `next_url` for more pages:
 *
 *   { "items": [ { "id": "1", "title": "Some Game", "date": "2026-10-13",
 *                  "platform": "pc", "url": "https://…", "image": "https://…",
 *                  "summary": "…", "details": { "Store": "GOG" },
 *                  "downloads": [ { "title": "…", "uris": ["magnet:?…", "https://…"], "fileSize": "4 GB" } ] } ],
 *     "next_url": "https://…?page=2" }
 *
 * If the source needs a key, it is sent as "Authorization: Bearer <key>".
 */
import { paginate } from "../client.js";
import type { ReleaseInfo, ReleaseSource, SourceContext } from "../types.js";
import { isoDate } from "./util.js";

interface FeedItem {
  id?: string | number;
  title?: string;
  date?: string;
  date_published?: string;
  platform?: string;
  url?: string;
  external_url?: string;
  image?: string;
  banner_image?: string;
  summary?: string;
  content_text?: string;
  details?: Record<string, unknown>;
  /** Links to the release itself (Hydra-style): [{ title, uris: ["magnet:…", "https://…"], fileSize }]. */
  downloads?: Array<{ title?: string; uris?: unknown; fileSize?: string; size?: string }>;
}

function toRelease(item: FeedItem, base: string): ReleaseInfo | null {
  const title = item.title?.trim();
  if (!title) return null;
  const url = item.url ?? item.external_url ?? null;
  const details = item.details ? Object.fromEntries(Object.entries(item.details).filter(([, v]) => typeof v === "string" || typeof v === "number").map(([k, v]) => [k, String(v)])) : undefined;
  return {
    id: `json:${base}:${item.id ?? url ?? title}`,
    title,
    date: isoDate(item.date ?? item.date_published),
    platform: item.platform?.toLowerCase() ?? null,
    url,
    image: item.image ?? item.banner_image ?? null,
    summary: (item.summary ?? item.content_text ?? "").slice(0, 300) || null,
    details,
    downloads: Array.isArray(item.downloads)
      ? item.downloads.map((d) => ({ title: d.title ?? null, uris: Array.isArray(d.uris) ? d.uris.map(String) : [], size: d.fileSize ?? d.size ?? null }))
      : undefined,
  };
}

async function read(ctx: SourceContext, first: string): Promise<ReleaseInfo[]> {
  const headers: Record<string, string> = ctx.config.apiKey ? { Authorization: `Bearer ${ctx.config.apiKey}` } : {};
  let next: string | null = first;
  const items = await paginate(async () => {
    if (!next) return { items: [], more: false };
    const page: { items?: FeedItem[]; next_url?: string } | FeedItem[] = await ctx.client.json(next, { headers });
    const list = Array.isArray(page) ? page : (page.items ?? []);
    next = Array.isArray(page) ? null : (page.next_url ?? null);
    return { items: list, more: !!next };
  }, 3);
  return items.map((i) => toRelease(i, ctx.config.baseUrl)).filter((r): r is ReleaseInfo => !!r);
}

export const jsonFeed: ReleaseSource = {
  id: "json-feed",
  name: "JSON feed (example)",
  nameable: true,
  description: "Any JSON Feed, or a list of {title, date, url} items, at an address you choose. Also the template for writing your own source.",
  defaultBaseUrl: "",
  needsKey: true,
  limits: { perMinute: 10, perHour: 120 },
  latest: (ctx) => read(ctx, ctx.config.baseUrl),
  search: async (ctx, query) => {
    const url = new URL(ctx.config.baseUrl);
    url.searchParams.set("q", query);
    return read(ctx, url.toString());
  },
};
