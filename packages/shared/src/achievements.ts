/** Real game achievements, from the store or service that tracks them (not LootDen's own badges). */
export type AchievementSource = "steam" | "retroachievements" | "xbox";

export const ACHIEVEMENT_SOURCES: Record<AchievementSource, string> = {
  steam: "Steam",
  retroachievements: "RetroAchievements",
  xbox: "Xbox",
};

export interface GameAchievement {
  id: string;
  name: string;
  description: string;
  iconUrl: string | null;
  /** ISO date, null while locked. */
  unlockedAt: string | null;
  /** Share of players who have it (0-100), when the source says. */
  rarity: number | null;
  /** RetroAchievements: points it's worth. */
  points?: number | null;
}

export interface GameAchievements {
  source: AchievementSource;
  /** The id the source knows the game by (Steam app id, RetroAchievements game id, Xbox title id). */
  sourceId: string;
  title: string;
  unlocked: number;
  total: number;
  items: GameAchievement[];
  fetchedAt: string;
  /** The game's achievement page on the source's site. */
  url: string | null;
}

/** One game in a person's achievement summary (from what has been looked up so far). */
export interface AchievementProgress {
  source: AchievementSource;
  sourceId: string;
  title: string;
  /** Where the game opens in LootDen: /games/<id> or /store/<addon>/<id>. */
  link: string | null;
  unlocked: number;
  total: number;
  lastUnlockedAt: string | null;
}

export interface AchievementSummary {
  /** Sources this person has connected. */
  connected: AchievementSource[];
  games: AchievementProgress[];
  /** Newest unlocks across games. */
  recent: Array<{ title: string; name: string; iconUrl: string | null; unlockedAt: string; link: string | null; source: AchievementSource }>;
  unlocked: number;
  perfectGames: number;
}

/** Percent done, rounded down so 99.6% doesn't read as 100%. */
export const achievementPercent = (a: { unlocked: number; total: number }) => (a.total ? Math.floor((a.unlocked / a.total) * 100) : 0);
