import type { LibraryAddon, OwnedGame } from "./types.js";

// GOG has no public API for libraries. These are the GOG Galaxy client's public credentials,
// the same ones Heroic, Playnite and lgogdownloader sign in with.
const CLIENT_ID = "46899977096215655";
const CLIENT_SECRET = "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9";
const REDIRECT = "https://embed.gog.com/on_login_success?origin=client";
export const GOG_LOGIN_URL = `https://auth.gog.com/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&layout=client2`;

interface Token {
  access_token?: string;
  refresh_token?: string;
  error_description?: string;
}

interface ProductsPage {
  totalPages?: number;
  products?: Array<{ id: number; title?: string; image?: string; url?: string; isGame?: boolean }>;
}

/** The code from what was pasted: the code itself, or the whole address GOG ended on. */
export function gogCode(input: string): string {
  const t = input.trim();
  try {
    return new URL(t).searchParams.get("code") ?? t;
  } catch {
    return t;
  }
}

/** GOG: the games on a GOG account, after signing in once with a code from GOG's sign-in page. */
export const gog: LibraryAddon = {
  id: "gog",
  name: "GOG",
  description: "Your GOG games. Sign in once on GOG's page; LootDen keeps the sign-in fresh after that.",
  homepage: "https://www.gog.com/",
  fields: [
    {
      key: "code",
      label: "GOG sign-in code",
      oneTime: true,
      secret: true,
      link: { url: GOG_LOGIN_URL, label: "Sign in to GOG" },
      help: "Sign in, then paste the address the page ends on (or just the code after code=). Only needed the first time.",
    },
  ],
  async games({ config, fetch, save }) {
    const token = async (params: Record<string, string>) => {
      const url = new URL("https://auth.gog.com/token");
      for (const [k, v] of Object.entries({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params })) url.searchParams.set(k, v);
      const res = await fetch(url);
      const body = (await res.json().catch(() => ({}))) as Token;
      if (!res.ok || !body.access_token || !body.refresh_token) return null;
      save({ code: "", refreshToken: body.refresh_token });
      return body.access_token;
    };
    let access: string | null = null;
    if (config.code) {
      access = await token({ grant_type: "authorization_code", code: gogCode(config.code), redirect_uri: REDIRECT });
      if (!access) throw new Error("GOG didn't accept that code. Codes work once and only for a few minutes; sign in again and paste the new one");
    } else if (config.refreshToken) {
      access = await token({ grant_type: "refresh_token", refresh_token: config.refreshToken });
      if (!access) throw new Error("GOG signed LootDen out. Use Sign in to GOG again and paste the new code");
    } else throw new Error("Use Sign in to GOG, then paste the code");

    const out: OwnedGame[] = [];
    for (let page = 1, pages = 1; page <= pages && page <= 50; page++) {
      const res = await fetch(`https://embed.gog.com/account/getFilteredProducts?mediaType=1&sortBy=title&page=${page}`, { headers: { Authorization: `Bearer ${access}` } });
      if (!res.ok) throw new Error(`GOG answered ${res.status}`);
      const body = (await res.json()) as ProductsPage;
      pages = body.totalPages ?? 1;
      for (const p of body.products ?? []) {
        if (!p.title || p.isGame === false) continue;
        out.push({
          externalId: String(p.id),
          title: p.title,
          // GOG's product images are a base address; a size suffix picks the variant.
          coverUrl: p.image ? `https:${p.image.replace(/^https?:/, "")}_392.jpg` : null,
          storeUrl: p.url ? `https://www.gog.com${p.url.startsWith("/") ? "" : "/"}${p.url.replace(/^https?:\/\/www\.gog\.com/, "")}` : null,
        });
      }
    }
    return out;
  },
  launchUrl: (id) => `goggalaxy://openGameView/${id}`,
};
