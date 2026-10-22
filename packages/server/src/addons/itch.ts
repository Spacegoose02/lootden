import type { LibraryAddon, OwnedGame } from "./types.js";

interface OwnedKeysPage {
  owned_keys?: Array<{ game_id?: number; game?: { id: number; title?: string; cover_url?: string | null; url?: string; classification?: string } }>;
  per_page?: number;
  errors?: string[];
}

/** itch.io: the games an itch.io account bought or claimed, with an API key from the account settings. */
export const itch: LibraryAddon = {
  id: "itch",
  name: "itch.io",
  description: "Games you bought or claimed on itch.io, including bundles.",
  homepage: "https://itch.io/user/settings/api-keys",
  fields: [
    {
      key: "apiKey",
      label: "itch.io API key",
      required: true,
      secret: true,
      link: { url: "https://itch.io/user/settings/api-keys", label: "Make a key" },
      help: "Generate a new API key and paste it here",
    },
  ],
  async games({ config, fetch }) {
    const out: OwnedGame[] = [];
    const seen = new Set<number>();
    for (let page = 1; page <= 200; page++) {
      const res = await fetch(`https://itch.io/api/1/${encodeURIComponent(config.apiKey ?? "")}/my-owned-keys?page=${page}`);
      const body = (await res.json().catch(() => ({}))) as OwnedKeysPage;
      if (body.errors?.length) throw new Error(/invalid key/i.test(body.errors[0]!) ? "itch.io refused the API key; make a new one in your itch.io settings" : body.errors[0]!);
      if (!res.ok) throw new Error(`itch.io answered ${res.status}`);
      const keys = body.owned_keys ?? [];
      for (const k of keys) {
        const g = k.game;
        // Soundtracks, comics, tools and assets are on itch.io too; games only.
        if (!g?.title || seen.has(g.id) || (g.classification && g.classification !== "game")) continue;
        seen.add(g.id);
        out.push({ externalId: String(g.id), title: g.title, coverUrl: g.cover_url ?? null, storeUrl: g.url ?? null, launchUrl: `itch://games/${g.id}` });
      }
      if (keys.length < (body.per_page ?? 50) || !keys.length) break;
    }
    return out;
  },
};
