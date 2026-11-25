import { isXboxConsoleId, XBOX_CONSOLE_ADDON, xboxRemotePlayUrl } from "@lootden/shared";
import type { LibraryAddon, OwnedGame } from "./types.js";

interface TitleHubTitle {
  titleId?: string;
  name?: string;
  type?: string;
  /** Where the account has played it: "XboxSeries", "XboxOne", "Xbox360", "PC", "Mobile"... */
  devices?: string[];
  displayImage?: string;
  bingId?: string;
  titleHistory?: { lastTimePlayed?: string };
}

/** Xbox consoles, as Xbox Live's title history names the devices a game was played on. */
const CONSOLES = ["xboxseries", "xboxseriess", "xboxseriesx", "xboxone", "xbox360", "xbox"];

/**
 * Xbox console games for remote play: the games the account has played on an Xbox console, each
 * with a Play remotely link that streams it from the console itself (xbox.com/play, not Game
 * Pass cloud gaming). The same OpenXBL key as the Xbox add-on; LootDen can't ask a console what
 * it has installed (Microsoft's console API needs the Xbox app's own sign-in), so the list is
 * what the account has played there, which is the closest a key can get.
 */
export const xboxConsole: LibraryAddon = {
  id: XBOX_CONSOLE_ADDON,
  name: "Xbox console",
  description: "Games you've played on your Xbox, with Play remotely to stream them from the console itself. Needs the same free OpenXBL key as the Xbox add-on.",
  homepage: "https://www.xbox.com/consoles/remote-play",
  fields: [
    {
      key: "apiKey",
      label: "OpenXBL API key",
      required: true,
      secret: true,
      link: { url: "https://xbl.io/", label: "Get a key at xbl.io" },
      help: "Sign in there with your Microsoft account, then copy the personal API key (the same one the Xbox add-on uses)",
    },
    {
      key: "consoleId",
      label: "Console id (optional)",
      placeholder: "F4001A2B3C4D5E6F",
      help: "The 16-character id in the address bar when you start remote play on xbox.com/play/consoles. With it, Play remotely goes straight to your console; without it, to the console list.",
    },
  ],
  async games({ config, fetch }) {
    const consoleId = (config.consoleId ?? "").trim();
    if (consoleId && !isXboxConsoleId(consoleId))
      throw new Error("That console id isn't 16 characters of 0-9 and A-F. Start remote play on xbox.com/play/consoles and copy the id from the address bar, or leave it empty");
    const res = await fetch("https://xbl.io/api/v2/player/titleHistory", {
      headers: {
        "X-Authorization": config.apiKey ?? "",
        Accept: "application/json",
      },
    });
    if (res.status === 401 || res.status === 403) throw new Error("OpenXBL refused the key; copy it again from xbl.io");
    if (res.status === 429) throw new Error("OpenXBL's hourly limit was reached; try again later");
    if (!res.ok) throw new Error(`OpenXBL answered ${res.status}`);
    const body = (await res.json()) as {
      titles?: TitleHubTitle[];
      content?: { titles?: TitleHubTitle[] };
    };
    const titles = body.titles ?? body.content?.titles ?? [];
    const link = xboxRemotePlayUrl(consoleId || null);
    const out: OwnedGame[] = [];
    for (const t of titles) {
      // Apps (Netflix, the Xbox app) are in the history too, as are games only played on a PC or phone.
      if (!t.titleId || !t.name || (t.type && t.type !== "Game")) continue;
      if (!t.devices?.some((d) => CONSOLES.includes(d.toLowerCase().replace(/[^a-z0-9]/g, "")))) continue;
      out.push({
        externalId: t.titleId,
        title: t.name,
        coverUrl: t.displayImage ? t.displayImage.replace(/^http:/, "https:") : null,
        storeUrl: t.bingId ? `https://www.xbox.com/games/store/x/${t.bingId}` : null,
        // Remote play streams the console itself: the stream opens on whatever the console is
        // showing, and the game starts from there. Microsoft took launching a title by id out of
        // the protocol in 2019, so no link can start one game.
        launchUrl: link,
        lastPlayedAt: t.titleHistory?.lastTimePlayed ?? null,
      });
    }
    return out;
  },
};
