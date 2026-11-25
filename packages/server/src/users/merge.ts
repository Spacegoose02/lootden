import type { Db } from "../db/database.js";

/**
 * Merging two profiles of the same person, for example a local account and the duplicate a
 * TinyAuth sign-in created before it was linked. Everything the duplicate owns (play time,
 * installs, saves, achievements, shelves, requests, devices and sign-ins ...) moves to the
 * profile that is kept; where both have the same thing (one game's install on one PC, a
 * setting row), the kept profile's copy wins. Then the duplicate is deleted.
 */

/** Columns that hold a user id but were added without a foreign key. */
const LOOSE_USER_COLUMNS: Array<[table: string, column: string]> = [
  ["calendar_entries", "created_by"],
  ["direct_packages", "added_by"],
];

/** The kept profile's two-step sign-in stays as it is; the duplicate's authenticator and passkeys are dropped. */
const NOT_MOVED = new Set(["user_mfa", "passkeys"]);

export interface MergeCounts {
  /** Rows per table that move to the kept profile. */
  moved: Record<string, number>;
  /** Rows per table the kept profile already has its own copy of; they go with the duplicate. */
  dropped: Record<string, number>;
}

function userColumns(db: Db): Array<[string, string]> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name);
  const cols: Array<[string, string]> = [];
  for (const t of tables) {
    if (t === "users") continue;
    const fks = db.prepare(`PRAGMA foreign_key_list("${t.replace(/"/g, '""')}")`).all() as Array<{ table: string; from: string; to: string | null }>;
    for (const fk of fks) if (fk.table === "users" && (fk.to === "id" || fk.to == null)) cols.push([t, fk.from]);
  }
  for (const [t, c] of LOOSE_USER_COLUMNS) {
    if (!tables.includes(t) || cols.some(([a, b]) => a === t && b === c)) continue;
    const info = db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>;
    if (info.some((i) => i.name === c)) cols.push([t, c]);
  }
  return cols;
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** What merging would do, without changing anything. */
export function previewMerge(db: Db, keepId: number, dropId: number): MergeCounts {
  return run(db, keepId, dropId, false);
}

interface LinkRow {
  email: string | null;
  role: string;
  oidc_subject: string | null;
  sso_username: string | null;
}

/**
 * Merges the duplicate into the kept profile in one transaction: moves its data, gives the
 * kept profile its TinyAuth link (the one that actually signs in), and deletes it.
 */
export function mergeUsers(db: Db, keepId: number, dropId: number): MergeCounts {
  if (keepId === dropId) throw new Error("Pick two different profiles");
  const row = (id: number) => db.prepare("SELECT email, role, oidc_subject, sso_username FROM users WHERE id = ?").get(id) as LinkRow | undefined;
  const keep = row(keepId);
  const drop = row(dropId);
  if (!keep || !drop) throw new Error("No such user");
  db.exec("BEGIN IMMEDIATE");
  try {
    const counts = run(db, keepId, dropId, true);
    // The duplicate's link is the one TinyAuth signs in with, so it wins; the kept profile's
    // own link stays when the duplicate has none. Clear it first: links are unique.
    db.prepare("UPDATE users SET sso_username = NULL, oidc_subject = NULL WHERE id = ?").run(dropId);
    db.prepare("UPDATE users SET sso_username = ?, oidc_subject = ?, email = ?, role = ? WHERE id = ?").run(
      drop.sso_username ?? keep.sso_username,
      drop.oidc_subject ?? keep.oidc_subject,
      keep.email ?? drop.email,
      keep.role === "admin" || drop.role === "admin" ? "admin" : keep.role,
      keepId,
    );
    db.prepare("DELETE FROM users WHERE id = ?").run(dropId);
    db.exec("COMMIT");
    return counts;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function run(db: Db, keepId: number, dropId: number, apply: boolean): MergeCounts {
  const counts: MergeCounts = { moved: {}, dropped: {} };
  const add = (bucket: Record<string, number>, t: string, n: number) => {
    if (n > 0) bucket[t] = (bucket[t] ?? 0) + n;
  };
  // A savepoint so a preview can try the moves and roll them back, and a failed merge changes nothing.
  db.exec("SAVEPOINT merge_users");
  try {
    for (const [t, c] of userColumns(db)) {
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${q(c)} = ?`).get(dropId) as { n: number }).n;
      if (!total) continue;
      if (NOT_MOVED.has(t)) {
        add(counts.dropped, t, total);
        continue;
      }
      // OR IGNORE leaves rows whose key the kept profile already has (its copy wins).
      const moved = Number(db.prepare(`UPDATE OR IGNORE ${q(t)} SET ${q(c)} = ? WHERE ${q(c)} = ?`).run(keepId, dropId).changes);
      add(counts.moved, t, moved);
      add(counts.dropped, t, total - moved);
    }
    db.exec(apply ? "RELEASE merge_users" : "ROLLBACK TO merge_users; RELEASE merge_users");
  } catch (e) {
    db.exec("ROLLBACK TO merge_users; RELEASE merge_users");
    throw e;
  }
  return counts;
}
