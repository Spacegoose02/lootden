// Roblox experiences an admin picks for the library. Each one is shown only to the profiles the
// admin chose, under the "Roblox" store, and Play opens the Roblox app straight into it.

/** The add-on id Roblox games carry as store games (badges, the Library's store filter). */
export const ROBLOX_ADDON = "roblox";

/** A Roblox experience on the server, as an admin manages it. */
export interface RobloxGame {
  /** Roblox's universe id: the experience itself. */
  universeId: string;
  /** The place Play starts in (the experience's start place). */
  placeId: string;
  name: string;
  description: string | null;
  creator: string | null;
  /** Square icon (Roblox's 512x512), used as the cover. */
  iconUrl: string | null;
  /** Wide screenshot, used as the page background. */
  thumbnailUrl: string | null;
  /** Roblox's own age recommendation ("Ages 9+"), when it gives one. */
  ageRating: string | null;
  genre: string | null;
  maxPlayers: number | null;
  /** When an admin uploaded their own cover (used instead of the poster LootDen makes); null for none. */
  customCover: string | null;
  /** Shown to every profile. */
  everyone: boolean;
  /** The profiles it's shown to (when not everyone). */
  userIds: number[];
  addedAt: string;
  refreshedAt: string;
}

/**
 * The place id in what an admin pastes: a game page address
 * (https://www.roblox.com/games/920587237/Adopt-Me), a share or start link with ?placeId=, a
 * roblox:// link, or the number alone. Null when there isn't one.
 */
export function parseRobloxPlace(input: string): string | null {
  const s = String(input ?? "").trim();
  if (/^\d{1,20}$/.test(s)) return s;
  const query = /[?&]placeId=(\d{1,20})\b/i.exec(s);
  if (query) return query[1]!;
  const page = /roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?games\/(\d{1,20})\b/i.exec(s);
  if (page) return page[1]!;
  const legacy = /^roblox:\/\/placeId=(\d{1,20})\b/i.exec(s);
  return legacy ? legacy[1]! : null;
}

/** The link that opens the Roblox app in a place (Roblox's documented deep link). */
export const robloxLaunchUrl = (placeId: string) => `roblox://experiences/start?placeId=${encodeURIComponent(placeId)}`;

/** The experience's page on roblox.com. */
export const robloxPageUrl = (placeId: string) => `https://www.roblox.com/games/${encodeURIComponent(placeId)}`;

/** The id play time is recorded under for a Roblox place, so it counts against today's allowance. */
export const robloxPlayId = (placeId: string) => `roblox:${placeId}`;

/** The place a Roblox launch link opens, or null for any other link. */
export function robloxPlaceOf(url: string): string | null {
  return /^roblox:/i.test(url) ? parseRobloxPlace(url) : null;
}
