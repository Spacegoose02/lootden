import { cleanCustomRecomp, PLATFORMS, type RecompInfo } from "@lootden/shared";
import { json, type Db } from "../db/database.js";

const KEY = "recomps.custom";
/** Enough for any library; each one is a GitHub repo the desktop apps check. */
const MAX_CUSTOM = 50;

/** Recomps an admin added from a GitHub link, on top of the ones LootDen knows. */
export function customRecomps(db: Db): RecompInfo[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  return json<RecompInfo[]>(row?.value, []).map((r) => ({ ...r, custom: true }));
}

function save(db: Db, list: RecompInfo[]): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(list));
}

/** Adds (or replaces, by repo) a recomp. Throws with a message for the admin. */
export function addCustomRecomp(db: Db, input: unknown): RecompInfo {
  const r = cleanCustomRecomp(input, PLATFORMS.map((p) => p.id));
  const list = customRecomps(db).filter((x) => x.id !== r.id);
  if (list.length >= MAX_CUSTOM) throw new Error(`Up to ${MAX_CUSTOM} recomps can be added`);
  save(db, [...list, r]);
  return r;
}

export function removeCustomRecomp(db: Db, id: string): boolean {
  const list = customRecomps(db);
  const next = list.filter((x) => x.id !== id);
  save(db, next);
  return next.length !== list.length;
}
