import { now, type Db } from "../db/database.js";

export const BACKLOG_STATUSES = ["backlog", "playing", "done", "completed", "shelved", "dropped", "wishlist"] as const;
export type BacklogStatus = (typeof BACKLOG_STATUSES)[number];

export interface JournalEntry {
  id: number;
  text: string;
  createdAt: string;
}

export interface Journal {
  gameId: string;
  status: BacklogStatus | null;
  /** 1 to 5 stars. */
  rating: number | null;
  notes: string;
  entries: JournalEntry[];
  updatedAt: string | null;
}

/** Each profile's own backlog: a status per game, a rating, notes and a dated play journal. */
export class JournalStore {
  constructor(private readonly db: Db) {}

  get(userId: number, gameId: string): Journal {
    const r = this.db.prepare("SELECT * FROM journal WHERE user_id = ? AND game_id = ?").get(userId, gameId) as
      | { status: string | null; rating: number | null; notes: string | null; updated_at: string }
      | undefined;
    const entries = (this.db.prepare("SELECT id, text, created_at FROM journal_entries WHERE user_id = ? AND game_id = ? ORDER BY id DESC").all(userId, gameId) as Array<{ id: number; text: string; created_at: string }>).map((e) => ({
      id: e.id,
      text: e.text,
      createdAt: e.created_at,
    }));
    return { gameId, status: (r?.status as BacklogStatus | null) ?? null, rating: r?.rating ?? null, notes: r?.notes ?? "", entries, updatedAt: r?.updated_at ?? null };
  }

  set(userId: number, gameId: string, patch: { status?: string | null; rating?: number | null; notes?: string }): Journal {
    const cur = this.get(userId, gameId);
    const status = patch.status === undefined ? cur.status : patch.status;
    if (status !== null && !BACKLOG_STATUSES.includes(status as BacklogStatus)) throw new Error(`Status is one of ${BACKLOG_STATUSES.join(", ")}`);
    const rating = patch.rating === undefined ? cur.rating : patch.rating === null ? null : Math.min(5, Math.max(1, Math.round(Number(patch.rating))));
    const notes = patch.notes === undefined ? cur.notes : String(patch.notes).slice(0, 20_000);
    this.db
      .prepare(
        "INSERT INTO journal (user_id, game_id, status, rating, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, game_id) DO UPDATE SET status = excluded.status, rating = excluded.rating, notes = excluded.notes, updated_at = excluded.updated_at",
      )
      .run(userId, gameId, status, rating, notes, now());
    return this.get(userId, gameId);
  }

  addEntry(userId: number, gameId: string, text: string): Journal {
    const t = text.trim();
    if (!t) throw new Error("Write something first");
    this.db.prepare("INSERT INTO journal_entries (user_id, game_id, text, created_at) VALUES (?, ?, ?, ?)").run(userId, gameId, t.slice(0, 5000), now());
    // Writing about a game you haven't sorted yet means you're playing it.
    if (!this.get(userId, gameId).status) this.set(userId, gameId, { status: "playing" });
    return this.get(userId, gameId);
  }

  deleteEntry(userId: number, id: number): void {
    this.db.prepare("DELETE FROM journal_entries WHERE id = ? AND user_id = ?").run(id, userId);
  }

  /** Every game this profile has given a status, newest change first. */
  statuses(userId: number): Array<{ gameId: string; status: BacklogStatus; rating: number | null; updatedAt: string }> {
    return (this.db.prepare("SELECT game_id, status, rating, updated_at FROM journal WHERE user_id = ? AND status IS NOT NULL ORDER BY updated_at DESC").all(userId) as Array<{
      game_id: string;
      status: BacklogStatus;
      rating: number | null;
      updated_at: string;
    }>).map((r) => ({ gameId: r.game_id, status: r.status, rating: r.rating, updatedAt: r.updated_at }));
  }
}
