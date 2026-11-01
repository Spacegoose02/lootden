import type { LibraryAddon, OwnedGame } from "./types.js";

// The PlayStation App's public sign-in, the one community PSN libraries (psn-api, PSNAWP) use.
const AUTH = "https://ca.account.sony.com/api/authz/v3/oauth";
const CLIENT_ID = "09515159-7237-4370-9b40-3806e67c0891";
const BASIC = "MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=";
const REDIRECT = "com.scee.psxandroid.scecompcall://redirect";
const SCOPE = "psn:mobile.v2.core psn:clientapp";
const TITLES = "https://m.np.playstation.com/api/gamelist/v2/users/me/titles";

/** "PT12H3M4.5S" in seconds. */
export function isoDurationSeconds(d: string | undefined): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(d ?? "");
  if (!m) return null;
  const s = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return s > 0 ? Math.round(s) : null;
}

/** The npsso from what was pasted: the code, or the JSON Sony's page shows. */
export function npssoOf(input: string): string {
  const t = input.trim();
  try {
    const j = JSON.parse(t) as { npsso?: string };
    if (j.npsso) return j.npsso;
  } catch {
    // Not JSON.
  }
  return t.replace(/^"|"$/g, "");
}

interface PsnTitle {
  titleId?: string;
  name?: string;
  imageUrl?: string;
  category?: string;
  playDuration?: string;
  lastPlayedDateTime?: string;
  concept?: { id?: number };
}

export function psnGames(titles: PsnTitle[]): OwnedGame[] {
  const out = new Map<string, OwnedGame>();
  for (const t of titles) {
    if (!t.titleId || !t.name) continue;
    // A game on PS4 and PS5 is one concept; keep the one played most.
    const id = t.concept?.id ? `concept-${t.concept.id}` : t.titleId;
    const g: OwnedGame = {
      externalId: id,
      title: t.name.replace(/[™®©]/g, "").trim(),
      coverUrl: t.imageUrl ?? null,
      storeUrl: t.concept?.id ? `https://store.playstation.com/concept/${t.concept.id}` : null,
      playtimeSeconds: isoDurationSeconds(t.playDuration),
      lastPlayedAt: t.lastPlayedDateTime ?? null,
    };
    const had = out.get(id);
    if (had) {
      g.playtimeSeconds = (had.playtimeSeconds ?? 0) + (g.playtimeSeconds ?? 0) || null;
      if ((had.lastPlayedAt ?? "") > (g.lastPlayedAt ?? "")) g.lastPlayedAt = had.lastPlayedAt;
    }
    out.set(id, g);
  }
  return [...out.values()];
}

/** PlayStation: the PS4 and PS5 games you've played, with play time, through your PSN account. */
export const playstation: LibraryAddon = {
  id: "playstation",
  name: "PlayStation",
  description: "The PS4 and PS5 games you've played, with play time. Sign in on Sony's site once and paste the code it shows; LootDen keeps the sign-in fresh for about two months.",
  homepage: "https://www.playstation.com/",
  fields: [
    {
      key: "npsso",
      label: "PlayStation npsso code",
      oneTime: true,
      secret: true,
      link: { url: "https://ca.account.sony.com/api/v1/ssocookie", label: "Get the code from Sony" },
      help: 'Sign in at playstation.com first, then open the link: it shows {"npsso":"…"}. Paste all of it. Only needed the first time, or when PlayStation signs LootDen out.',
    },
  ],
  async games({ config, fetch, save }) {
    const token = async (body: Record<string, string>) => {
      const res = await fetch(`${AUTH}/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${BASIC}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...body, token_format: "jwt" }).toString(),
      });
      const b = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string };
      if (!res.ok || !b.access_token) return null;
      save({ npsso: "", refreshToken: b.refresh_token ?? config.refreshToken ?? "" });
      return b.access_token;
    };
    let access: string | null = null;
    if (config.npsso) {
      const url = new URL(`${AUTH}/authorize`);
      for (const [k, v] of Object.entries({ access_type: "offline", client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: SCOPE })) url.searchParams.set(k, v);
      const res = await fetch(url, { headers: { Cookie: `npsso=${npssoOf(config.npsso)}` }, redirect: "manual" });
      const code = /[?&]code=([^&]+)/.exec(res.headers.get("location") ?? "")?.[1];
      if (!code) throw new Error("PlayStation didn't accept that code. Sign in at playstation.com, open the code link again and paste what it shows");
      access = await token({ code: decodeURIComponent(code), redirect_uri: REDIRECT, grant_type: "authorization_code" });
      if (!access) throw new Error("PlayStation's sign-in failed; get a new code and try again");
    } else if (config.refreshToken) {
      access = await token({ refresh_token: config.refreshToken, grant_type: "refresh_token", scope: SCOPE });
      if (!access) throw new Error("PlayStation signed LootDen out (it does after about two months). Get a new code from Sony and paste it");
    } else throw new Error("Paste the code from Sony's page first");

    const titles: PsnTitle[] = [];
    for (let offset = 0, page = 0; page < 20; page++) {
      const url = new URL(TITLES);
      url.searchParams.set("categories", "ps4_game,ps5_native_game");
      url.searchParams.set("limit", "200");
      url.searchParams.set("offset", String(offset));
      const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
      if (!res.ok) throw new Error(`PlayStation's game list answered ${res.status}`);
      const b = (await res.json()) as { titles?: PsnTitle[]; nextOffset?: number | null };
      titles.push(...(b.titles ?? []));
      if (b.nextOffset == null || !b.titles?.length) break;
      offset = b.nextOffset;
    }
    return psnGames(titles);
  },
};
