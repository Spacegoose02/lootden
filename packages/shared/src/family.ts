/**
 * Family features shared by the server, the web UI and the desktop app: play time limits and
 * bedtimes, achievements and levels, play-together tags and the raccoon parts levels unlock.
 */

// ---- Play time limits -------------------------------------------------------------

/** A person's play time rules, set by an admin (Settings, Library, Profiles, Play time). */
export interface PlayLimits {
  /** Minutes a day Monday to Friday; null for no limit. */
  weekdayMinutes: number | null;
  /** Minutes a day on Saturday and Sunday; null for no limit. */
  weekendMinutes: number | null;
  /** No play between these local times, like 21:00 to 07:00; null for no bedtime. */
  bedtime: { from: string; to: string } | null;
  /** Close the game when time runs out, instead of only warning. */
  hardStop: boolean;
}

export const NO_LIMITS: PlayLimits = { weekdayMinutes: null, weekendMinutes: null, bedtime: null, hardStop: false };

/** Where a person stands today: how much they've played and how much is left. */
export interface Allowance {
  /** Any limit or bedtime is set. */
  limited: boolean;
  /** Today in the household's time zone, YYYY-MM-DD. */
  date: string;
  timeZone: string;
  usedSeconds: number;
  /** Bonus time granted for today. */
  bonusSeconds: number;
  /** Today's limit plus bonus time; null when there is no daily limit. */
  allowedSeconds: number | null;
  /** null when there is no daily limit. */
  remainingSeconds: number | null;
  bedtime: { from: string; to: string } | null;
  /** It's bedtime right now. */
  bedtimeNow: boolean;
  /** Seconds until bedtime starts, when that's later today. */
  bedtimeInSeconds: number | null;
  hardStop: boolean;
  canPlay: boolean;
  /** Why not, in words, when canPlay is false. */
  reason: string | null;
}

/** A bonus time request: a kid asks for more minutes today, an admin says yes or no. */
export interface TimeRequest {
  id: number;
  userId: number;
  name: string;
  minutes: number;
  note: string | null;
  state: "pending" | "approved" | "declined";
  /** The day the time is for, YYYY-MM-DD in the household's time zone. */
  date: string;
  createdAt: string;
  decidedAt: string | null;
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight for "HH:MM", or null when it isn't a time. */
export function minutesOf(time: string): number | null {
  const m = TIME.exec(time.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const minutesOrNull = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const n = Math.round(Number(x));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 24 * 60) : null;
};

/** Play limits from anything (a request body, a stored row), with nonsense dropped. */
export function cleanLimits(x: unknown): PlayLimits {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const b = (o.bedtime && typeof o.bedtime === "object" ? o.bedtime : null) as Record<string, unknown> | null;
  const from = typeof b?.from === "string" ? b.from.trim() : "";
  const to = typeof b?.to === "string" ? b.to.trim() : "";
  const pad = (t: string) => {
    const m = minutesOf(t)!;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  return {
    weekdayMinutes: minutesOrNull(o.weekdayMinutes),
    weekendMinutes: minutesOrNull(o.weekendMinutes),
    bedtime: minutesOf(from) !== null && minutesOf(to) !== null && from !== to ? { from: pad(from), to: pad(to) } : null,
    hardStop: o.hardStop === true,
  };
}

export const hasLimits = (l: PlayLimits) => l.weekdayMinutes !== null || l.weekendMinutes !== null || l.bedtime !== null;

/** A time zone the runtime knows, else UTC. */
export function validTimeZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** The local date, time of day and weekday (0 = Sunday) of a moment in a time zone. */
export function zonedParts(at: Date, timeZone: string): { date: string; seconds: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "Sun");
  return { date: `${parts.year}-${parts.month}-${parts.day}`, seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second), weekday };
}

/** Is a time of day (seconds after midnight) inside a bedtime that may run past midnight? */
export function inBedtime(bedtime: { from: string; to: string }, seconds: number): boolean {
  const from = minutesOf(bedtime.from)! * 60;
  const to = minutesOf(bedtime.to)! * 60;
  return from < to ? seconds >= from && seconds < to : seconds >= from || seconds < to;
}

/**
 * Today's allowance from the limits, the play sessions that ended today (local date) and the
 * bonus time granted for today. `extraSeconds` is a session still running.
 */
export function computeAllowance(limits: PlayLimits, usedToday: number, bonusSeconds: number, now: Date, timeZone: string, extraSeconds = 0): Allowance {
  const tz = validTimeZone(timeZone);
  const { date, seconds, weekday } = zonedParts(now, tz);
  const weekend = weekday === 0 || weekday === 6;
  const daily = weekend ? limits.weekendMinutes : limits.weekdayMinutes;
  const used = Math.max(0, usedToday + extraSeconds);
  const allowed = daily === null ? null : daily * 60 + bonusSeconds;
  const remaining = allowed === null ? null : Math.max(0, allowed - used);
  const bedtimeNow = limits.bedtime ? inBedtime(limits.bedtime, seconds) : false;
  let bedtimeIn: number | null = null;
  if (limits.bedtime && !bedtimeNow) {
    const from = minutesOf(limits.bedtime.from)! * 60;
    if (from > seconds) bedtimeIn = from - seconds;
  }
  const outOfTime = remaining !== null && remaining <= 0;
  return {
    limited: hasLimits(limits),
    date,
    timeZone: tz,
    usedSeconds: used,
    bonusSeconds,
    allowedSeconds: allowed,
    remainingSeconds: remaining,
    bedtime: limits.bedtime,
    bedtimeNow,
    bedtimeInSeconds: bedtimeIn,
    hardStop: limits.hardStop,
    canPlay: !bedtimeNow && !outOfTime,
    reason: bedtimeNow ? `It's bedtime until ${limits.bedtime!.to}. Games are back tomorrow!` : outOfTime ? "That's all the play time for today. Ask for bonus time, or come back tomorrow!" : null,
  };
}

/** Seconds left before play has to stop: the daily time or bedtime, whichever comes first (0 during bedtime); null for no end. */
export function secondsLeft(a: Allowance): number | null {
  // Bedtime has started: nothing left, whatever the daily time says.
  if (a.bedtimeNow) return 0;
  const ends = [a.remainingSeconds, a.bedtimeInSeconds].filter((x): x is number => x !== null);
  return ends.length ? Math.min(...ends) : null;
}

// ---- Achievements, XP and levels -----------------------------------------------------

/** What achievements are worked out from, per person. */
export interface PlayerStats {
  playSeconds: number;
  /** Games with any play time. */
  gamesPlayed: number;
  installs: number;
  /** Backlog marked done. */
  finished: number;
  /** Games given any backlog status. */
  sorted: number;
  journalEntries: number;
  ratings: number;
  requests: number;
  /** Requests that are in the library now. */
  requestsGranted: number;
  saveBackups: number;
  shelves: number;
  rouletteSpins: number;
  /** Played a session that started between 22:00 and 04:00. */
  nightOwl: boolean;
  /** Played a session that started between 05:00 and 08:00. */
  earlyBird: boolean;
  /** The longest single session. */
  longestSessionSeconds: number;
  /** Different days with play, and the longest run of days in a row. */
  daysPlayed: number;
  bestStreak: number;
  /** Distinct genres among the games played. */
  genres: number;
  /** Emulated systems played. */
  systems: number;
  /** Play-together games played. */
  togetherGames: number;
}

export const EMPTY_STATS: PlayerStats = {
  playSeconds: 0,
  gamesPlayed: 0,
  installs: 0,
  finished: 0,
  sorted: 0,
  journalEntries: 0,
  ratings: 0,
  requests: 0,
  requestsGranted: 0,
  saveBackups: 0,
  shelves: 0,
  rouletteSpins: 0,
  nightOwl: false,
  earlyBird: false,
  longestSessionSeconds: 0,
  daysPlayed: 0,
  bestStreak: 0,
  genres: 0,
  systems: 0,
  togetherGames: 0,
};

export type AchievementTier = "bronze" | "silver" | "gold" | "legendary";

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  tier: AchievementTier;
  xp: number;
  /** [current, goal], for a progress bar; met when current >= goal. */
  progress: (s: PlayerStats) => [number, number];
}

const count = (key: keyof PlayerStats, goal: number) => (s: PlayerStats): [number, number] => [Math.min(Number(s[key]), goal), goal];
const flag = (key: keyof PlayerStats) => (s: PlayerStats): [number, number] => [s[key] ? 1 : 0, 1];
const hours = (h: number) => (s: PlayerStats): [number, number] => [Math.min(Math.floor(s.playSeconds / 3600), h), h];

const TIER_XP: Record<AchievementTier, number> = { bronze: 50, silver: 100, gold: 200, legendary: 400 };
const a = (id: string, icon: string, name: string, description: string, tier: AchievementTier, progress: AchievementDef["progress"]): AchievementDef => ({ id, icon, name, description, tier, xp: TIER_XP[tier], progress });

export const ACHIEVEMENTS: AchievementDef[] = [
  a("first-install", "📦", "Loot Acquired", "Install your first game", "bronze", count("installs", 1)),
  a("first-play", "🎮", "Press Start", "Play your first game", "bronze", count("gamesPlayed", 1)),
  a("collector", "🗃️", "Collector", "Install 10 games", "silver", count("installs", 10)),
  a("explorer", "🧭", "Den Explorer", "Play 5 different games", "bronze", count("gamesPlayed", 5)),
  a("globetrotter", "🌍", "Genre Hopper", "Play games from 5 different genres", "silver", count("genres", 5)),
  a("finisher", "🏁", "Credits Roll", "Mark a game as done", "bronze", count("finished", 1)),
  a("completionist", "🏆", "Completionist", "Finish 10 games", "gold", count("finished", 10)),
  a("ten-hours", "⏱️", "Warming Up", "Play for 10 hours", "bronze", hours(10)),
  a("fifty-hours", "🔥", "On Fire", "Play for 50 hours", "silver", hours(50)),
  a("hundred-hours", "💎", "Diamond Hands", "Play for 100 hours", "gold", hours(100)),
  a("marathon", "🏃", "Marathon", "Play one game for 3 hours straight", "silver", (s) => [Math.min(Math.floor(s.longestSessionSeconds / 3600), 3), 3]),
  a("streak-3", "📅", "Regular", "Play 3 days in a row", "bronze", count("bestStreak", 3)),
  a("streak-7", "⚡", "Unstoppable", "Play 7 days in a row", "gold", count("bestStreak", 7)),
  a("night-owl", "🦉", "Night Owl", "Start a game after 10 pm", "bronze", flag("nightOwl")),
  a("early-bird", "🐦", "Early Bird", "Start a game before 8 am", "bronze", flag("earlyBird")),
  a("organiser", "🗂️", "Organiser", "Sort 10 games into your backlog", "bronze", count("sorted", 10)),
  a("critic", "⭐", "Critic", "Rate 5 games", "bronze", count("ratings", 5)),
  a("storyteller", "📓", "Storyteller", "Write 5 journal entries", "silver", count("journalEntries", 5)),
  a("wishmaker", "🌠", "Wishmaker", "Ask for a game", "bronze", count("requests", 1)),
  a("wish-granted", "🎁", "Wish Granted", "Have a requested game arrive", "silver", count("requestsGranted", 1)),
  a("safe-keeper", "💾", "Safe Keeper", "Back up your saves 5 times", "bronze", count("saveBackups", 5)),
  a("curator", "🖼️", "Curator", "Make a shelf of your own", "bronze", count("shelves", 1)),
  a("lucky", "🎰", "Feeling Lucky", "Spin the game roulette 5 times", "bronze", count("rouletteSpins", 5)),
  a("time-traveller", "🕹️", "Time Traveller", "Play games on 3 retro systems", "gold", count("systems", 3)),
  a("better-together", "🤝", "Better Together", "Play 3 co-op or party games", "silver", count("togetherGames", 3)),
  a("den-legend", "👑", "Den Legend", "Play 250 hours", "legendary", hours(250)),
];

export interface AchievementView {
  id: string;
  name: string;
  description: string;
  icon: string;
  tier: AchievementTier;
  xp: number;
  progress: number;
  goal: number;
  unlockedAt: string | null;
}

/** XP from achievements plus a little for every hour played, game finished and game tried. */
export function xpFor(stats: PlayerStats, unlocked: Iterable<string>): number {
  const ids = new Set(unlocked);
  const fromBadges = ACHIEVEMENTS.filter((x) => ids.has(x.id)).reduce((n, x) => n + x.xp, 0);
  return fromBadges + Math.floor(stats.playSeconds / 3600) * 10 + stats.finished * 50 + stats.gamesPlayed * 15;
}

/** Total XP needed to reach a level: 0, 100, 300, 600, 1000... */
export const xpForLevel = (level: number) => 50 * level * (level - 1);

const RANKS: Array<[number, string]> = [
  [1, "Rookie Raccoon"],
  [3, "Den Explorer"],
  [5, "Loot Hunter"],
  [8, "Arcade Ace"],
  [12, "Neon Legend"],
  [16, "Den Master"],
];

export interface Level {
  level: number;
  rank: string;
  xp: number;
  /** XP at the start of this level and at the next one. */
  floor: number;
  next: number;
}

export function levelFor(xp: number): Level {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  const rank = RANKS.filter(([at]) => level >= at).at(-1)![1];
  return { level, rank, xp, floor: xpForLevel(level), next: xpForLevel(level + 1) };
}

// ---- Play together -----------------------------------------------------------------

export const TOGETHER_TAGS = [
  ["couch", "Couch co-op"],
  ["split", "Split screen"],
  ["coop", "Co-op"],
  ["online", "Online"],
  ["party", "Party"],
] as const;
export type TogetherTag = (typeof TOGETHER_TAGS)[number][0];
const TAG_IDS = new Set<string>(TOGETHER_TAGS.map(([id]) => id));

export const togetherLabel = (tag: string) => TOGETHER_TAGS.find(([id]) => id === tag)?.[1] ?? tag;

export function cleanTogether(x: unknown): TogetherTag[] {
  return Array.isArray(x) ? ([...new Set(x.map(String))].filter((t) => TAG_IDS.has(t)) as TogetherTag[]) : [];
}

/** Tags from the metadata's game modes (IGDB's "Co-operative", "Split screen"...) and genres. */
export function togetherFromMetadata(modes: string[], genres: string[]): TogetherTag[] {
  const has = (re: RegExp) => modes.some((m) => re.test(m)) || genres.some((g) => re.test(g));
  const tags: TogetherTag[] = [];
  if (has(/split[\s-]?screen/i)) tags.push("couch", "split");
  if (has(/co-?op/i)) tags.push("coop");
  if (has(/multiplayer|massively|online|battle royale/i)) tags.push("online");
  if (genres.some((g) => /party|fighting/i.test(g))) tags.push("party");
  return cleanTogether(tags);
}

// ---- Raccoon builder ---------------------------------------------------------------------

/** Parts a built raccoon is made of, as indexes into each list below. */
export interface RaccoonParts {
  fur: number;
  palette: number;
  eyes: number;
  mouth: number;
  accessory: number;
}

export type RaccoonPart = keyof RaccoonParts;

/** Everything the builder offers, base parts first; `level` is when an extra one unlocks. */
export const RACCOON_PARTS: Record<RaccoonPart, Array<{ name: string; level?: number }>> = {
  fur: [
    { name: "Classic" },
    { name: "Cocoa" },
    { name: "Silver" },
    { name: "Ginger" },
    { name: "Shadow" },
    { name: "Lavender" },
    { name: "Mint" },
    { name: "Sandy" },
    { name: "Frost", level: 3 },
    { name: "Golden", level: 5 },
    { name: "Cosmic", level: 8 },
    { name: "Neon", level: 12 },
  ],
  palette: [
    { name: "Midnight" },
    { name: "Grape" },
    { name: "Forest" },
    { name: "Ember" },
    { name: "Ocean" },
    { name: "Ruby" },
    { name: "Twilight" },
    { name: "Lagoon" },
    { name: "Sunset", level: 2 },
    { name: "Laser grid", level: 4 },
    { name: "Nuclear", level: 6 },
    { name: "Holo gold", level: 10 },
  ],
  eyes: [{ name: "Bright" }, { name: "Big" }, { name: "Happy" }, { name: "Wink" }, { name: "Sleepy" }, { name: "Curious" }],
  mouth: [{ name: "Smile" }, { name: "Cat" }, { name: "Laugh" }, { name: "Smirk" }, { name: "Buck tooth" }],
  accessory: [
    { name: "None" },
    { name: "None" },
    { name: "Headphones" },
    { name: "Gaming headset" },
    { name: "Cap" },
    { name: "Crown" },
    { name: "Beanie" },
    { name: "Bow" },
    { name: "Glasses" },
    { name: "Scarf" },
    { name: "Neon visor", level: 2 },
    { name: "Party hat", level: 3 },
    { name: "Wizard hat", level: 4 },
    { name: "Pirate hat", level: 5 },
    { name: "Cat ears", level: 6 },
    { name: "Astronaut helmet", level: 7 },
    { name: "VR headset", level: 8 },
    { name: "Halo", level: 9 },
    { name: "Flame crown", level: 11 },
  ],
};

/** How many of each part random raccoons pick from, so existing seeds keep their picture. */
export const RANDOM_PART_COUNTS: Record<RaccoonPart, number> = { fur: 8, palette: 8, eyes: 6, mouth: 5, accessory: 10 };

const PART_ORDER: RaccoonPart[] = ["fur", "palette", "eyes", "mouth", "accessory"];

/** A built raccoon's avatar seed: "b-<fur>-<palette>-<eyes>-<mouth>-<accessory>". */
export function raccoonSeed(p: RaccoonParts): string {
  return `b-${PART_ORDER.map((k) => p[k]).join("-")}`;
}

/** The parts of a built raccoon's seed, or null for a random one. */
export function parseRaccoonSeed(seed: string): RaccoonParts | null {
  const m = /^b-(\d+)-(\d+)-(\d+)-(\d+)-(\d+)$/.exec(seed);
  if (!m) return null;
  const nums = m.slice(1).map(Number);
  const parts = Object.fromEntries(PART_ORDER.map((k, i) => [k, nums[i]!])) as unknown as RaccoonParts;
  return PART_ORDER.every((k) => parts[k] < RACCOON_PARTS[k].length) ? parts : null;
}

/** The first part of a built raccoon that needs a higher level than this, or null when all are unlocked. */
export function lockedPart(p: RaccoonParts, level: number): { part: RaccoonPart; name: string; level: number } | null {
  for (const k of PART_ORDER) {
    const item = RACCOON_PARTS[k][p[k]]!;
    if (item.level && item.level > level) return { part: k, name: item.name, level: item.level };
  }
  return null;
}

// ---- Weekly recap --------------------------------------------------------------------

export interface RecapPlayer {
  userId: number;
  name: string;
  avatar: string;
  kid: boolean;
  seconds: number;
  sessions: number;
  games: number;
  topGame: { id: string; title: string; seconds: number } | null;
  finished: number;
  badges: number;
  level: number;
  rank: string;
}

export interface WeeklyRecap {
  /** Monday and Sunday of the week, YYYY-MM-DD. */
  from: string;
  to: string;
  players: RecapPlayer[];
  totalSeconds: number;
  topGame: { id: string; title: string; seconds: number; players: number } | null;
  /** Busiest day of the week, by play time. */
  busiestDay: { date: string; seconds: number } | null;
}
