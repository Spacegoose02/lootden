import { applyMarks, NO_MARKS, type GameMarks, type MarksPatch } from "@lootden/shared";
import { json, now, type Db } from "../db/database.js";

interface Row {
  game_key: string;
  favourite: number;
  hidden: number;
  tags: string;
  fields: string;
}

/** A game key: a library game's id, or another store's game as store:<addon>:<id>. */
export function cleanGameKey(key: unknown): string {
  const k = String(key ?? "");
  if (!/^(store:[a-z0-9-]{1,40}:[^/\0]{1,200}|[A-Za-z0-9_-]{1,200})$/.test(k)) throw new Error("Not a game");
  return k;
}

const view = (r: Row | undefined): GameMarks =>
  r ? { favourite: r.favourite === 1, hidden: r.hidden === 1, tags: json<string[]>(r.tags, []), fields: json<Record<string, string>>(r.fields, {}) } : { ...NO_MARKS, tags: [], fields: {} };

/** Each person's favourites, hidden games, tags and custom fields. */
export class MarkStore {
  constructor(private readonly db: Db) {}

  all(userId: number): Map<string, GameMarks> {
    const rows = this.db.prepare("SELECT * FROM game_marks WHERE user_id = ?").all(userId) as unknown as Row[];
    return new Map(rows.map((r) => [r.game_key, view(r)]));
  }

  get(userId: number, key: string): GameMarks {
    return view(this.db.prepare("SELECT * FROM game_marks WHERE user_id = ? AND game_key = ?").get(userId, key) as Row | undefined);
  }

  set(userId: number, key: string, patch: MarksPatch): GameMarks {
    const next = applyMarks(this.get(userId, key), patch);
    if (!next.favourite && !next.hidden && !next.tags.length && !Object.keys(next.fields).length) {
      this.db.prepare("DELETE FROM game_marks WHERE user_id = ? AND game_key = ?").run(userId, key);
      return next;
    }
    this.db
      .prepare(
        `INSERT INTO game_marks (user_id, game_key, favourite, hidden, tags, fields, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, game_key) DO UPDATE SET favourite = excluded.favourite, hidden = excluded.hidden, tags = excluded.tags, fields = excluded.fields, updated_at = excluded.updated_at`,
      )
      .run(userId, key, next.favourite ? 1 : 0, next.hidden ? 1 : 0, JSON.stringify(next.tags), JSON.stringify(next.fields), now());
    return next;
  }

  /** The same change to many games at once (bulk edit), all or nothing. */
  bulk(userId: number, keys: string[], patch: MarksPatch): number {
    this.db.exec("BEGIN");
    try {
      for (const k of keys) this.set(userId, k, patch);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return keys.length;
  }

  /** Every tag this person uses with how many games, and their custom field names. */
  vocabulary(userId: number): { tags: Array<{ name: string; count: number }>; fields: string[] } {
    const tags = new Map<string, number>();
    const fields = new Set<string>();
    for (const m of this.all(userId).values()) {
      for (const t of m.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
      for (const f of Object.keys(m.fields)) fields.add(f);
    }
    return { tags: [...tags.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), fields: [...fields].sort() };
  }
}
