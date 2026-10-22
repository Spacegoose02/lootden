import type { AddonField } from "@lootden/shared";
import type { FetchLike } from "../metadata/http.js";

/** A game as an add-on lists it; the registry fills in the rest. */
export interface OwnedGame {
  /** The store's own id: stable, used to keep play time and links when the list is synced again. */
  externalId: string;
  title: string;
  coverUrl?: string | null;
  storeUrl?: string | null;
  launchUrl?: string | null;
  playtimeSeconds?: number | null;
  /** ISO date. */
  lastPlayedAt?: string | null;
}

/** Handed to an add-on on every call. */
export interface AddonContext {
  /** What the person entered when connecting, by field key. */
  config: Record<string, string>;
  /** fetch with a 30 second timeout. */
  fetch: FetchLike;
}

/**
 * A library add-on. To add one, write it in src/addons/ and list it in src/addons/index.ts;
 * see json-list.ts for a commented example and README.md for the steps.
 */
export interface LibraryAddon {
  id: string;
  /** The store's name, shown on badges and filters. */
  name: string;
  /** One sentence for the profile page. */
  description: string;
  homepage?: string;
  /** What someone enters to connect their account. */
  fields: AddonField[];
  /** Every game the account owns. Thrown errors are shown to the person as they are. */
  games(ctx: AddonContext): Promise<OwnedGame[]>;
  /** Optional: a link to start a game, for add-ons whose list doesn't carry one. */
  launchUrl?(externalId: string): string | null;
}
