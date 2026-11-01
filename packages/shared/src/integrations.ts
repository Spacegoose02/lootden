/** ProtonDB's rating of how a Windows game runs on Linux (Proton), best first. */
export const PROTON_TIERS = ["platinum", "gold", "silver", "bronze", "borked"] as const;
export type ProtonTier = (typeof PROTON_TIERS)[number] | "pending";

/** Valve's Steam Deck rating. */
export type DeckRating = "verified" | "playable" | "unsupported" | "unknown";

export interface GameCompat {
  steamAppId: string;
  protondb: { tier: ProtonTier; trending: ProtonTier | null; reports: number; confidence: string | null } | null;
  deck: DeckRating | null;
  fetchedAt: string;
}

export const PROTON_LABELS: Record<ProtonTier, string> = {
  platinum: "Platinum",
  gold: "Gold",
  silver: "Silver",
  bronze: "Bronze",
  borked: "Borked",
  pending: "Pending",
};

export const DECK_LABELS: Record<DeckRating, string> = {
  verified: "Deck Verified",
  playable: "Deck Playable",
  unsupported: "Deck Unsupported",
  unknown: "Deck: not rated",
};

/** Valve's numbers for Deck ratings (resolved_category). */
export function deckRating(category: unknown): DeckRating | null {
  switch (Number(category)) {
    case 3:
      return "verified";
    case 2:
      return "playable";
    case 1:
      return "unsupported";
    case 0:
      return "unknown";
    default:
      return null;
  }
}

export function protonTier(v: unknown): ProtonTier | null {
  const s = String(v ?? "").toLowerCase();
  return (PROTON_TIERS as readonly string[]).includes(s) || s === "pending" ? (s as ProtonTier) : null;
}

/** An IsThereAnyDeal price for a wishlist game. */
export interface WishPrice {
  wishId: number;
  /** The lowest current price and where. */
  price: number | null;
  regular: number | null;
  cut: number;
  shop: string | null;
  url: string | null;
  currency: string | null;
  /** The lowest price it has ever been. */
  low: number | null;
  /** Alert when it drops to this or less. */
  target: number | null;
  itadUrl: string | null;
  checkedAt: string | null;
  error: string | null;
}

export interface PriceSettings {
  apiKey: string;
  /** Two-letter country, for the shops and currency (US, GB, DE...). */
  country: string;
  /** Alert when a game is at least this much off (0 for off). */
  minCut: number;
  /** Alert when a game matches its lowest price ever. */
  atLow: boolean;
}
