import { isXboxConsoleId, XBOX_CONSOLE_ADDON, xboxRemotePlayUrl } from "@lootden/shared";
import { openXblTitles, type TitleHubTitle } from "./openxbl.js";
import type { LibraryAddon, OwnedGame } from "./types.js";

/**
 * Xbox consoles, as Xbox Live's title history names the devices a game was played on
 * ("XboxSeries", "XboxOne", "Xbox360"; older records use the code names).
 */
const CONSOLE = /^(xbox(?!app|pc)|scarlett|durango|xenon|anaconda|lockhart)/;
const isConsole = (device: string) => CONSOLE.test(device.toLowerCase().replace(/[^a-z0-9]/g, ""));

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
    const titles = await openXblTitles(config.apiKey ?? "", fetch);
    const link = xboxRemotePlayUrl(consoleId || null);
    const out: OwnedGame[] = [];
    const games = titles.filter((t): t is TitleHubTitle & { titleId: string; name: string } => !!t.titleId && !!t.name && (!t.type || t.type === "Game"));
    for (const t of games) {
      // Apps (Netflix, the Xbox app) are in the history too, as are games only played on a PC or
      // phone. A title with no device list is kept: there's no telling where it was played.
      if (t.devices?.length && !t.devices.some(isConsole)) continue;
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
    // An empty list syncs as "0 games" with no clue why; say what OpenXBL sent instead.
    if (!titles.length) throw new Error("OpenXBL sent an empty game history for this key. Check the key is from the Microsoft account you play on (xbl.io shows the gamertag), and that your Xbox privacy settings (account.xbox.com/settings, Privacy) let others see your game and app history");
    if (!out.length) {
      const seen = [...new Set(games.flatMap((t) => t.devices ?? []))].join(", ") || "none";
      throw new Error(`OpenXBL lists ${games.length} games for this account, but none played on an Xbox (devices it named: ${seen})`);
    }
    return out;
  },
};
