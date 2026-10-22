import { steamCover } from "../metadata/steam.js";
import { resolveSteamId } from "../news/wishlist.js";
import type { LibraryAddon } from "./types.js";

interface OwnedGamesResponse {
  response?: {
    game_count?: number;
    games?: Array<{ appid: number; name?: string; playtime_forever?: number; rtime_last_played?: number }>;
  };
}

/** Steam: every game the account owns, with play time, from the Steam Web API. */
export const steam: LibraryAddon = {
  id: "steam",
  name: "Steam",
  description: "Your Steam games and play time. Needs a free Steam Web API key, and your profile's Game details set to Public.",
  homepage: "https://steamcommunity.com/dev/apikey",
  fields: [
    { key: "steamId", label: "Steam profile", required: true, placeholder: "https://steamcommunity.com/id/yourname", help: "Your profile link, custom URL name or 17-digit Steam ID" },
    { key: "apiKey", label: "Steam Web API key", required: true, secret: true, help: "From steamcommunity.com/dev/apikey (any domain name works)" },
  ],
  async games({ config, fetch }) {
    const steamId = await resolveSteamId(config.steamId ?? "", fetch);
    const url = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
    url.searchParams.set("key", config.apiKey ?? "");
    url.searchParams.set("steamid", steamId);
    url.searchParams.set("include_appinfo", "1");
    url.searchParams.set("include_played_free_games", "1");
    const res = await fetch(url);
    if (res.status === 401 || res.status === 403) throw new Error("Steam refused the API key; check it at steamcommunity.com/dev/apikey");
    if (!res.ok) throw new Error(`Steam answered ${res.status}`);
    const body = (await res.json()) as OwnedGamesResponse;
    // A private profile (or private game details) comes back as an empty response.
    if (!body.response?.games) throw new Error("Steam listed no games. In Steam, Edit Profile, Privacy Settings, set Game details to Public");
    return body.response.games
      .filter((g) => g.name)
      .map((g) => ({
        externalId: String(g.appid),
        title: g.name!,
        coverUrl: steamCover(String(g.appid)),
        storeUrl: `https://store.steampowered.com/app/${g.appid}`,
        playtimeSeconds: g.playtime_forever ? g.playtime_forever * 60 : null,
        lastPlayedAt: g.rtime_last_played ? new Date(g.rtime_last_played * 1000).toISOString() : null,
      }));
  },
  launchUrl: (appId) => `steam://rungameid/${appId}`,
};
