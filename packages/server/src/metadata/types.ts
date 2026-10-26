import type { AgeRating, ControllerSupport, Platform } from "@lootden/shared";

export interface Candidate {
  provider: string;
  providerId: string;
  name: string;
  year: number | null;
  coverUrl: string | null;
  /** Found by the ROM's checksum rather than its name, so it is trusted whatever the title says. */
  exact?: boolean;
}

/** What is known about an emulated game's file, for sources that match ROMs by checksum. */
export interface RomHints {
  fileName: string;
  size: number;
  /** MD5 of the file, worked out only when a source asks for it; null for discs and archives. */
  md5: () => Promise<string | null>;
}

export interface ProviderResult {
  provider: string;
  providerId: string;
  name: string;
  summary: string | null;
  coverUrl: string | null;
  screenshots: string[];
  genres: string[];
  themes: string[];
  gameModes: string[];
  releaseDate: string | null;
  rating: number | null;
  ageRatings: AgeRating[];
  controllerSupport: ControllerSupport | null;
  steamAppId: string | null;
}

export interface MetadataProvider {
  readonly name: string;
  readonly enabled: boolean;
  /** platform narrows the search to one system (emulated games); unset means PC. */
  search(query: string, platform?: Platform, rom?: RomHints): Promise<Candidate[]>;
  fetch(id: string): Promise<ProviderResult | null>;
}
