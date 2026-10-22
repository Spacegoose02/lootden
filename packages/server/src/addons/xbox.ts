import type { LibraryAddon, OwnedGame } from "./types.js";

interface TitleHubTitle {
  titleId?: string;
  name?: string;
  type?: string;
  devices?: string[];
  displayImage?: string;
  /** The Microsoft Store product id ("9NBLGGH4R315"). */
  bingId?: string;
  titleHistory?: { lastTimePlayed?: string };
}

/**
 * Xbox: the games an Xbox account has played (on console and PC), through OpenXBL, a free
 * service that relays Xbox Live for people who sign in there with their Microsoft account.
 */
export const xbox: LibraryAddon = {
  id: "xbox",
  name: "Xbox",
  description: "Games your Xbox account has played on console or PC, through a free OpenXBL key.",
  homepage: "https://xbl.io/",
  fields: [
    {
      key: "apiKey",
      label: "OpenXBL API key",
      required: true,
      secret: true,
      link: { url: "https://xbl.io/", label: "Get a key at xbl.io" },
      help: "Sign in there with your Microsoft account, then copy the personal API key",
    },
  ],
  async games({ config, fetch }) {
    const res = await fetch("https://xbl.io/api/v2/player/titleHistory", { headers: { "X-Authorization": config.apiKey ?? "", Accept: "application/json" } });
    if (res.status === 401 || res.status === 403) throw new Error("OpenXBL refused the key; copy it again from xbl.io");
    if (res.status === 429) throw new Error("OpenXBL's hourly limit was reached; try again later");
    if (!res.ok) throw new Error(`OpenXBL answered ${res.status}`);
    const body = (await res.json()) as { titles?: TitleHubTitle[]; content?: { titles?: TitleHubTitle[] } };
    const titles = body.titles ?? body.content?.titles ?? [];
    const out: OwnedGame[] = [];
    for (const t of titles) {
      // Apps (Netflix, the Xbox app itself) are in the history too.
      if (!t.titleId || !t.name || (t.type && t.type !== "Game")) continue;
      // Xbox 360 and Xbox One only games can't be started from a PC; they're still listed.
      out.push({
        externalId: t.titleId,
        title: t.name,
        coverUrl: t.displayImage ? t.displayImage.replace(/^http:/, "https:") : null,
        storeUrl: t.bingId ? `https://www.xbox.com/games/store/x/${t.bingId}` : null,
        launchUrl: t.bingId && t.devices?.includes("PC") ? `msxbox://game/?productId=${t.bingId}` : null,
        lastPlayedAt: t.titleHistory?.lastTimePlayed ?? null,
      });
    }
    return out;
  },
};
