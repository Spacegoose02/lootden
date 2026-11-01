import type { AchievementProgress, AchievementSource, AchievementSummary, GameAchievement, GameAchievements } from "@lootden/shared";
import type { AddonRegistry } from "../addons/registry.js";
import { RA_API } from "../addons/retroachievements.js";
import { json, now, type Db } from "../db/database.js";
import type { FetchLike } from "../metadata/http.js";
import { resolveSteamId } from "../news/wishlist.js";

/** How long looked-up achievements are reused before asking the source again. */
const FRESH_MS = 6 * 60 * 60 * 1000;

interface CacheRow {
  source: AchievementSource;
  source_id: string;
  title: string;
  link: string | null;
  data: string;
  unlocked: number;
  total: number;
  last_unlocked_at: string | null;
  fetched_at: string;
}

/** Titles compared loosely: "Super Mario World (USA)" matches "Super Mario World". */
export function looseTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/^the\s+|,\s*the\b/g, " ")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const iso = (unixSeconds: number | null | undefined) => (unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null);
/** RetroAchievements dates: "2024-01-31 18:20:00" in UTC. */
const raDate = (d: string | null | undefined) => (d ? new Date(`${d.replace(" ", "T")}Z`).toISOString() : null);

function summarise(source: AchievementSource, sourceId: string, title: string, items: GameAchievement[], url: string | null): GameAchievements {
  // Unlocked first, newest first; then locked, most common first.
  items.sort((a, b) => (a.unlockedAt && b.unlockedAt ? b.unlockedAt.localeCompare(a.unlockedAt) : a.unlockedAt ? -1 : b.unlockedAt ? 1 : (b.rarity ?? 0) - (a.rarity ?? 0)));
  return { source, sourceId, title, unlocked: items.filter((i) => i.unlockedAt).length, total: items.length, items, fetchedAt: now(), url };
}

/**
 * Real achievements from Steam, RetroAchievements and Xbox (through OpenXBL), for the account
 * each person connected under Game libraries. Looked up when a game page asks, kept six hours,
 * and summed up for the profile from what has been looked up.
 */
export class AchievementService {
  constructor(
    private readonly db: Db,
    private readonly addons: AddonRegistry,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  connected(userId: number): AchievementSource[] {
    const out: AchievementSource[] = [];
    if (this.addons.accountConfig(userId, "steam")?.steamId) out.push("steam");
    if (this.addons.accountConfig(userId, "retroachievements")?.username) out.push("retroachievements");
    if (this.addons.accountConfig(userId, "xbox")?.apiKey) out.push("xbox");
    return out;
  }

  private cached(userId: number, source: AchievementSource, sourceId: string): CacheRow | undefined {
    return this.db.prepare("SELECT * FROM achievement_cache WHERE user_id = ? AND source = ? AND source_id = ?").get(userId, source, sourceId) as CacheRow | undefined;
  }

  private store(userId: number, a: GameAchievements, link: string | null): GameAchievements {
    const last = a.items.map((i) => i.unlockedAt).filter(Boolean).sort().pop() ?? null;
    this.db
      .prepare(
        `INSERT INTO achievement_cache (user_id, source, source_id, title, link, data, unlocked, total, last_unlocked_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source, source_id) DO UPDATE SET title = excluded.title, link = COALESCE(excluded.link, achievement_cache.link), data = excluded.data,
           unlocked = excluded.unlocked, total = excluded.total, last_unlocked_at = excluded.last_unlocked_at, fetched_at = excluded.fetched_at`,
      )
      .run(userId, a.source, a.sourceId, a.title, link, JSON.stringify(a), a.unlocked, a.total, last, a.fetchedAt);
    return a;
  }

  /** From the cache while fresh, else from the source (and the cache again if the source fails). */
  private async get(userId: number, source: AchievementSource, sourceId: string, link: string | null, refresh: boolean, load: () => Promise<GameAchievements | null>): Promise<GameAchievements | null> {
    const row = this.cached(userId, source, sourceId);
    if (row && !refresh && Date.now() - Date.parse(row.fetched_at) < FRESH_MS) return json<GameAchievements | null>(row.data, null);
    try {
      const fresh = await load();
      if (!fresh) return null;
      return this.store(userId, fresh, link);
    } catch (err) {
      if (row) return json<GameAchievements | null>(row.data, null);
      throw err;
    }
  }

  // ---- Steam ------------------------------------------------------------------------

  async steam(userId: number, appId: string, link: string | null, refresh = false): Promise<GameAchievements | null> {
    const cfg = this.addons.accountConfig(userId, "steam");
    if (!cfg?.steamId || !/^\d+$/.test(appId)) return null;
    const key = cfg.apiKey || this.addons.steamKey(userId);
    if (!key) return null;
    return this.get(userId, "steam", appId, link, refresh, async () => {
      const steamId = await resolveSteamId(cfg.steamId!, this.fetchImpl);
      const schemaUrl = new URL("https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/");
      schemaUrl.searchParams.set("key", key);
      schemaUrl.searchParams.set("appid", appId);
      schemaUrl.searchParams.set("l", "english");
      const schemaRes = await this.fetchImpl(schemaUrl);
      if (!schemaRes.ok) throw new Error(`Steam answered ${schemaRes.status}`);
      const schema = (await schemaRes.json()) as {
        game?: { gameName?: string; availableGameStats?: { achievements?: Array<{ name: string; displayName?: string; description?: string; icon?: string; icongray?: string; hidden?: number }> } };
      };
      const defs = schema.game?.availableGameStats?.achievements ?? [];
      // No achievements at all: nothing to show (and nothing to ask for).
      if (!defs.length) return summarise("steam", appId, schema.game?.gameName ?? "", [], `https://steamcommunity.com/stats/${appId}/achievements`);
      const mineUrl = new URL("https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/");
      mineUrl.searchParams.set("key", key);
      mineUrl.searchParams.set("steamid", steamId);
      mineUrl.searchParams.set("appid", appId);
      const mineRes = await this.fetchImpl(mineUrl);
      const mine = (await mineRes.json().catch(() => ({}))) as { playerstats?: { success?: boolean; error?: string; achievements?: Array<{ apiname: string; achieved: number; unlocktime?: number }> } };
      if (!mineRes.ok || mine.playerstats?.success === false) {
        const why = mine.playerstats?.error ?? "";
        if (/private/i.test(why) || mineRes.status === 403) throw new Error("Steam keeps this profile's game details private. In Steam, Edit Profile, Privacy Settings, set Game details to Public");
        // "Requested app has no stats": not owned or never played; everything is locked.
      }
      const got = new Map((mine.playerstats?.achievements ?? []).map((a) => [a.apiname, a]));
      const pctUrl = new URL("https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/");
      pctUrl.searchParams.set("gameid", appId);
      const pct = await this.fetchImpl(pctUrl)
        .then((r) => (r.ok ? (r.json() as Promise<{ achievementpercentages?: { achievements?: Array<{ name: string; percent: number | string }> } }>) : null))
        .catch(() => null);
      const rarity = new Map((pct?.achievementpercentages?.achievements ?? []).map((a) => [a.name, Math.round(Number(a.percent) * 10) / 10]));
      const items: GameAchievement[] = defs.map((d) => {
        const m = got.get(d.name);
        const unlocked = m?.achieved ? (iso(m.unlocktime) ?? now()) : null;
        return {
          id: d.name,
          name: d.displayName ?? d.name,
          // Hidden achievements keep their secret until unlocked.
          description: d.hidden && !unlocked ? "Hidden achievement" : (d.description ?? ""),
          iconUrl: (unlocked ? d.icon : d.icongray) ?? d.icon ?? null,
          unlockedAt: unlocked,
          rarity: rarity.get(d.name) ?? null,
        };
      });
      return summarise("steam", appId, schema.game?.gameName ?? "", items, `https://steamcommunity.com/profiles/${steamId}/stats/${appId}/achievements`);
    });
  }

  // ---- RetroAchievements ------------------------------------------------------------

  private raUrl(endpoint: string, cfg: Record<string, string>, params: Record<string, string>): URL {
    const url = new URL(`${RA_API}/${endpoint}`);
    url.searchParams.set("u", cfg.username ?? "");
    url.searchParams.set("y", cfg.apiKey ?? "");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url;
  }

  /** Every game this person has RetroAchievements progress in, kept like a game's achievements. */
  private async raGames(userId: number, cfg: Record<string, string>): Promise<Array<{ id: string; title: string; console: string }>> {
    const row = this.cached(userId, "retroachievements", "_games");
    if (row && Date.now() - Date.parse(row.fetched_at) < FRESH_MS) return json(row.data, []);
    const res = await this.fetchImpl(this.raUrl("API_GetUserCompletionProgress.php", cfg, { c: "500" }));
    if (!res.ok) throw new Error(`RetroAchievements answered ${res.status}`);
    const body = (await res.json()) as { Results?: Array<{ GameID: number; Title: string; ConsoleName?: string }> };
    const games = (body.Results ?? []).map((r) => ({ id: String(r.GameID), title: r.Title, console: r.ConsoleName ?? "" }));
    // Kept out of the summary: total 0 and a title that never shows.
    this.db
      .prepare(
        `INSERT INTO achievement_cache (user_id, source, source_id, title, link, data, unlocked, total, last_unlocked_at, fetched_at) VALUES (?, 'retroachievements', '_games', '', NULL, ?, 0, 0, NULL, ?)
         ON CONFLICT(user_id, source, source_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
      )
      .run(userId, JSON.stringify(games), now());
    return games;
  }

  /** An emulated game's RetroAchievements, found by its title among the games this person has played there. */
  async retro(userId: number, title: string, link: string | null, refresh = false): Promise<GameAchievements | null> {
    const cfg = this.addons.accountConfig(userId, "retroachievements");
    if (!cfg?.username || !cfg.apiKey) return null;
    const want = looseTitle(title);
    const match = (await this.raGames(userId, cfg)).find((g) => looseTitle(g.title) === want);
    if (!match) return null;
    return this.raGame(userId, match.id, link, refresh);
  }

  async raGame(userId: number, gameId: string, link: string | null, refresh = false): Promise<GameAchievements | null> {
    const cfg = this.addons.accountConfig(userId, "retroachievements");
    if (!cfg?.username || !cfg.apiKey || !/^\d+$/.test(gameId)) return null;
    return this.get(userId, "retroachievements", gameId, link, refresh, async () => {
      const res = await this.fetchImpl(this.raUrl("API_GetGameInfoAndUserProgress.php", cfg, { g: gameId }));
      if (res.status === 401 || res.status === 403) throw new Error("RetroAchievements refused the key");
      if (!res.ok) throw new Error(`RetroAchievements answered ${res.status}`);
      const body = (await res.json()) as {
        Title?: string;
        NumDistinctPlayers?: number;
        Achievements?: Record<string, { ID: number; Title: string; Description?: string; Points?: number; BadgeName?: string; DateEarned?: string; DateEarnedHardcore?: string; NumAwarded?: number }>;
      };
      const players = body.NumDistinctPlayers || 0;
      const items: GameAchievement[] = Object.values(body.Achievements ?? {}).map((a) => {
        const unlocked = raDate(a.DateEarnedHardcore ?? a.DateEarned);
        return {
          id: String(a.ID),
          name: a.Title,
          description: a.Description ?? "",
          iconUrl: a.BadgeName ? `https://media.retroachievements.org/Badge/${a.BadgeName}${unlocked ? "" : "_lock"}.png` : null,
          unlockedAt: unlocked,
          rarity: players && a.NumAwarded != null ? Math.round((a.NumAwarded / players) * 1000) / 10 : null,
          points: a.Points ?? null,
        };
      });
      return summarise("retroachievements", gameId, body.Title ?? "", items, `https://retroachievements.org/game/${gameId}`);
    });
  }

  // ---- Xbox (OpenXBL) -----------------------------------------------------------------

  async xbox(userId: number, titleId: string, link: string | null, refresh = false): Promise<GameAchievements | null> {
    const cfg = this.addons.accountConfig(userId, "xbox");
    if (!cfg?.apiKey || !/^\d+$/.test(titleId)) return null;
    return this.get(userId, "xbox", titleId, link, refresh, async () => {
      const res = await this.fetchImpl(`https://xbl.io/api/v2/achievements/title/${titleId}`, { headers: { "X-Authorization": cfg.apiKey!, Accept: "application/json" } });
      if (res.status === 401 || res.status === 403) throw new Error("OpenXBL refused the key; copy it again from xbl.io");
      if (res.status === 429) throw new Error("OpenXBL's hourly limit was reached; try again later");
      if (!res.ok) throw new Error(`OpenXBL answered ${res.status}`);
      const body = (await res.json()) as {
        achievements?: Array<{
          id: string;
          name: string;
          description?: string;
          lockedDescription?: string;
          progressState?: string;
          progression?: { timeUnlocked?: string };
          mediaAssets?: Array<{ url?: string }>;
          rarity?: { currentPercentage?: number };
          titleAssociations?: Array<{ name?: string }>;
        }>;
      };
      const list = body.achievements ?? [];
      const items: GameAchievement[] = list.map((a) => {
        const unlocked = a.progressState === "Achieved" ? (a.progression?.timeUnlocked && !a.progression.timeUnlocked.startsWith("0001") ? new Date(a.progression.timeUnlocked).toISOString() : now()) : null;
        return {
          id: a.id,
          name: a.name,
          description: unlocked ? (a.description ?? "") : (a.lockedDescription ?? a.description ?? ""),
          iconUrl: a.mediaAssets?.[0]?.url?.replace(/^http:/, "https:") ?? null,
          unlockedAt: unlocked,
          rarity: a.rarity?.currentPercentage ?? null,
        };
      });
      return summarise("xbox", titleId, list[0]?.titleAssociations?.[0]?.name ?? "", items, null);
    });
  }

  // ---- The profile's summary ----------------------------------------------------------

  summary(userId: number): AchievementSummary {
    const rows = this.db.prepare("SELECT * FROM achievement_cache WHERE user_id = ? AND total > 0 ORDER BY COALESCE(last_unlocked_at, '') DESC").all(userId) as unknown as CacheRow[];
    const games: AchievementProgress[] = rows.map((r) => ({ source: r.source, sourceId: r.source_id, title: r.title, link: r.link, unlocked: r.unlocked, total: r.total, lastUnlockedAt: r.last_unlocked_at }));
    const recent = rows
      .flatMap((r) =>
        json<GameAchievements | null>(r.data, null)
          ?.items.filter((i) => i.unlockedAt)
          .map((i) => ({ title: r.title, name: i.name, iconUrl: i.iconUrl, unlockedAt: i.unlockedAt!, link: r.link, source: r.source })) ?? [],
      )
      .sort((a, b) => b.unlockedAt.localeCompare(a.unlockedAt))
      .slice(0, 12);
    return {
      connected: this.connected(userId),
      games,
      recent,
      unlocked: games.reduce((n, g) => n + g.unlocked, 0),
      perfectGames: games.filter((g) => g.total > 0 && g.unlocked === g.total).length,
    };
  }

  /** Total unlocked per person, for the family board. */
  totals(): Map<number, { unlocked: number; perfect: number }> {
    const rows = this.db.prepare("SELECT user_id, SUM(unlocked) AS u, SUM(CASE WHEN total > 0 AND unlocked = total THEN 1 ELSE 0 END) AS p FROM achievement_cache GROUP BY user_id").all() as Array<{ user_id: number; u: number; p: number }>;
    return new Map(rows.map((r) => [r.user_id, { unlocked: r.u ?? 0, perfect: r.p ?? 0 }]));
  }
}
