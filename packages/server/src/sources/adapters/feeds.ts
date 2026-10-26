import type { ReleaseSource } from "../types.js";
import { isoDate, parseFeed } from "./util.js";

/** Any RSS or Atom feed of game releases (a store's "new" feed, a blog, your own list). */
export const rssFeed: ReleaseSource = {
  id: "rss",
  name: "RSS or Atom feed",
  nameable: true,
  description: "Any RSS or Atom feed of game releases at an address you choose.",
  defaultBaseUrl: "",
  limits: { perMinute: 6, perHour: 60 },
  latest: async (ctx) => parseFeed(await ctx.client.text(ctx.config.baseUrl), `rss:${ctx.config.baseUrl}`),
};

/** itch.io's public feed of newly published games. */
export const itchNew: ReleaseSource = {
  id: "itch-new",
  name: "itch.io new games",
  description: "Games just published on itch.io, from its public feed.",
  defaultBaseUrl: "https://itch.io/feed/new.xml",
  limits: { perMinute: 2, perHour: 12 },
  latest: async (ctx) =>
    parseFeed(await ctx.client.text(ctx.config.baseUrl), "itch").map((r) => ({
      ...r,
      platform: /\[(windows|linux|macos)\]/i.test(r.title) ? "pc" : null,
      title: r.title.replace(/\s*\[[^\]]*\]/g, "").trim(),
      details: { Store: "itch.io" },
    })),
};

/** GOG's catalogue, newest releases first (the same public API the store page uses). */
export const gogNew: ReleaseSource = {
  id: "gog-new",
  name: "GOG new releases",
  description: "Games newly released on GOG, from its public catalogue.",
  defaultBaseUrl: "https://catalog.gog.com",
  limits: { perMinute: 4, perHour: 30 },
  latest: async (ctx) => {
    const url = `${ctx.config.baseUrl.replace(/\/+$/, "")}/v1/catalog?limit=48&order=desc:releaseDate&productType=in:game&releaseStatuses=in:new-arrival`;
    const data = await ctx.client.json<{ products?: Array<{ id: string | number; title: string; slug?: string; storeLink?: string; releaseDate?: string; coverHorizontal?: string; price?: { final?: string } }> }>(url);
    return (data.products ?? []).map((p) => ({
      id: `gog:${p.id}`,
      title: p.title,
      date: isoDate(p.releaseDate),
      platform: "pc",
      url: p.storeLink ?? (p.slug ? `https://www.gog.com/en/game/${p.slug}` : null),
      image: p.coverHorizontal ?? null,
      details: { Store: "GOG", ...(p.price?.final ? { Price: p.price.final } : {}) },
    }));
  },
};
