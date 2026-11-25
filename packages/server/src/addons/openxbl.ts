import type { FetchLike } from "../metadata/http.js";

/** OpenXBL's API. It moved from xbl.io/api to api.xbl.io; the old address can answer with an empty history. */
export const OPENXBL_API = "https://api.xbl.io";
const LEGACY_API = "https://xbl.io/api";

/** A game in an Xbox account's title history, as Xbox Live's TitleHub (relayed by OpenXBL) describes it. */
export interface TitleHubTitle {
  titleId?: string;
  name?: string;
  type?: string;
  /** Where the account has played it: "XboxSeries", "XboxOne", "Xbox360", "PC", "Mobile"... */
  devices?: string[];
  displayImage?: string;
  /** The Microsoft Store product id ("9NBLGGH4R315"). */
  bingId?: string;
  titleHistory?: { lastTimePlayed?: string };
}

type HistoryBody = TitleHubTitle[] | { titles?: TitleHubTitle[]; content?: { titles?: TitleHubTitle[] } | TitleHubTitle[]; data?: { titles?: TitleHubTitle[] } };

function titlesOf(body: HistoryBody): TitleHubTitle[] {
  if (Array.isArray(body)) return body;
  if (body.titles) return body.titles;
  if (Array.isArray(body.content)) return body.content;
  return body.content?.titles ?? body.data?.titles ?? [];
}

/**
 * The games an account has played, from OpenXBL's current title history (/v2/titles), with the
 * old address as a fallback while it still answers. Errors are worded for the person.
 */
export async function openXblTitles(apiKey: string, fetch: FetchLike): Promise<TitleHubTitle[]> {
  let firstError: Error | null = null;
  for (const url of [`${OPENXBL_API}/v2/titles`, `${LEGACY_API}/v2/player/titleHistory`]) {
    const res = await fetch(url, { headers: { "X-Authorization": apiKey, Accept: "application/json", "Accept-Language": "en-US" } }).catch(() => null);
    if (!res) {
      firstError ??= new Error("Couldn't reach OpenXBL");
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error("OpenXBL refused the key; copy it again from xbl.io");
    if (res.status === 429) throw new Error("OpenXBL's hourly limit was reached; try again later");
    if (!res.ok) {
      firstError ??= new Error(`OpenXBL answered ${res.status}`);
      continue;
    }
    const titles = titlesOf((await res.json().catch(() => ({}))) as HistoryBody);
    if (titles.length) return titles;
  }
  if (firstError) throw firstError;
  return [];
}
