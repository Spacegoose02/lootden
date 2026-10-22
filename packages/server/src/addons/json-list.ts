import type { LibraryAddon, OwnedGame } from "./types.js";

/**
 * A games list at an address you choose: for stores without an add-on yet, or a list exported
 * from another launcher. Also the template for writing your own add-on.
 *
 * Accepts a JSON array, or { "games": [...] }, of objects like
 *   { "id": "123", "title": "Dredge", "store": "itch", "cover": "https://…", "url": "https://…",
 *     "launch": "itch://games/123", "playtimeMinutes": 240, "lastPlayed": "2026-10-01" }
 * Only id (or title) and title are required.
 */
export const jsonList: LibraryAddon = {
  id: "json-list",
  name: "Other library",
  description: "Any other store or launcher: a JSON list of your games at an address you choose.",
  fields: [
    { key: "url", label: "List address", placeholder: "https://example.com/my-games.json", required: true, help: "A JSON array of games, each with at least a title" },
    { key: "token", label: "Access token (optional)", secret: true, help: "Sent as a Bearer token" },
  ],
  async games({ config, fetch }) {
    const url = new URL(config.url ?? "");
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The list address must start with http:// or https://");
    const res = await fetch(url, { headers: config.token ? { Authorization: `Bearer ${config.token}` } : {} });
    if (!res.ok) throw new Error(`The list address answered ${res.status}`);
    const body = (await res.json()) as unknown;
    const items = Array.isArray(body) ? body : Array.isArray((body as { games?: unknown })?.games) ? (body as { games: unknown[] }).games : null;
    if (!items) throw new Error("The list isn't a JSON array of games");
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const out: OwnedGame[] = [];
    for (const raw of items as Array<Record<string, unknown>>) {
      const title = str(raw?.title) ?? str(raw?.name);
      if (!title) continue;
      const minutes = Number(raw.playtimeMinutes);
      out.push({
        externalId: str(String(raw.id ?? "")) ?? title,
        title,
        coverUrl: str(raw.cover),
        storeUrl: str(raw.url),
        launchUrl: str(raw.launch),
        playtimeSeconds: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : null,
        lastPlayedAt: str(raw.lastPlayed),
      });
    }
    return out;
  },
};
