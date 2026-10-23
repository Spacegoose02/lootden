// Library add-ons: games people own on other stores (Steam, GOG, Epic, Xbox...), shown next to
// the LootDen library. The server syncs each person's accounts; the desktop app finds which of
// those games are installed on the PC and starts them through the store's own launcher.

import type { GameInfo } from "./index.js";

/** One setting an add-on asks for when someone connects their account. */
export interface AddonField {
  key: string;
  label: string;
  /** One line under the field: where to find the value. */
  help?: string;
  placeholder?: string;
  /** Never sent back to the browser once saved (API keys, tokens). */
  secret?: boolean;
  required?: boolean;
  /** A page to open for the value, such as a store's sign-in page that shows a code. */
  link?: { url: string; label: string };
  /** Saved once used (a sign-in code): the field stays empty afterwards. */
  oneTime?: boolean;
  /** An admin can fill it in once for everyone (a Steam Web API key); a person's own value wins. */
  shared?: boolean;
}

/** An add-on as a person sees it on their profile. */
export interface AddonView {
  id: string;
  name: string;
  description: string;
  /** Where to read more or create the key the add-on needs. */
  homepage: string | null;
  fields: AddonField[];
  /** An admin switched it off for this server. */
  enabled: boolean;
  /** Fields an admin filled in for everyone, so people can leave them empty. */
  sharedSet: string[];
  /** Connect by signing in on the store's site ("Sign in with Steam"): POST here for the address to open. */
  signIn: { label: string; start: string } | null;
  /** This person's account, once connected. Secret values come back masked. */
  account: {
    config: Record<string, string>;
    connectedAt: string;
    lastSyncAt: string | null;
    error: string | null;
    games: number;
  } | null;
}

/** A game someone owns on another store. */
export interface StoreGame {
  addon: string;
  /** The add-on's name, for badges ("Steam"). */
  store: string;
  /** The store's own id (a Steam app id, a GOG product id...). */
  externalId: string;
  title: string;
  coverUrl: string | null;
  /** The game's page on the store's website. */
  storeUrl: string | null;
  /** Starts the game through the store's launcher, installing it first if needed (steam://rungameid/...). */
  launchUrl: string | null;
  playtimeSeconds: number | null;
  lastPlayedAt: string | null;
  /** The same game is in the LootDen library too. */
  libraryGameId: string | null;
  /**
   * The server's own cover for it (a person's custom art, else one found by title in the
   * metadata services): the card falls back to it when coverUrl is missing or broken.
   */
  artUrl?: string | null;
}

/** What a person changed on one of their store games. Null keeps what the store and metadata say. */
export interface StoreGameCustom {
  title: string | null;
  /** An image URL, or "upload:<time>" for an uploaded image. */
  cover: string | null;
  background: string | null;
  /** A different metadata entry than the one picked by title. */
  match: { provider: string; providerId: string } | null;
}

/** A store game's page: the game, and its details from IGDB, RAWG or the Steam store. */
export interface StoreGameDetail {
  /** Null for a game only found on this PC (no account connected, or a store like Ubisoft Connect). */
  game: StoreGame | null;
  /** Null when nothing matched the title; the person can pick a match by hand. */
  info: GameInfo | null;
  coverUrl: string | null;
  backgroundUrl: string | null;
  custom: StoreGameCustom;
}

/** A store game installed on this PC, as the desktop app finds it. */
export interface LocalStoreGame {
  addon: string;
  externalId: string;
  title: string;
  installDir: string;
  /** How to start it on this PC when it differs from the store's usual link (Heroic on Linux). */
  launchUrl?: string;
  /** The store's name, for stores found only on the PC (no server add-on to name them). */
  store?: string;
}

/**
 * Link schemes store launchers register. Only these open from a store game's Play button, so
 * an add-on can't hand the app an arbitrary program to run.
 */
export const STORE_LAUNCH_SCHEMES = ["steam:", "com.epicgames.launcher:", "goggalaxy:", "heroic:", "itch:", "uplay:", "origin2:", "battlenet:", "xbox:", "msxbox:"];

export const isStoreLaunchUrl = (url: string) => STORE_LAUNCH_SCHEMES.some((s) => url.toLowerCase().startsWith(s));
