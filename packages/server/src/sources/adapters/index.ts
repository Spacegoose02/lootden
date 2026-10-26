import type { ReleaseSource } from "../types.js";
import { gogNew, itchNew, rssFeed } from "./feeds.js";
import { jsonFeed } from "./json-feed.js";

/**
 * Every release source LootDen knows. Add yours to this list; it then shows up in
 * Settings, Sources, where it can be switched on and given an address, key and limits.
 */
export const ADAPTERS: ReleaseSource[] = [gogNew, itchNew, rssFeed, jsonFeed];
