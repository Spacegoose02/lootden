import type { WorkshopItem } from "@lootden/shared";
import type { FetchLike } from "../metadata/http.js";

const API = "https://api.steampowered.com";

/** A Workshop link ("…/filedetails/?id=123") or a bare id, as the id. */
export function workshopId(input: string): string | null {
  const s = input.trim();
  const m = s.match(/[?&]id=(\d{4,20})/) ?? s.match(/^(\d{4,20})$/);
  return m ? m[1]! : null;
}

interface FileDetails {
  publishedfileid?: string;
  result?: number;
  title?: string;
  preview_url?: string;
  file_size?: string | number;
  time_updated?: number;
  subscriptions?: number;
  lifetime_subscriptions?: number;
  short_description?: string;
  description?: string;
  consumer_app_id?: number;
  consumer_appid?: number;
  creator_app_id?: number;
}

function item(d: FileDetails): WorkshopItem | null {
  if (!d.publishedfileid || (d.result !== undefined && d.result !== 1) || !d.title) return null;
  const text = (d.short_description ?? d.description ?? "").replace(/\[[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
  return {
    id: d.publishedfileid,
    appId: String(d.consumer_app_id ?? d.consumer_appid ?? d.creator_app_id ?? ""),
    title: d.title,
    previewUrl: d.preview_url || null,
    sizeBytes: Number(d.file_size ?? 0),
    updatedAt: d.time_updated ? new Date(d.time_updated * 1000).toISOString() : null,
    subscriptions: d.lifetime_subscriptions ?? d.subscriptions ?? 0,
    summary: text.length > 200 ? `${text.slice(0, 197)}…` : text,
    url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${d.publishedfileid}`,
  };
}

/**
 * Steam Workshop items for a game: details by id need no key; browsing and searching a game's
 * Workshop take a Steam Web API key (the one set for the Steam library add-on).
 */
export class SteamWorkshop {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async details(ids: string[]): Promise<WorkshopItem[]> {
    const clean = [...new Set(ids.filter((id) => /^\d{4,20}$/.test(id)))].slice(0, 50);
    if (!clean.length) return [];
    const body = new URLSearchParams({ itemcount: String(clean.length) });
    clean.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));
    const res = await this.fetchImpl(`${API}/ISteamRemoteStorage/GetPublishedFileDetails/v1/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Steam answered ${res.status}`);
    const data = (await res.json()) as { response?: { publishedfiledetails?: FileDetails[] } };
    return (data.response?.publishedfiledetails ?? []).map(item).filter((x): x is WorkshopItem => !!x);
  }

  /** The game's most popular items, or the ones matching a search. */
  async browse(appId: string, key: string, query = "", page = 1): Promise<{ items: WorkshopItem[]; total: number }> {
    if (!/^\d+$/.test(appId)) throw new Error("This game has no Steam app id");
    if (!key) throw new Error("Browsing the Workshop needs a Steam Web API key");
    const url = new URL(`${API}/IPublishedFileService/QueryFiles/v1/`);
    const params: Record<string, string> = {
      key,
      appid: appId,
      // 12: ranked by text search; 3: most subscribed of all time.
      query_type: query ? "12" : "3",
      numperpage: "24",
      page: String(Math.max(1, Math.min(page, 50))),
      return_details: "true",
      return_short_description: "true",
      filetype: "0",
    };
    if (query) params.search_text = query.slice(0, 100);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url.toString(), { signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) throw new Error("Steam refused the Web API key");
    if (!res.ok) throw new Error(`Steam answered ${res.status}`);
    const data = (await res.json()) as { response?: { total?: number; publishedfiledetails?: FileDetails[] } };
    return { items: (data.response?.publishedfiledetails ?? []).map(item).filter((x): x is WorkshopItem => !!x), total: data.response?.total ?? 0 };
  }
}
