import { epic } from "./epic.js";
import { gog } from "./gog.js";
import { jsonList } from "./json-list.js";
import { steam } from "./steam.js";
import { xbox } from "./xbox.js";
import type { LibraryAddon } from "./types.js";

/** Every library add-on, in the order the profile page lists them. */
export const ADDONS: LibraryAddon[] = [steam, gog, epic, xbox, jsonList];
