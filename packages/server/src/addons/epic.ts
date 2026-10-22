import type { LibraryAddon, OwnedGame } from "./types.js";

// Epic has no public library API. These are the Epic Games Launcher's public credentials, the
// same ones Legendary and Heroic sign in with.
const BASIC = Buffer.from("34a02cf8f4414e29b15921876da36f9a:daafbccc737745039dffe53d94fc76cf").toString("base64");
const OAUTH = "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token";
const LIBRARY = "https://library-service.live.use1a.on.epicgames.com/library/api/public/items";
const CATALOG = "https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace";
export const EPIC_LOGIN_URL = "https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fwww.epicgames.com%2Fid%2Fapi%2Fredirect%3FclientId%3D34a02cf8f4414e29b15921876da36f9a%26responseType%3Dcode";

interface LibraryRecord {
  namespace: string;
  catalogItemId: string;
  appName: string;
  sandboxType?: string;
}

interface CatalogItem {
  title?: string;
  keyImages?: Array<{ type: string; url: string }>;
  categories?: Array<{ path: string }>;
  mainGameItem?: unknown;
  customAttributes?: Record<string, { value?: string }>;
}

/** The code from what was pasted: the code, or the JSON Epic's redirect page shows. */
export function epicCode(input: string): string {
  const t = input.trim();
  try {
    const j = JSON.parse(t) as { authorizationCode?: string };
    if (j.authorizationCode) return j.authorizationCode;
  } catch {
    // Not JSON: the code itself.
  }
  return t.replace(/^"|"$/g, "");
}

/** Epic Games: the games on an Epic account, after signing in once with a code from Epic's page. */
export const epic: LibraryAddon = {
  id: "epic",
  name: "Epic Games",
  description: "Your Epic Games Store games, including the free ones you claimed. Sign in once on Epic's page; LootDen keeps the sign-in fresh after that.",
  homepage: "https://store.epicgames.com/",
  fields: [
    {
      key: "code",
      label: "Epic sign-in code",
      oneTime: true,
      secret: true,
      link: { url: EPIC_LOGIN_URL, label: "Sign in to Epic" },
      help: 'Sign in; the page then shows a short text with "authorizationCode". Paste all of it (or just the code). Only needed the first time.',
    },
  ],
  async games({ config, fetch, save }) {
    const token = async (params: Record<string, string>) => {
      const res = await fetch(OAUTH, {
        method: "POST",
        headers: { Authorization: `Basic ${BASIC}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, token_type: "eg1" }).toString(),
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string };
      if (!res.ok || !body.access_token || !body.refresh_token) return null;
      save({ code: "", refreshToken: body.refresh_token });
      return body.access_token;
    };
    let access: string | null = null;
    if (config.code) {
      access = await token({ grant_type: "authorization_code", code: epicCode(config.code) });
      if (!access) throw new Error("Epic didn't accept that code. Codes work once and only for a few minutes; sign in again and paste the new one");
    } else if (config.refreshToken) {
      access = await token({ grant_type: "refresh_token", refresh_token: config.refreshToken });
      if (!access) throw new Error("Epic signed LootDen out. Use Sign in to Epic again and paste the new code");
    } else throw new Error("Use Sign in to Epic, then paste the code");
    const auth = { Authorization: `Bearer ${access}` };

    const records: LibraryRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const url = new URL(LIBRARY);
      url.searchParams.set("includeMetadata", "true");
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url, { headers: auth });
      if (!res.ok) throw new Error(`Epic's library answered ${res.status}`);
      const body = (await res.json()) as { records?: LibraryRecord[]; responseMetadata?: { nextCursor?: string } };
      records.push(...(body.records ?? []));
      cursor = body.responseMetadata?.nextCursor;
      if (!cursor) break;
    }

    // Unreal Engine marketplace assets live in the "ue" namespace; private sandboxes are test builds.
    const owned = records.filter((r) => r.namespace !== "ue" && r.sandboxType !== "PRIVATE" && r.appName);
    const byNamespace = new Map<string, LibraryRecord[]>();
    for (const r of owned) byNamespace.set(r.namespace, [...(byNamespace.get(r.namespace) ?? []), r]);

    const out: OwnedGame[] = [];
    for (const [ns, recs] of byNamespace) {
      const url = new URL(`${CATALOG}/${encodeURIComponent(ns)}/bulk/items`);
      for (const r of recs) url.searchParams.append("id", r.catalogItemId);
      url.searchParams.set("includeDLCDetails", "true");
      url.searchParams.set("country", "US");
      url.searchParams.set("locale", "en");
      const res = await fetch(url, { headers: auth });
      const items = res.ok ? ((await res.json()) as Record<string, CatalogItem>) : {};
      for (const r of recs) {
        const item = items[r.catalogItemId];
        // Add-ons and DLC point at their main game; only the games themselves are listed.
        if (!item?.title || item.mainGameItem || item.categories?.some((c) => c.path === "addons" || c.path === "digitalextras")) continue;
        const image = (type: string) => item.keyImages?.find((k) => k.type === type)?.url;
        const slug = item.customAttributes?.["com.epicgames.app.productSlug"]?.value;
        out.push({
          externalId: r.appName,
          title: item.title,
          coverUrl: image("DieselGameBoxTall") ?? image("OfferImageTall") ?? image("Thumbnail") ?? image("DieselGameBox") ?? null,
          storeUrl: slug ? `https://store.epicgames.com/p/${slug.replace(/\/home$/, "")}` : null,
          launchUrl: `com.epicgames.launcher://apps/${encodeURIComponent(`${r.namespace}:${r.catalogItemId}:${r.appName}`)}?action=launch&silent=true`,
        });
      }
    }
    return out;
  },
};
