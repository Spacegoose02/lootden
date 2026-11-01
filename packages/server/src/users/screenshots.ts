import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { imageKind, SCREENSHOT_REACTIONS, type Screenshot } from "@lootden/shared";
import type { Library } from "../catalog/library.js";
import { now, type Db } from "../db/database.js";
import type { UserRepo } from "./repo.js";

interface Row {
  id: number;
  user_id: number;
  game_id: string | null;
  game_title: string | null;
  caption: string | null;
  file: string;
  width: number | null;
  height: number | null;
  kid_safe: number;
  created_at: string;
}

export interface Viewer {
  id: number | null;
  admin: boolean;
  kid: boolean;
}

/** Biggest picture kept: a 4K PNG fits. */
export const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;

/**
 * The family screenshot wall: the desktop app's screenshot key (or an upload from a phone)
 * puts a picture here for everyone, with the game it came from. Kids only see pictures from
 * kid-safe games, or ones a kid took.
 */
export class ScreenshotWall {
  private readonly dir: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
    private readonly users: UserRepo,
    private readonly library: Library,
  ) {
    this.dir = path.join(dataDir, "screenshots");
  }

  async add(userId: number, image: Buffer, meta: { gameId?: string; title?: string; caption?: string; width?: number; height?: number }): Promise<Screenshot> {
    if (!Buffer.isBuffer(image) || !image.length) throw new Error("Send the picture as image/png, image/jpeg or image/webp");
    if (image.length > MAX_SCREENSHOT_BYTES) throw new Error("That picture is too big (15 MB at most)");
    const kind = imageKind(image);
    if (!kind) throw new Error("That isn't a PNG, JPEG or WebP picture");
    const user = this.users.byId(userId);
    if (!user) throw new Error("No such profile");
    const game = meta.gameId ? this.library.get(meta.gameId, false) : null;
    const title = (game?.title ?? String(meta.title ?? "").trim().slice(0, 200)) || null;
    // A kid profile only shares from games it can see.
    if (user.kidMode && game && game.kidSafe !== true) throw new Error("No such game");
    const kidSafe = user.kidMode || game?.kidSafe === true ? 1 : 0;
    const int = (n: unknown) => (Number.isInteger(Number(n)) && Number(n) > 0 && Number(n) < 20000 ? Number(n) : null);
    await mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `${stamp}-${userId}-${Math.random().toString(36).slice(2, 8)}.${kind}`;
    await writeFile(path.join(this.dir, file), image);
    const caption = String(meta.caption ?? "").trim().slice(0, 140) || null;
    const r = this.db
      .prepare("INSERT INTO screenshots (user_id, game_id, game_title, caption, file, width, height, kid_safe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
      .get(userId, game?.id ?? (meta.gameId ? String(meta.gameId).slice(0, 300) : null), title, caption, file, int(meta.width), int(meta.height), kidSafe, now()) as unknown as Row;
    return this.view(r, { id: userId, admin: false, kid: user.kidMode });
  }

  private visible(r: Row, v: Viewer): boolean {
    return !v.kid || r.kid_safe === 1 || r.user_id === v.id;
  }

  private view(r: Row, v: Viewer): Screenshot {
    const u = this.users.byId(r.user_id);
    const reactions = this.db.prepare("SELECT emoji, COUNT(*) AS n, SUM(user_id = ?) AS mine FROM screenshot_reactions WHERE screenshot_id = ? GROUP BY emoji").all(v.id ?? -1, r.id) as Array<{
      emoji: string;
      n: number;
      mine: number;
    }>;
    const order = (e: string) => SCREENSHOT_REACTIONS.indexOf(e as never);
    return {
      id: r.id,
      imageUrl: `/api/screenshots/${r.id}/image`,
      by: { id: r.user_id, name: u?.displayName ?? "Someone", avatar: u?.avatar ?? "" },
      game: r.game_title || r.game_id ? { id: r.game_id && this.library.get(r.game_id, false) ? r.game_id : null, title: r.game_title ?? "A game" } : null,
      caption: r.caption,
      width: r.width,
      height: r.height,
      createdAt: r.created_at,
      reactions: reactions.sort((a, b) => order(a.emoji) - order(b.emoji)).map((x) => ({ emoji: x.emoji, count: x.n, mine: x.mine > 0 })),
      canDelete: v.admin || v.id === r.user_id,
    };
  }

  /** Newest first; `before` pages back. */
  list(v: Viewer, opts: { before?: number; limit?: number; userId?: number; gameId?: string } = {}): Screenshot[] {
    const limit = Math.min(Math.max(Number(opts.limit) || 30, 1), 100);
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.before) (where.push("id < ?"), args.push(opts.before));
    if (opts.userId) (where.push("user_id = ?"), args.push(opts.userId));
    if (opts.gameId) (where.push("game_id = ?"), args.push(opts.gameId));
    if (v.kid) (where.push("(kid_safe = 1 OR user_id = ?)"), args.push(v.id ?? -1));
    const rows = this.db.prepare(`SELECT * FROM screenshots ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit) as unknown as Row[];
    return rows.map((r) => this.view(r, v));
  }

  private row(id: number): Row | undefined {
    return this.db.prepare("SELECT * FROM screenshots WHERE id = ?").get(id) as unknown as Row | undefined;
  }

  /** The picture's file, when this viewer may see it. */
  file(id: number, v: Viewer): string | null {
    const r = this.row(id);
    return r && this.visible(r, v) ? path.join(this.dir, path.basename(r.file)) : null;
  }

  react(id: number, v: Viewer, emoji: string): Screenshot {
    const r = this.row(id);
    if (!r || !this.visible(r, v) || v.id === null) throw new Error("No such screenshot");
    if (!SCREENSHOT_REACTIONS.includes(emoji as never)) throw new Error(`React with ${SCREENSHOT_REACTIONS.join(" ")}`);
    const had = this.db.prepare("DELETE FROM screenshot_reactions WHERE screenshot_id = ? AND user_id = ? AND emoji = ?").run(id, v.id, emoji).changes;
    if (!had) this.db.prepare("INSERT INTO screenshot_reactions (screenshot_id, user_id, emoji) VALUES (?, ?, ?)").run(id, v.id, emoji);
    return this.view(r, v);
  }

  async remove(id: number, v: Viewer): Promise<boolean> {
    const r = this.row(id);
    if (!r || !(v.admin || v.id === r.user_id)) return false;
    this.db.prepare("DELETE FROM screenshots WHERE id = ?").run(id);
    await rm(path.join(this.dir, path.basename(r.file)), { force: true });
    return true;
  }
}
