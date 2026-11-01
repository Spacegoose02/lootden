import { randomBytes } from "node:crypto";
import { icsText, togetherLabel, zonedParts, type GameNight, type GameNightPick } from "@lootden/shared";
import type { Library } from "../catalog/library.js";
import { json, now, type Db } from "../db/database.js";
import type { DenDutyLink } from "./denduty.js";
import type { FamilyService } from "./family.js";
import type { UserRepo } from "./repo.js";

interface Row {
  id: number;
  title: string;
  day: string;
  time: string;
  players: string;
  game_id: string | null;
  game_title: string | null;
  note: string | null;
  goal_id: string | null;
  goal_title: string | null;
  goal_icon: string | null;
  created_by: number | null;
}

const FEED_KEY = "gamenight_feed";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Family game night: a picker that suggests games everyone chosen can play together (co-op and
 * party games, kid-safe when a kid plays, already installed for most of them), planned nights,
 * and a calendar feed Den Duty (or any calendar) can subscribe to.
 */
export class GameNights {
  constructor(
    private readonly db: Db,
    private readonly library: Library,
    private readonly users: UserRepo,
    private readonly family: FamilyService,
    private readonly denDuty: DenDutyLink,
  ) {}

  /** Games for these players, best first. */
  suggest(playerIds: number[], limit = 12): GameNightPick[] {
    const players = [...new Set(playerIds)].map((id) => this.users.byId(id)).filter((u) => !!u);
    if (!players.length) throw new Error("Pick who's playing first");
    const kids = players.some((p) => p.kidMode);
    const installed = new Map<string, Set<number>>();
    const rows = this.db
      .prepare(`SELECT game_id, user_id FROM user_games WHERE installed_at IS NOT NULL AND uninstalled_at IS NULL AND user_id IN (${players.map(() => "?").join(",")})`)
      .all(...players.map((p) => p.id)) as Array<{ game_id: string; user_id: number }>;
    for (const r of rows) {
      if (!installed.has(r.game_id)) installed.set(r.game_id, new Set());
      installed.get(r.game_id)!.add(r.user_id);
    }
    const n = players.length;
    const picks: GameNightPick[] = [];
    for (const g of this.library.list({ kind: "game", kidSafe: kids || undefined })) {
      const together = g.together ?? [];
      // One player: anything goes. More: it has to be a game to play together.
      if (n > 1 && !together.length) continue;
      const have = installed.get(g.id)?.size ?? 0;
      const reasons: string[] = [];
      let score = 0;
      if (together.includes("couch") || together.includes("split")) {
        score += 30;
        reasons.push("Everyone on one screen");
      } else if (together.length) score += 15;
      if (together.includes("party") && n >= 3) {
        score += 10;
        reasons.push(`Party game for ${n}`);
      }
      if (have) {
        score += Math.round((have / n) * 30);
        reasons.push(have === n ? "Installed for everyone" : `Installed for ${have} of ${n}`);
      }
      if (kids) reasons.push("Kid-safe");
      if (g.rating) score += Math.round(g.rating / 10);
      if (g.controllerSupport === "full") {
        score += 5;
        reasons.push("Plays with controllers");
      }
      picks.push({ id: g.id, title: g.title, coverUrl: g.coverUrl, together: together.map(togetherLabel), installedFor: have, players: n, reasons, score });
    }
    return picks.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
  }

  private view(r: Row): GameNight {
    const game = r.game_id ? this.library.get(r.game_id, false) : null;
    return {
      id: r.id,
      title: r.title,
      date: r.day,
      time: r.time,
      players: json<number[]>(r.players, []).flatMap((id) => {
        const u = this.users.byId(id);
        return u ? [{ id: u.id, name: u.displayName, avatar: u.avatar }] : [];
      }),
      game: r.game_id ? { id: r.game_id, title: game?.title ?? r.game_title ?? "A game", coverUrl: game?.coverUrl ?? null } : null,
      note: r.note,
      goal: r.goal_id ? { id: r.goal_id, title: r.goal_title ?? "", icon: r.goal_icon ?? "🏆" } : null,
      createdBy: r.created_by === null ? null : (this.users.byId(r.created_by)?.displayName ?? null),
    };
  }

  private today(): string {
    return zonedParts(new Date(), this.family.timeZone()).date;
  }

  /** Coming up, then the last two weeks' (newest first). */
  list(): { upcoming: GameNight[]; past: GameNight[] } {
    const today = this.today();
    const rows = this.db.prepare("SELECT * FROM game_nights WHERE day >= date(?, '-14 days') ORDER BY day, time").all(today) as unknown as Row[];
    return {
      upcoming: rows.filter((r) => r.day >= today).map((r) => this.view(r)),
      past: rows
        .filter((r) => r.day < today)
        .reverse()
        .map((r) => this.view(r)),
    };
  }

  /** The next one, for Home and the Den Duty wall. */
  next(): GameNight | null {
    return this.list().upcoming[0] ?? null;
  }

  create(by: number, input: { title?: unknown; date?: unknown; time?: unknown; players?: unknown; gameId?: unknown; note?: unknown; goalId?: unknown }): GameNight {
    const date = String(input.date ?? "");
    const time = String(input.time ?? "19:00");
    if (!DAY.test(date) || Number.isNaN(Date.parse(date))) throw new Error("Pick a day");
    if (date < this.today()) throw new Error("That day has been and gone");
    if (!TIME.test(time)) throw new Error("Pick a time, like 19:00");
    const players = Array.isArray(input.players) ? [...new Set(input.players.map(Number))].filter((id) => this.users.byId(id)) : [];
    if (!players.length) throw new Error("Pick who's playing");
    let gameId: string | null = null;
    let gameTitle: string | null = null;
    if (input.gameId) {
      const g = this.library.get(String(input.gameId), false);
      if (!g) throw new Error("No such game");
      [gameId, gameTitle] = [g.id, g.title];
    }
    let goal: { id: string; title: string; icon: string } | null = null;
    if (input.goalId) {
      const found = this.denDuty.goalsReached().find((x) => x.id === String(input.goalId));
      if (!found) throw new Error("That Den Duty goal isn't one reached lately");
      goal = { id: found.id, title: found.title, icon: found.icon };
    }
    const title = String(input.title ?? "").trim().slice(0, 80) || (goal ? `${goal.icon} Game night: ${goal.title}` : "🎮 Family game night");
    const note = String(input.note ?? "").trim().slice(0, 300) || null;
    const r = this.db
      .prepare(
        "INSERT INTO game_nights (title, day, time, players, game_id, game_title, note, goal_id, goal_title, goal_icon, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(title, date, time, JSON.stringify(players), gameId, gameTitle, note, goal?.id ?? null, goal?.title ?? null, goal?.icon ?? null, by, now()) as unknown as Row;
    return this.view(r);
  }

  remove(id: number): boolean {
    return this.db.prepare("DELETE FROM game_nights WHERE id = ?").run(id).changes > 0;
  }

  /** Den Duty family goals reached lately that no game night used yet. */
  goalsToCelebrate(): Array<{ id: string; title: string; icon: string; reward: string | null; reachedAt: string }> {
    const used = new Set((this.db.prepare("SELECT goal_id FROM game_nights WHERE goal_id IS NOT NULL").all() as Array<{ goal_id: string }>).map((r) => r.goal_id));
    return this.denDuty
      .goalsReached()
      .filter((g) => !used.has(g.id))
      .map(({ done: _d, ...g }) => g);
  }

  // ---- Calendar feed ---------------------------------------------------------------------

  /** The secret in the feed's address; made on first use. */
  feedKey(): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(FEED_KEY) as { value: string } | undefined;
    if (row) return row.value;
    const key = randomBytes(18).toString("base64url");
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(FEED_KEY, key);
    return key;
  }

  resetFeedKey(): string {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(FEED_KEY);
    return this.feedKey();
  }

  /** iCalendar for the next game nights (local times, two hours each). */
  ics(publicUrl: string): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//LootDen//Game nights//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:LootDen game nights", `X-WR-TIMEZONE:${this.family.timeZone()}`];
    for (const n of this.list().upcoming) {
      const start = `${n.date.replace(/-/g, "")}T${n.time.replace(":", "")}00`;
      const desc = [n.game && `Playing: ${n.game.title}`, `Players: ${n.players.map((p) => p.name).join(", ")}`, n.goal && `Earned in Den Duty: ${n.goal.icon} ${n.goal.title}`, n.note].filter(Boolean).join("\n");
      lines.push(
        "BEGIN:VEVENT",
        `UID:gamenight-${n.id}@lootden`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=${this.family.timeZone()}:${start}`,
        "DURATION:PT2H",
        `SUMMARY:${icsText(n.title)}`,
        `DESCRIPTION:${icsText(desc)}`,
        ...(publicUrl ? [`URL:${publicUrl.replace(/\/+$/, "")}/game-night`] : []),
        "END:VEVENT",
      );
    }
    lines.push("END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
  }
}
