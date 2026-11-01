import type { LibraryAddon, OwnedGame } from "./types.js";

const BASE = "https://www.humblebundle.com";

interface HumbleOrder {
  gamekey?: string;
  product?: { human_name?: string };
  subproducts?: Array<{ machine_name?: string; human_name?: string; icon?: string; url?: string; downloads?: Array<{ platform?: string }> }>;
}

const GAME_PLATFORMS = new Set(["windows", "mac", "linux"]);

/** The cookie's value from what was pasted: the value, "_simpleauth_sess=…" or a whole Cookie header. */
export function humbleSession(input: string): string {
  const t = input.trim();
  const m = /_simpleauth_sess=("?)([^";\s]+)\1/.exec(t);
  return (m ? m[2]! : t).replace(/^"|"$/g, "");
}

/** The games (not books, music or software keys) in Humble orders: their DRM-free downloads. */
export function humbleGames(orders: HumbleOrder[]): OwnedGame[] {
  const out = new Map<string, OwnedGame>();
  for (const o of orders) {
    for (const s of o.subproducts ?? []) {
      if (!s.machine_name || !s.human_name) continue;
      if (!(s.downloads ?? []).some((d) => GAME_PLATFORMS.has(String(d.platform)))) continue;
      if (out.has(s.machine_name)) continue;
      out.set(s.machine_name, {
        externalId: s.machine_name,
        title: s.human_name.replace(/[™®©]/g, "").trim(),
        coverUrl: s.icon ?? null,
        storeUrl: o.gamekey ? `${BASE}/downloads?key=${encodeURIComponent(o.gamekey)}` : `${BASE}/home/library`,
      });
    }
  }
  return [...out.values()];
}

/**
 * Humble Bundle: the DRM-free games in your Humble library (keys for other stores show up
 * under those stores once redeemed). Humble has no public API, so it signs in with the
 * website's session cookie, like the community backup tools do.
 */
export const humble: LibraryAddon = {
  id: "humble",
  name: "Humble Bundle",
  description: "The DRM-free games in your Humble Bundle library. Humble has no sign-in for apps, so this uses your website session cookie.",
  homepage: `${BASE}/home/library`,
  fields: [
    {
      key: "session",
      label: "Session cookie (_simpleauth_sess)",
      required: true,
      secret: true,
      link: { url: `${BASE}/login`, label: "Sign in to Humble" },
      help: "Signed in to humblebundle.com, open the browser's developer tools (F12), Storage or Application, Cookies, and copy the value of _simpleauth_sess. It lasts about two years unless you sign out.",
    },
  ],
  async games({ config, fetch }) {
    const cookie = `_simpleauth_sess="${humbleSession(config.session ?? "")}"`;
    const headers = { Cookie: cookie, "X-Requested-With": "XMLHttpRequest", Accept: "application/json" };
    const res = await fetch(`${BASE}/api/v1/user/order?ajax=true`, { headers });
    if (res.status === 401 || res.status === 403) throw new Error("Humble didn't accept the session cookie; sign in on humblebundle.com and copy it again");
    if (!res.ok) throw new Error(`Humble answered ${res.status}`);
    const keys = ((await res.json()) as Array<{ gamekey?: string }>).map((o) => o.gamekey).filter((k): k is string => !!k);
    const orders: HumbleOrder[] = [];
    for (let i = 0; i < keys.length; i += 40) {
      const url = new URL(`${BASE}/api/v1/orders`);
      url.searchParams.set("all_tpkds", "false");
      for (const k of keys.slice(i, i + 40)) url.searchParams.append("gamekeys", k);
      const r = await fetch(url, { headers });
      if (r.ok) {
        orders.push(...Object.values((await r.json()) as Record<string, HumbleOrder>));
        continue;
      }
      // Older accounts: one order at a time.
      for (const k of keys.slice(i, i + 40)) {
        const one = await fetch(`${BASE}/api/v1/order/${encodeURIComponent(k)}?ajax=true`, { headers });
        if (one.ok) orders.push((await one.json()) as HumbleOrder);
      }
    }
    return humbleGames(orders);
  },
};
