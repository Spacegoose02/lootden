import type { Notifier } from "../alerts/notifier.js";
import type { Library } from "../catalog/library.js";
import type { DownloadManager } from "../connectors/manager.js";
import { now, type Db } from "../db/database.js";
import { titleKey } from "../metadata/calendar.js";
import type { WantedService } from "./wanted.js";
import type { WishlistService } from "./wishlist.js";

/**
 * Where a request is: waiting for an admin, declined, or approved and then searching,
 * downloading, and ready once a game with its title is in the library.
 */
export type RequestStatus = "pending" | "declined" | "searching" | "downloading" | "ready";

export interface GameRequest {
  id: number;
  title: string;
  url: string | null;
  image: string | null;
  steamAppId: number | null;
  note: string | null;
  status: RequestStatus;
  requestedBy: { id: number; name: string };
  createdAt: string;
  decidedAt: string | null;
  /** Why it was declined, from the admin. */
  reason: string | null;
  /** The library game, once it's in. */
  libraryId: string | null;
}

export interface RequestInput {
  title: string;
  url?: string | null;
  image?: string | null;
  steamAppId?: number | null;
  note?: string | null;
}

interface Row {
  id: number;
  user_id: number;
  title: string;
  title_key: string;
  url: string | null;
  image: string | null;
  steam_app_id: number | null;
  note: string | null;
  state: "pending" | "approved" | "declined";
  reason: string | null;
  wish_id: number | null;
  created_at: string;
  decided_at: string | null;
  display_name: string | null;
}

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : "") || null;

/**
 * Game requests: anyone signed in (kid profiles too) asks for a game; an admin approves it,
 * which puts it on the wanted list and searches for it, or declines it with a reason.
 */
export class RequestService {
  constructor(
    private readonly db: Db,
    private readonly library: Library,
    private readonly wishlist: WishlistService,
    private readonly wanted: WantedService,
    private readonly downloads: DownloadManager,
    private readonly notifier: Notifier,
  ) {}

  /** Everyone's requests for an admin, else this person's own; open ones first, newest first. */
  list(userId: number | null): GameRequest[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, u.display_name FROM game_requests r LEFT JOIN users u ON u.id = r.user_id
         ${userId === null ? "" : "WHERE r.user_id = ?"} ORDER BY r.created_at DESC, r.id DESC`,
      )
      .all(...(userId === null ? [] : [userId])) as unknown as Row[];
    const inLibrary = new Map(this.library.list({}).map((g) => [titleKey(g.title), g.id]));
    const wishes = new Map(this.wishlist.list().map((w) => [w.id, w]));
    const out = rows.map((r): GameRequest => {
      const libraryId = inLibrary.get(r.title_key) ?? null;
      const wish = r.wish_id ? wishes.get(r.wish_id) : undefined;
      const download = wish?.downloadId ? this.downloads.get(wish.downloadId) : undefined;
      const status: RequestStatus =
        r.state === "declined" ? "declined" : libraryId ? "ready" : r.state === "pending" ? "pending" : download && download.status !== "failed" && download.status !== "removed" ? "downloading" : "searching";
      return {
        id: r.id,
        title: r.title,
        url: r.url,
        image: r.image,
        steamAppId: r.steam_app_id,
        note: r.note,
        status,
        requestedBy: { id: r.user_id, name: r.display_name ?? "Someone" },
        createdAt: r.created_at,
        decidedAt: r.decided_at,
        reason: r.reason,
        libraryId,
      };
    });
    const open = (s: RequestStatus) => (s === "pending" ? 0 : s === "searching" || s === "downloading" ? 1 : 2);
    return out.sort((a, b) => open(a.status) - open(b.status));
  }

  get(id: number): GameRequest | undefined {
    return this.list(null).find((r) => r.id === id);
  }

  /** A new request, or this person's open request for the same game. Admins get an alert. */
  async create(userId: number, name: string, input: RequestInput): Promise<GameRequest> {
    const title = clip(input.title, 200);
    if (!title) throw new Error("Which game?");
    const key = titleKey(title);
    const url = clip(input.url, 500);
    if (url && !/^https?:\/\//i.test(url)) throw new Error("Links need to start with http:// or https://");
    const image = clip(input.image, 500);
    const mine = this.db.prepare("SELECT id FROM game_requests WHERE user_id = ? AND title_key = ? AND state != 'declined'").get(userId, key) as { id: number } | undefined;
    if (mine) return this.get(mine.id)!;
    const steamAppId = Number.isInteger(input.steamAppId) && input.steamAppId! > 0 ? input.steamAppId! : null;
    const r = this.db
      .prepare("INSERT INTO game_requests (user_id, title, title_key, url, image, steam_app_id, note, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING id")
      .get(userId, title, key, url, image && /^(https?:\/\/|\/)/i.test(image) ? image : null, steamAppId, clip(input.note, 500), now()) as { id: number };
    const made = this.get(r.id)!;
    if (made.status !== "ready") await this.notifier.send("requests", `${name} asked for ${title}`, made.note, "/requests");
    return made;
  }

  /** Puts the game on the wanted list (searched until it's in the library) and searches now when Prowlarr is set up. */
  async approve(id: number): Promise<GameRequest> {
    const r = this.row(id);
    if (r.state === "approved") return this.get(id)!;
    this.wishlist.upsert({ title: r.title, url: r.url, image: r.image, steamAppId: r.steam_app_id }, { kind: "manual", name: `Requested by ${r.display_name ?? "someone"}` });
    const wish = this.wishlist.restore(r.title);
    if (wish) this.wanted.setMonitored(wish.id, true);
    this.db.prepare("UPDATE game_requests SET state = 'approved', reason = NULL, wish_id = ?, decided_at = ? WHERE id = ?").run(wish?.id ?? null, now(), id);
    if (wish && this.downloads.prowlarr().configured) void this.wanted.search(wish.id).catch(() => null);
    return this.get(id)!;
  }

  decline(id: number, reason: string | null): GameRequest {
    this.row(id);
    this.db.prepare("UPDATE game_requests SET state = 'declined', reason = ?, decided_at = ? WHERE id = ?").run(clip(reason, 300), now(), id);
    return this.get(id)!;
  }

  /** Withdraws a request: its own requester while nobody has decided, or an admin any time. Approved games stay on the wanted list. */
  remove(id: number, userId: number, admin: boolean): void {
    const r = this.row(id);
    if (!admin && (r.user_id !== userId || r.state !== "pending")) throw new Error("Only a request still waiting can be withdrawn");
    this.db.prepare("DELETE FROM game_requests WHERE id = ?").run(id);
  }

  private row(id: number): Row {
    const r = this.db.prepare("SELECT r.*, u.display_name FROM game_requests r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?").get(id) as Row | undefined;
    if (!r) throw new Error("No such request");
    return r;
  }
}
