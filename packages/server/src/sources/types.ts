import type { SourceClient } from "./client.js";

/** One downloadable file a source lists for a release: its links are mirrors of each other. */
export interface ReleaseDownload {
  title?: string | null;
  /** magnet: links, .torrent URLs or file-host / direct http(s) links. */
  uris: string[];
  /** As the source wrote it ("12.3 GB"). */
  size?: string | null;
}

/** One release as LootDen shows it, whatever source it came from. */
export interface ReleaseInfo {
  /** Stable within its source (an id, or the URL); used to alert only once. */
  id: string;
  title: string;
  /** ISO date (YYYY-MM-DD or a full timestamp) when known. */
  date: string | null;
  /** "pc", or another platform id from @lootden/shared, when the source says. */
  platform: string | null;
  url: string | null;
  image?: string | null;
  summary?: string | null;
  /** Small extra facts to show as "label: value" (store, price, version…). */
  details?: Record<string, string>;
  /** Links the source gives to fetch the release itself; Discover then offers Download. */
  downloads?: ReleaseDownload[];
}

/** What the admin set for a source in Settings, Sources. */
export interface SourceConfig {
  enabled: boolean;
  /** Where the source lives; adapters supply a default. */
  baseUrl: string;
  apiKey: string;
  /** Requests allowed in any 60-second window, and in any hour. */
  perMinute: number;
  perHour: number;
  /** Extra hosts this source may call besides the base URL's (e.g. an API on another domain). */
  extraHosts: string[];
  /** The source runs on your own network (a 192.168.x.x or .lan address); off for internet sources. */
  onMyNetwork: boolean;
  /** What to call the source instead of its adapter name; "" uses the adapter name. */
  displayName: string;
}

/** Handed to an adapter on every call. */
export interface SourceContext {
  config: SourceConfig;
  /** Rate-limited, host-checked fetch for this source. */
  client: SourceClient;
}

/**
 * A release source. To add your own, write one of these in src/sources/adapters/ and list it
 * in src/sources/adapters/index.ts; see adapters/json-feed.ts for a commented example.
 */
export interface ReleaseSource {
  id: string;
  name: string;
  /** One sentence for Settings. */
  description: string;
  /** Shown as the base URL until the admin changes it. Leave "" if the admin must enter one. */
  defaultBaseUrl: string;
  /** Whether Settings should show an API key field. */
  needsKey?: boolean;
  /** Whether Settings lets the admin name the source (for generic feeds pointed at any address). */
  nameable?: boolean;
  /** Defaults for the rate limits; keep them polite. */
  limits?: { perMinute: number; perHour: number };
  /** The newest releases, newest first. */
  latest(ctx: SourceContext): Promise<ReleaseInfo[]>;
  /** Optional: releases matching a title. */
  search?(ctx: SourceContext, query: string): Promise<ReleaseInfo[]>;
}
