/** Every metadata source an admin can turn on and put in order. */
export const METADATA_SOURCES = ["igdb", "screenscraper", "launchbox", "thegamesdb", "rawg", "steam"] as const;
export type MetadataSourceId = (typeof METADATA_SOURCES)[number];

/** One source in an admin's order: off keeps it configured but skips it when matching. */
export interface SourceEntry {
  id: string;
  on: boolean;
}

export interface SourceOrder {
  pc: SourceEntry[];
  emulated: SourceEntry[];
}

/**
 * Out of the box PC games keep the old order (IGDB, RAWG, Steam) and emulated games
 * try the retro databases first. ScreenScraper is off for PC so its daily quota goes to ROMs.
 */
export const DEFAULT_ORDER: { pc: string[]; emulated: string[] } = {
  pc: ["igdb", "rawg", "steam", "launchbox", "thegamesdb"],
  emulated: ["screenscraper", "igdb", "launchbox", "thegamesdb", "rawg"],
};

const DEFAULT_ENTRIES = (kind: "pc" | "emulated"): SourceEntry[] => [
  ...DEFAULT_ORDER[kind].map((id) => ({ id, on: true })),
  ...METADATA_SOURCES.filter((id) => !DEFAULT_ORDER[kind].includes(id)).map((id) => ({ id, on: false })),
];

/** Drops unknown and repeated sources and appends any the list is missing (sources added in later versions). */
export function normalizeEntries(list: unknown, kind: "pc" | "emulated"): SourceEntry[] {
  if (!Array.isArray(list)) return DEFAULT_ENTRIES(kind);
  const out: SourceEntry[] = [];
  for (const e of list as Array<Partial<SourceEntry>>) {
    if (!e || typeof e.id !== "string" || !(METADATA_SOURCES as readonly string[]).includes(e.id) || out.some((o) => o.id === e.id)) continue;
    out.push({ id: e.id, on: e.on !== false });
  }
  for (const d of DEFAULT_ENTRIES(kind)) if (!out.some((o) => o.id === d.id)) out.push(d);
  return out;
}

/** The ids to try, in order. */
export const enabledIds = (entries: SourceEntry[]): string[] => entries.filter((e) => e.on).map((e) => e.id);
