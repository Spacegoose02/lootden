import {
  ACHIEVEMENTS,
  cleanLimits,
  computeAllowance,
  EMPTY_STATS,
  hasLimits,
  levelFor,
  NO_LIMITS,
  PC_PLATFORM,
  validTimeZone,
  xpFor,
  zonedParts,
  type AchievementView,
  type Allowance,
  type Level,
  type PlayerStats,
  type PlayLimits,
  type RecapPlayer,
  type TimeRequest,
  type WeeklyRecap,
} from "@lootden/shared";
import type { Notifier } from "../alerts/notifier.js";
import type { Library } from "../catalog/library.js";
import { json, now, type Db } from "../db/database.js";
import type { GameRequest, RequestService } from "../news/requests.js";
import type { UserRepo } from "./repo.js";

/** Household settings for the family features (Settings, Library, Family). */
export interface FamilySettings {
  /** The household's time zone, for days, weeks and bedtimes. Blank: the server's. */
  timeZone: string;
  /** The desktop app keeps each profile's saves apart on shared PCs. */
  separateSaves: boolean;
}

const SETTINGS_KEY = "family";
const DEFAULTS: FamilySettings = { timeZone: "", separateSaves: true };

interface SessionRow {
  game_id: string;
  seconds: number;
  started_at: string;
  ended_at: string;
}

/** Celebrations waiting for a person: badges, requested games that arrived, bonus time granted. */
export interface Celebrations {
  achievements: AchievementView[];
  wishes: Array<{ id: number; title: string; image: string | null; gameId: string }>;
  bonus: Array<{ id: number; minutes: number }>;
}

/** YYYY-MM-DD plus some days, by the calendar (no time zones involved). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Play time, limits and bonus time, achievements and levels, the weekly recap, celebrations
 * and shelves. Days and weeks follow the household's time zone.
 */
export class FamilyService {
  constructor(
    private readonly db: Db,
    private readonly library: Library,
    private readonly users: UserRepo,
    private readonly requests: () => RequestService,
    private readonly notifier: Notifier,
  ) {}

  // ---- Settings ------------------------------------------------------------------

  settings(): FamilySettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
    return { ...DEFAULTS, ...json<Partial<FamilySettings>>(row?.value, {}) };
  }

  saveSettings(patch: Partial<FamilySettings>): FamilySettings {
    const cur = this.settings();
    const tz = patch.timeZone === undefined ? cur.timeZone : String(patch.timeZone).trim();
    if (tz && validTimeZone(tz) !== tz) throw new Error(`${tz} isn't a time zone, like Europe/London or America/New_York`);
    const next: FamilySettings = { timeZone: tz, separateSaves: patch.separateSaves === undefined ? cur.separateSaves : patch.separateSaves === true };
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  /** The household's time zone, else the server's (TZ in the container), else UTC. */
  timeZone(): string {
    return validTimeZone(this.settings().timeZone || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  private localDate(iso: string, tz = this.timeZone()): string {
    return zonedParts(new Date(iso), tz).date;
  }

  // ---- Play sessions ---------------------------------------------------------------

  /** One finished session; `endedAt` lets a PC that was offline report when it really happened. */
  recordSession(userId: number, gameId: string, device: string, seconds: number, endedAt?: string): void {
    const secs = Math.max(0, Math.min(Math.round(seconds), 24 * 3600));
    if (secs < 1) return;
    const reported = endedAt ? Date.parse(endedAt) : NaN;
    // Only believe a time from the last month, and never one in the future.
    const end = Number.isFinite(reported) && reported <= Date.now() && reported > Date.now() - 31 * 86400_000 ? new Date(reported) : new Date();
    const start = new Date(end.getTime() - secs * 1000);
    this.db
      .prepare("INSERT INTO play_sessions (user_id, game_id, device, seconds, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(userId, gameId, device.slice(0, 100), secs, start.toISOString(), end.toISOString());
  }

  /** Sessions that ended in the last `days` days (a little extra either side for time zones). */
  private sessions(userId: number | null, sinceDays: number): Array<SessionRow & { user_id: number }> {
    const since = new Date(Date.now() - (sinceDays + 1) * 86400_000).toISOString();
    return this.db
      .prepare(`SELECT user_id, game_id, seconds, started_at, ended_at FROM play_sessions WHERE ended_at >= ? ${userId === null ? "" : "AND user_id = ?"} ORDER BY ended_at`)
      .all(...(userId === null ? [since] : [since, userId])) as unknown as Array<SessionRow & { user_id: number }>;
  }

  // ---- Limits and bonus time ----------------------------------------------------------

  limits(userId: number): PlayLimits {
    const row = this.db.prepare("SELECT limits FROM play_limits WHERE user_id = ?").get(userId) as { limits: string } | undefined;
    return row ? cleanLimits(json(row.limits, {})) : NO_LIMITS;
  }

  setLimits(userId: number, input: unknown): PlayLimits {
    const limits = cleanLimits(input);
    if (!hasLimits(limits)) this.db.prepare("DELETE FROM play_limits WHERE user_id = ?").run(userId);
    else this.db.prepare("INSERT INTO play_limits (user_id, limits) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET limits = excluded.limits").run(userId, JSON.stringify(limits));
    return limits;
  }

  allowance(userId: number, at = new Date()): Allowance {
    const tz = this.timeZone();
    const today = zonedParts(at, tz).date;
    const used = this.sessions(userId, 2)
      .filter((s) => this.localDate(s.ended_at, tz) === today)
      .reduce((n, s) => n + s.seconds, 0);
    const bonus = (this.db.prepare("SELECT COALESCE(SUM(minutes), 0) AS m FROM time_requests WHERE user_id = ? AND day = ? AND state = 'approved'").get(userId, today) as { m: number }).m;
    const a = computeAllowance(this.limits(userId), used, bonus * 60, at, tz);
    // Den Duty: a time-out that locks games, or chores still to do.
    const lock = this.externalLock?.(userId);
    if (lock?.all) return { ...a, canPlay: false, reason: lock.all, robloxLock: null };
    return lock?.roblox ? { ...a, robloxLock: lock.roblox } : a;
  }

  /** Locks from outside LootDen (the Den Duty link), in words. */
  externalLock?: (userId: number) => { all: string | null; roblox: string | null };

  private timeRow(r: { id: number; user_id: number; display_name: string | null; minutes: number; note: string | null; state: TimeRequest["state"]; day: string; created_at: string; decided_at: string | null }): TimeRequest {
    return { id: r.id, userId: r.user_id, name: r.display_name ?? "Someone", minutes: r.minutes, note: r.note, state: r.state, date: r.day, createdAt: r.created_at, decidedAt: r.decided_at };
  }

  /** Everyone's bonus time requests from the last week (admins), or one person's. */
  timeRequests(userId: number | null): TimeRequest[] {
    const since = addDays(zonedParts(new Date(), this.timeZone()).date, -7);
    return (
      this.db
        .prepare(
          `SELECT t.*, u.display_name FROM time_requests t LEFT JOIN users u ON u.id = t.user_id WHERE t.day >= ? ${userId === null ? "" : "AND t.user_id = ?"}
           ORDER BY t.state = 'pending' DESC, t.id DESC`,
        )
        .all(...(userId === null ? [since] : [since, userId])) as unknown as Parameters<FamilyService["timeRow"]>[0][]
    ).map((r) => this.timeRow(r));
  }

  /** A kid asks for more time today. One open ask at a time; admins get an alert. */
  async askForTime(userId: number, name: string, minutes: number, note: string | null): Promise<TimeRequest> {
    const m = Math.round(Number(minutes));
    if (!Number.isFinite(m) || m < 5 || m > 240) throw new Error("Ask for 5 minutes to 4 hours");
    const today = zonedParts(new Date(), this.timeZone()).date;
    const open = this.db.prepare("SELECT id FROM time_requests WHERE user_id = ? AND day = ? AND state = 'pending'").get(userId, today) as { id: number } | undefined;
    if (open) throw new Error("You already asked; wait for an answer first");
    const clean = typeof note === "string" ? note.trim().slice(0, 200) || null : null;
    const r = this.db
      .prepare("INSERT INTO time_requests (user_id, minutes, note, day, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?) RETURNING id")
      .get(userId, m, clean, today, now()) as { id: number };
    await this.notifier.send("requests", `${name} asked for ${m} more minutes`, clean, "/requests");
    return this.timeRequests(userId).find((t) => t.id === r.id)!;
  }

  /** Admin: yes (optionally with different minutes) or no. */
  decideTime(id: number, approve: boolean, minutes?: number): TimeRequest {
    const row = this.db.prepare("SELECT * FROM time_requests WHERE id = ?").get(id) as { user_id: number; state: string } | undefined;
    if (!row) throw new Error("No such request");
    if (row.state !== "pending") throw new Error("Already answered");
    const m = minutes === undefined ? null : Math.round(Number(minutes));
    if (m !== null && (!Number.isFinite(m) || m < 1 || m > 600)) throw new Error("Grant 1 to 600 minutes");
    this.db
      .prepare(`UPDATE time_requests SET state = ?, decided_at = ?${m !== null && approve ? ", minutes = ?" : ""} WHERE id = ?`)
      .run(...([approve ? "approved" : "declined", now(), ...(m !== null && approve ? [m] : []), id] as Array<string | number>));
    return this.timeRequests(null).find((t) => t.id === id) ?? this.timeRequests(row.user_id).find((t) => t.id === id)!;
  }

  /** Admin: bonus time for today without being asked. */
  giveTime(userId: number, minutes: number): TimeRequest {
    const m = Math.round(Number(minutes));
    if (!Number.isFinite(m) || m < 1 || m > 600) throw new Error("Give 1 to 600 minutes");
    const today = zonedParts(new Date(), this.timeZone()).date;
    const r = this.db
      .prepare("INSERT INTO time_requests (user_id, minutes, note, day, state, created_at, decided_at) VALUES (?, ?, NULL, ?, 'approved', ?, ?) RETURNING id")
      .get(userId, m, today, now(), now()) as { id: number };
    return this.timeRequests(userId).find((t) => t.id === r.id)!;
  }

  // ---- Achievements and levels ---------------------------------------------------------

  bump(userId: number, counter: string, by = 1): number {
    const r = this.db
      .prepare("INSERT INTO user_counters (user_id, counter, value) VALUES (?, ?, ?) ON CONFLICT(user_id, counter) DO UPDATE SET value = value + excluded.value RETURNING value")
      .get(userId, counter, by) as { value: number };
    return r.value;
  }

  private counter(userId: number, counter: string): number {
    return (this.db.prepare("SELECT value FROM user_counters WHERE user_id = ? AND counter = ?").get(userId, counter) as { value: number } | undefined)?.value ?? 0;
  }

  stats(userId: number, granted?: GameRequest[]): PlayerStats {
    const s: PlayerStats = { ...EMPTY_STATS };
    const tz = this.timeZone();
    const perGame = new Map<string, number>();
    for (const g of this.users.gameStates(userId)) {
      if (g.installedAt) s.installs++;
      perGame.set(g.gameId, (perGame.get(g.gameId) ?? 0) + g.playtimeSeconds);
    }
    // Sessions only exist from this version on; older play time still counts toward totals.
    const sessions = this.db.prepare("SELECT game_id, seconds, started_at, ended_at FROM play_sessions WHERE user_id = ?").all(userId) as unknown as SessionRow[];
    const days = new Set<string>();
    for (const x of sessions) {
      s.longestSessionSeconds = Math.max(s.longestSessionSeconds, x.seconds);
      const start = zonedParts(new Date(x.started_at), tz);
      const hour = Math.floor(start.seconds / 3600);
      if (hour >= 22 || hour < 4) s.nightOwl = true;
      if (hour >= 5 && hour < 8) s.earlyBird = true;
      days.add(this.localDate(x.ended_at, tz));
      if (!perGame.has(x.game_id)) perGame.set(x.game_id, x.seconds);
    }
    s.daysPlayed = days.size;
    const sorted = [...days].sort();
    let run = 0;
    for (let i = 0; i < sorted.length; i++) {
      run = i > 0 && addDays(sorted[i - 1]!, 1) === sorted[i] ? run + 1 : 1;
      s.bestStreak = Math.max(s.bestStreak, run);
    }
    const played = [...perGame.entries()].filter(([, secs]) => secs > 0);
    s.playSeconds = played.reduce((n, [, secs]) => n + secs, 0);
    s.gamesPlayed = played.length;
    const genres = new Set<string>();
    const systems = new Set<string>();
    for (const [id] of played) {
      const g = this.library.get(id, false);
      if (!g) continue;
      for (const genre of g.genres) genres.add(genre);
      if (g.platform !== PC_PLATFORM) systems.add(g.platform);
      if (g.together?.length) s.togetherGames++;
    }
    s.genres = genres.size;
    s.systems = systems.size;
    const journal = this.db.prepare("SELECT status, rating FROM journal WHERE user_id = ?").all(userId) as Array<{ status: string | null; rating: number | null }>;
    s.sorted = journal.filter((j) => j.status).length;
    s.finished = journal.filter((j) => j.status === "done" || j.status === "completed").length;
    s.ratings = journal.filter((j) => j.rating != null).length;
    s.journalEntries = (this.db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE user_id = ?").get(userId) as { n: number }).n;
    const mine = granted ?? this.requests().list(userId);
    s.requests = mine.length;
    s.requestsGranted = mine.filter((r) => r.status === "ready").length;
    s.saveBackups = (this.db.prepare("SELECT COUNT(*) AS n FROM saves WHERE user_id = ?").get(userId) as { n: number }).n;
    s.shelves = (this.db.prepare("SELECT COUNT(*) AS n FROM shelves WHERE user_id = ? AND household = 0").get(userId) as { n: number }).n;
    s.rouletteSpins = this.counter(userId, "roulette");
    return s;
  }

  /** Works out what's unlocked (recording anything new) and the person's level. */
  progress(userId: number): { level: Level; stats: PlayerStats; achievements: AchievementView[] } {
    const stats = this.stats(userId);
    const known = new Map(
      (this.db.prepare("SELECT achievement, unlocked_at FROM achievements WHERE user_id = ?").all(userId) as Array<{ achievement: string; unlocked_at: string }>).map((r) => [r.achievement, r.unlocked_at]),
    );
    const views = ACHIEVEMENTS.map((def): AchievementView => {
      const [progress, goal] = def.progress(stats);
      let unlockedAt = known.get(def.id) ?? null;
      if (!unlockedAt && progress >= goal) {
        unlockedAt = now();
        this.db.prepare("INSERT OR IGNORE INTO achievements (user_id, achievement, unlocked_at) VALUES (?, ?, ?)").run(userId, def.id, unlockedAt);
      }
      return { id: def.id, name: def.name, description: def.description, icon: def.icon, tier: def.tier, xp: def.xp, progress, goal, unlockedAt };
    });
    const unlocked = views.filter((v) => v.unlockedAt).map((v) => v.id);
    return { level: levelFor(xpFor(stats, unlocked)), stats, achievements: views };
  }

  level(userId: number): Level {
    return this.progress(userId).level;
  }

  // ---- Celebrations -------------------------------------------------------------------

  /** Badges, requested games and bonus time this person hasn't been shown yet. */
  celebrations(userId: number): Celebrations {
    const { achievements } = this.progress(userId);
    const unseen = new Set((this.db.prepare("SELECT achievement FROM achievements WHERE user_id = ? AND seen_at IS NULL").all(userId) as Array<{ achievement: string }>).map((r) => r.achievement));
    const marks = new Map((this.db.prepare("SELECT id, celebrated_at FROM game_requests WHERE user_id = ?").all(userId) as Array<{ id: number; celebrated_at: string | null }>).map((r) => [r.id, r.celebrated_at]));
    const wishes: Celebrations["wishes"] = [];
    for (const r of this.requests().list(userId)) {
      const mark = marks.get(r.id);
      const ready = r.status === "ready" && !!r.libraryId;
      // Requests from before celebrations: games already in are settled quietly, the rest wait for theirs.
      if (mark === "legacy") {
        this.db.prepare("UPDATE game_requests SET celebrated_at = ? WHERE id = ?").run(ready ? now() : null, r.id);
        continue;
      }
      if (ready && !mark) wishes.push({ id: r.id, title: r.title, image: r.image, gameId: r.libraryId! });
    }
    const bonus = (this.db.prepare("SELECT id, minutes FROM time_requests WHERE user_id = ? AND state = 'approved' AND seen_at IS NULL AND day = ?").all(userId, zonedParts(new Date(), this.timeZone()).date) as Array<{
      id: number;
      minutes: number;
    }>).map((r) => ({ id: r.id, minutes: r.minutes }));
    return { achievements: achievements.filter((a) => a.unlockedAt && unseen.has(a.id)), wishes, bonus };
  }

  /**
   * Marks celebrations seen so they aren't shown again: the ones the screen showed, or (without
   * `shown`, older apps) everything. Something that arrived while the screen was open waits for the next one.
   */
  celebrated(userId: number, shown?: { achievements?: unknown; wishes?: unknown; bonus?: unknown }): void {
    const t = now();
    const list = <T>(x: unknown, ok: (v: unknown) => v is T): T[] | null => (shown ? (Array.isArray(x) ? x.filter(ok) : []) : null);
    const achievements = list(shown?.achievements, (v): v is string => typeof v === "string");
    const wishes = list(shown?.wishes, (v): v is number => Number.isInteger(v));
    const bonus = list(shown?.bonus, (v): v is number => Number.isInteger(v));
    if (achievements) for (const a of achievements) this.db.prepare("UPDATE achievements SET seen_at = ? WHERE user_id = ? AND achievement = ? AND seen_at IS NULL").run(t, userId, a);
    else this.db.prepare("UPDATE achievements SET seen_at = ? WHERE user_id = ? AND seen_at IS NULL").run(t, userId);
    const ready = this.requests()
      .list(userId)
      .filter((r) => r.status === "ready" && (!wishes || wishes.includes(r.id)))
      .map((r) => r.id);
    for (const id of ready) this.db.prepare("UPDATE game_requests SET celebrated_at = ? WHERE id = ? AND celebrated_at IS NULL").run(t, id);
    if (bonus) for (const id of bonus) this.db.prepare("UPDATE time_requests SET seen_at = ? WHERE id = ? AND user_id = ? AND state = 'approved' AND seen_at IS NULL").run(t, id, userId);
    else this.db.prepare("UPDATE time_requests SET seen_at = ? WHERE user_id = ? AND state = 'approved' AND seen_at IS NULL").run(t, userId);
  }

  // ---- Weekly recap ----------------------------------------------------------------------

  /** Everyone's week, Monday to Sunday: `weeksAgo` 0 is this week. */
  recap(weeksAgo = 0): WeeklyRecap {
    const tz = this.timeZone();
    const today = zonedParts(new Date(), tz);
    const monday = addDays(today.date, -((today.weekday + 6) % 7) - 7 * Math.max(0, Math.floor(weeksAgo)));
    const sunday = addDays(monday, 6);
    const ago = Math.ceil((Date.now() - Date.parse(`${monday}T00:00:00Z`)) / 86400_000) + 2;
    const inWeek = this.sessions(null, ago).filter((s) => {
      const d = this.localDate(s.ended_at, tz);
      return d >= monday && d <= sunday;
    });
    const title = (id: string) => this.library.get(id, false)?.title ?? null;
    const byGame = new Map<string, { seconds: number; players: Set<number> }>();
    const byDay = new Map<string, number>();
    const players: RecapPlayer[] = this.users.list().map((u) => {
      const mine = inWeek.filter((s) => s.user_id === u.id);
      const games = new Map<string, number>();
      for (const s of mine) {
        games.set(s.game_id, (games.get(s.game_id) ?? 0) + s.seconds);
        const g = byGame.get(s.game_id) ?? { seconds: 0, players: new Set<number>() };
        g.seconds += s.seconds;
        g.players.add(u.id);
        byGame.set(s.game_id, g);
        const d = this.localDate(s.ended_at, tz);
        byDay.set(d, (byDay.get(d) ?? 0) + s.seconds);
      }
      const top = [...games.entries()].sort((a, b) => b[1] - a[1]).find(([id]) => title(id));
      const finished = (this.db.prepare("SELECT updated_at FROM journal WHERE user_id = ? AND status = 'done'").all(u.id) as Array<{ updated_at: string }>).filter((j) => {
        const d = this.localDate(j.updated_at, tz);
        return d >= monday && d <= sunday;
      }).length;
      const badges = (this.db.prepare("SELECT unlocked_at FROM achievements WHERE user_id = ?").all(u.id) as Array<{ unlocked_at: string }>).filter((b) => {
        const d = this.localDate(b.unlocked_at, tz);
        return d >= monday && d <= sunday;
      }).length;
      const level = this.level(u.id);
      return {
        userId: u.id,
        name: u.displayName,
        avatar: u.avatar,
        kid: u.kidMode,
        seconds: mine.reduce((n, s) => n + s.seconds, 0),
        sessions: mine.length,
        games: games.size,
        topGame: top ? { id: top[0], title: title(top[0])!, seconds: top[1] } : null,
        finished,
        badges,
        level: level.level,
        rank: level.rank,
      };
    });
    const topGame = [...byGame.entries()].sort((a, b) => b[1].seconds - a[1].seconds).find(([id]) => title(id));
    const busiest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      from: monday,
      to: sunday,
      players: players.sort((a, b) => b.seconds - a.seconds || b.level - a.level || a.name.localeCompare(b.name)),
      totalSeconds: inWeek.reduce((n, s) => n + s.seconds, 0),
      topGame: topGame ? { id: topGame[0], title: title(topGame[0])!, seconds: topGame[1].seconds, players: topGame[1].players.size } : null,
      busiestDay: busiest ? { date: busiest[0], seconds: busiest[1] } : null,
    };
  }
}
