import {
  cleanModUrl,
  modFileKey,
  modKey,
  workshopIdFromUrl,
  workshopUrl,
  type ActiveTruckMod,
  type ModLinkCheck,
  type ModLinkStatus,
  type TrackedTruckMod,
  type TrackedTruckModInput,
  type TruckGame,
  type TruckLoadOrder,
  type WorkshopItem,
} from "@lootden/shared";
import { json, now, type Db } from "../db/database.js";

interface Row {
  id: number;
  game: TruckGame;
  name: string;
  source_url: string | null;
  workshop_id: string | null;
  category: string | null;
  game_version: string | null;
  mod_version: string | null;
  notes: string | null;
  files: string;
  extra: string;
  retired: number;
  link_check: string | null;
  updated_at: string;
}

const STATUSES: ModLinkStatus[] = ["unchecked", "live", "renamed", "moved", "login", "dead", "blocked"];

/** The key two names for one mod share ("Coast to Coast" and "Coast_to_Coast_v2.22.58.0.scs"). */
export function trackKey(name: string): string {
  return modKey(modFileKey(name));
}

const text = (v: unknown, max: number): string | null => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
const fileList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((f) => String(f ?? "").trim()).filter((f) => f && f.length <= 255 && !/[\\/]/.test(f)))].slice(0, 50) : [];
const extraList = (v: unknown): string[] => (Array.isArray(v) ? v.slice(0, 20).map((c) => String(c ?? "").slice(0, 200)) : []);
const workshop = (v: unknown): string | null => (/^\d{4,20}$/.test(String(v ?? "")) ? String(v) : null);

/** A check as sent by the desktop app, cut down to what's kept. */
export function cleanCheck(input: unknown): ModLinkCheck | null {
  if (!input || typeof input !== "object") return null;
  const c = input as Partial<ModLinkCheck>;
  const status = STATUSES.includes(c.status as ModLinkStatus) ? (c.status as ModLinkStatus) : null;
  if (!status) return null;
  const at = Date.parse(String(c.checkedAt ?? ""));
  return {
    status,
    checkedAt: Number.isFinite(at) ? new Date(at).toISOString() : now(),
    finalUrl: cleanModUrl(c.finalUrl),
    pageTitle: text(c.pageTitle, 200),
    latestVersion: text(c.latestVersion, 40),
    latestGameVersion: text(c.latestGameVersion, 20),
    lastUpdated: text(c.lastUpdated, 30),
    note: text(c.note, 300),
  };
}

/** A load order's mods as sent, cut down to what's kept. */
export function cleanLoadOrder(input: unknown): ActiveTruckMod[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 1000)
    .map((m) => ({ package: String((m as ActiveTruckMod)?.package ?? "").trim().slice(0, 255), name: String((m as ActiveTruckMod)?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 200) }))
    .filter((m) => m.package || m.name)
    .map((m) => ({ package: m.package, name: m.name || m.package }));
}

/**
 * The household's mod list for each truck game, and the load orders kept for every PC. Anyone
 * signed in (but kid profiles) can read and change both: it's one shared record of the mods.
 */
export class TruckModListStore {
  constructor(private readonly db: Db) {}

  private view(r: Row): TrackedTruckMod {
    return {
      id: r.id,
      game: r.game,
      name: r.name,
      sourceUrl: r.source_url,
      workshopId: r.workshop_id,
      category: r.category,
      gameVersion: r.game_version,
      modVersion: r.mod_version,
      notes: r.notes,
      files: json<string[]>(r.files, []),
      extra: json<string[]>(r.extra, []),
      retired: !!r.retired,
      check: r.link_check ? json<ModLinkCheck | null>(r.link_check, null) : null,
      updatedAt: r.updated_at,
    };
  }

  private rows(game: TruckGame): Row[] {
    return this.db.prepare("SELECT * FROM truck_mod_list WHERE game = ? ORDER BY retired, name COLLATE NOCASE, id").all(game) as unknown as Row[];
  }

  list(game: TruckGame): TrackedTruckMod[] {
    return this.rows(game).map((r) => this.view(r));
  }

  get(id: number): TrackedTruckMod | null {
    const r = this.db.prepare("SELECT * FROM truck_mod_list WHERE id = ?").get(id) as Row | undefined;
    return r ? this.view(r) : null;
  }

  /**
   * Adds mods to the list, merging each with the one already there that is the same mod: the same
   * Workshop item, one of the same files, or the same name once versions and noise are boiled off.
   * What the new one says wins; files are added up. A name taken from a file gives way to a
   * written one (from a sheet).
   */
  import(game: TruckGame, inputs: TrackedTruckModInput[]): { added: number; updated: number; mods: TrackedTruckMod[] } {
    let added = 0;
    let updated = 0;
    const existing = this.list(game);
    const at = now();
    this.db.exec("BEGIN");
    try {
      for (const raw of inputs.slice(0, 2000)) {
        const name = text(raw?.name, 200);
        if (!name) continue;
        const sourceUrl = cleanModUrl(raw.sourceUrl);
        const workshopId = workshop(raw.workshopId) ?? workshopIdFromUrl(sourceUrl);
        const files = fileList(raw.files);
        const key = trackKey(name);
        const lower = new Set(files.map((f) => f.toLowerCase()));
        const same =
          (workshopId && existing.find((m) => m.workshopId === workshopId)) ||
          (lower.size ? existing.find((m) => m.files.some((f) => lower.has(f.toLowerCase()))) : undefined) ||
          (key ? existing.find((m) => trackKey(m.name) === key || m.files.some((f) => trackKey(f) === key)) : undefined);
        const fields = {
          sourceUrl: sourceUrl ?? (workshopId ? workshopUrl(workshopId) : null),
          workshopId,
          category: text(raw.category, 60),
          gameVersion: text(raw.gameVersion, 20),
          modVersion: text(raw.modVersion, 40),
          notes: text(raw.notes, 1000),
        };
        if (same) {
          const autoNamed = !same.sourceUrl && !same.category && same.files.length > 0;
          const next: TrackedTruckMod = {
            ...same,
            name: autoNamed && !files.length ? name : same.name,
            sourceUrl: fields.sourceUrl ?? same.sourceUrl,
            workshopId: fields.workshopId ?? same.workshopId,
            category: fields.category ?? same.category,
            gameVersion: fields.gameVersion ?? same.gameVersion,
            modVersion: fields.modVersion ?? same.modVersion,
            notes: fields.notes ?? same.notes,
            files: [...new Set([...same.files, ...files])].slice(0, 50),
            extra: raw.extra?.length ? extraList(raw.extra) : same.extra,
            retired: raw.retired ?? same.retired,
          };
          const linkChanged = next.sourceUrl !== same.sourceUrl;
          this.db
            .prepare(
              "UPDATE truck_mod_list SET name = ?, source_url = ?, workshop_id = ?, category = ?, game_version = ?, mod_version = ?, notes = ?, files = ?, extra = ?, retired = ?, link_check = CASE WHEN ? THEN NULL ELSE link_check END, updated_at = ? WHERE id = ?",
            )
            .run(next.name, next.sourceUrl, next.workshopId, next.category, next.gameVersion, next.modVersion, next.notes, JSON.stringify(next.files), JSON.stringify(next.extra), next.retired ? 1 : 0, linkChanged ? 1 : 0, at, same.id);
          Object.assign(same, next, linkChanged ? { check: null } : {});
          updated++;
        } else {
          const r = this.db
            .prepare(
              "INSERT INTO truck_mod_list (game, name, source_url, workshop_id, category, game_version, mod_version, notes, files, extra, retired, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(game, name, fields.sourceUrl, fields.workshopId, fields.category, fields.gameVersion, fields.modVersion, fields.notes, JSON.stringify(files), JSON.stringify(extraList(raw.extra)), raw.retired ? 1 : 0, at);
          existing.push(this.get(Number(r.lastInsertRowid))!);
          added++;
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { added, updated, mods: this.list(game) };
  }

  /** Changes one mod; a new link clears the last check. A check may be set with it. */
  update(id: number, patch: Partial<TrackedTruckModInput> & { check?: unknown }): TrackedTruckMod | null {
    const cur = this.get(id);
    if (!cur) return null;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(patch, k);
    const name = has("name") ? text(patch.name, 200) : cur.name;
    if (!name) throw new Error("Give the mod a name");
    const sourceUrl = has("sourceUrl") ? cleanModUrl(patch.sourceUrl) : cur.sourceUrl;
    if (has("sourceUrl") && patch.sourceUrl && !sourceUrl) throw new Error("That isn't a web address");
    const workshopId = has("workshopId") ? workshop(patch.workshopId) : has("sourceUrl") ? workshopIdFromUrl(sourceUrl) ?? cur.workshopId : cur.workshopId;
    let check = cur.check;
    if (sourceUrl !== cur.sourceUrl) check = null;
    if (has("check")) check = patch.check === null ? null : cleanCheck(patch.check) ?? check;
    this.db
      .prepare(
        "UPDATE truck_mod_list SET name = ?, source_url = ?, workshop_id = ?, category = ?, game_version = ?, mod_version = ?, notes = ?, files = ?, retired = ?, link_check = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        name,
        sourceUrl,
        workshopId,
        has("category") ? text(patch.category, 60) : cur.category,
        has("gameVersion") ? text(patch.gameVersion, 20) : cur.gameVersion,
        has("modVersion") ? text(patch.modVersion, 40) : cur.modVersion,
        has("notes") ? text(patch.notes, 1000) : cur.notes,
        JSON.stringify(has("files") ? fileList(patch.files) : cur.files),
        (has("retired") ? !!patch.retired : cur.retired) ? 1 : 0,
        check ? JSON.stringify(check) : null,
        now(),
        id,
      );
    return this.get(id);
  }

  remove(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM truck_mod_list WHERE id = ?").run(id).changes) > 0;
  }

  /** Every Workshop mod on the list checked against Steam's answer (items: what Steam still has). */
  applyWorkshopDetails(game: TruckGame, asked: string[], items: WorkshopItem[]): TrackedTruckMod[] {
    const byId = new Map(items.map((i) => [i.id, i]));
    const at = now();
    for (const m of this.list(game)) {
      if (!m.workshopId || !asked.includes(m.workshopId)) continue;
      const item = byId.get(m.workshopId);
      const check: ModLinkCheck = item
        ? {
            status: "live",
            checkedAt: at,
            finalUrl: null,
            pageTitle: item.title.slice(0, 200),
            latestVersion: null,
            latestGameVersion: null,
            lastUpdated: item.updatedAt ? item.updatedAt.slice(0, 10) : null,
            note: item.appId && item.appId !== (game === "ats" ? "270880" : "227300") ? "This Workshop item is for another game" : null,
          }
        : { status: "dead", checkedAt: at, finalUrl: null, pageTitle: null, latestVersion: null, latestGameVersion: null, lastUpdated: null, note: "Steam no longer has this Workshop item (removed or hidden)" };
      this.db.prepare("UPDATE truck_mod_list SET link_check = ? WHERE id = ?").run(JSON.stringify(check), m.id);
    }
    return this.list(game);
  }

  // ---- Load orders ----

  loadOrders(game: TruckGame): TruckLoadOrder[] {
    const rows = this.db
      .prepare("SELECT o.*, u.display_name AS by_name FROM truck_load_orders o LEFT JOIN users u ON u.id = o.updated_by WHERE o.game = ? ORDER BY o.updated_at DESC")
      .all(game) as unknown as Array<{ id: number; game: TruckGame; name: string; mods: string; by_name: string | null; updated_at: string }>;
    return rows.map((r) => ({ id: r.id, game: r.game, name: r.name, mods: json<ActiveTruckMod[]>(r.mods, []), updatedBy: r.by_name, updatedAt: r.updated_at }));
  }

  /** Keeps a load order under a name (one with the same name is replaced). */
  saveLoadOrder(game: TruckGame, name: string, mods: unknown, userId: number | null): TruckLoadOrder {
    const clean = text(name, 80);
    if (!clean) throw new Error("Give the load order a name");
    const list = cleanLoadOrder(mods);
    if (!list.length) throw new Error("The load order has no mods in it");
    this.db
      .prepare("INSERT INTO truck_load_orders (game, name, mods, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (game, name) DO UPDATE SET name = excluded.name, mods = excluded.mods, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
      .run(game, clean, JSON.stringify(list), userId, now());
    return this.loadOrders(game).find((o) => o.name.toLowerCase() === clean.toLowerCase())!;
  }

  removeLoadOrder(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM truck_load_orders WHERE id = ?").run(id).changes) > 0;
  }
}
