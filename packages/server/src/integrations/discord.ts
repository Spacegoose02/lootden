import { json, type Db } from "../db/database.js";
import type { FetchLike } from "../metadata/http.js";

const KEY = "discord";
const MASK = "********";

export interface DiscordSettings {
  /** A Discord channel's webhook (Server settings, Integrations, Webhooks). */
  webhookUrl: string;
  newGames: boolean;
  gameNights: boolean;
  /** "rare": only achievements fewer than 10% of players have; "all": every unlock; "off". */
  achievements: "off" | "rare" | "all";
  finished: boolean;
  /** Leave out games that aren't known to be kid-safe (when kids read the channel). */
  kidSafeOnly: boolean;
}

const DEFAULTS: DiscordSettings = { webhookUrl: "", newGames: true, gameNights: true, achievements: "rare", finished: true, kidSafeOnly: false };
const WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

interface Embed {
  title: string;
  description?: string;
  url?: string;
  color?: number;
  thumbnail?: { url: string };
  footer?: { text: string };
}

/**
 * Posts to a family Discord channel through a webhook: games added to the library, game nights,
 * achievements and finished games. Like the Dendrop link, but one-way and needing no bot.
 */
export class DiscordPoster {
  lastError: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly publicUrl: () => string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly log: { warn: (o: object, m: string) => void } = { warn: () => {} },
  ) {}

  settings(): DiscordSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    return { ...DEFAULTS, ...json<Partial<DiscordSettings>>(row?.value, {}) };
  }

  view() {
    const s = this.settings();
    return { ...s, webhookUrl: s.webhookUrl ? MASK : "", connected: !!s.webhookUrl, error: this.lastError };
  }

  save(patch: Partial<DiscordSettings>) {
    const cur = this.settings();
    let url = cur.webhookUrl;
    if (typeof patch.webhookUrl === "string" && patch.webhookUrl !== MASK) {
      url = patch.webhookUrl.trim().replace(/\?.*$/, "");
      if (url && !WEBHOOK.test(url)) throw new Error("Paste a Discord webhook URL (https://discord.com/api/webhooks/…)");
    }
    const bool = (v: unknown, keep: boolean) => (typeof v === "boolean" ? v : keep);
    const next: DiscordSettings = {
      webhookUrl: url,
      newGames: bool(patch.newGames, cur.newGames),
      gameNights: bool(patch.gameNights, cur.gameNights),
      achievements: patch.achievements && ["off", "rare", "all"].includes(patch.achievements) ? patch.achievements : cur.achievements,
      finished: bool(patch.finished, cur.finished),
      kidSafeOnly: bool(patch.kidSafeOnly, cur.kidSafeOnly),
    };
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(next));
    this.lastError = null;
    return this.view();
  }

  private link(path: string): string | undefined {
    const base = this.publicUrl().replace(/\/+$/, "");
    return base ? `${base}${path}` : undefined;
  }

  /** Sends one message; never throws (the reason is kept for the settings page). */
  async post(embed: Embed): Promise<boolean> {
    const url = this.settings().webhookUrl;
    if (!url) return false;
    try {
      const res = await this.fetchImpl(`${url}?wait=true`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "LootDen", embeds: [{ color: 0x8b5cf6, ...embed }], allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Discord answered ${res.status}`);
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.warn({ err: this.lastError }, "Discord webhook failed");
      return false;
    }
  }

  private allowed(kidSafe: boolean | null): boolean {
    return !this.settings().kidSafeOnly || kidSafe === true;
  }

  async newGame(game: { id: string; title: string; kidSafe: boolean | null; coverUrl: string | null; summary?: string | null }): Promise<void> {
    if (!this.settings().newGames || !this.allowed(game.kidSafe)) return;
    const cover = game.coverUrl ? this.link(game.coverUrl) : undefined;
    await this.post({ title: `🆕 ${game.title} is in the library`, description: game.summary?.slice(0, 300) || undefined, url: this.link(`/games/${game.id}`), thumbnail: cover ? { url: cover } : undefined });
  }

  async gameNight(n: { title: string; date: string; time: string; players: Array<{ name: string }>; game: { title: string } | null }, reminder?: number): Promise<void> {
    if (!this.settings().gameNights) return;
    const when = new Date(`${n.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
    await this.post({
      title: reminder ? `⏰ ${n.title} starts in ${reminder} minutes` : `📅 ${n.title}`,
      description: [`${when} at ${n.time}`, n.game ? `Playing ${n.game.title}` : null, n.players.length ? `With ${n.players.map((p) => p.name).join(", ")}` : null].filter(Boolean).join("\n"),
      url: this.link("/game-night"),
    });
  }

  async achievements(by: string, game: { title: string; kidSafe: boolean | null }, items: Array<{ name: string; rarity: number | null }>): Promise<void> {
    const mode = this.settings().achievements;
    if (mode === "off" || !this.allowed(game.kidSafe)) return;
    const shown = mode === "rare" ? items.filter((a) => a.rarity != null && a.rarity <= 10) : items;
    if (!shown.length) return;
    await this.post({
      title: `🏆 ${by} unlocked ${shown.length === 1 ? `"${shown[0]!.name}"` : `${shown.length} achievements`} in ${game.title}`,
      description: shown.length > 1 ? shown.slice(0, 10).map((a) => `• ${a.name}${a.rarity != null ? ` (${a.rarity.toFixed(1)}% of players)` : ""}`).join("\n") : shown[0]!.rarity != null ? `Only ${shown[0]!.rarity!.toFixed(1)}% of players have it.` : undefined,
    });
  }

  async finished(by: string, game: { id: string; title: string; kidSafe: boolean | null }, status: "done" | "completed"): Promise<void> {
    if (!this.settings().finished || !this.allowed(game.kidSafe)) return;
    await this.post({ title: status === "completed" ? `💯 ${by} completed ${game.title}` : `🎉 ${by} finished ${game.title}`, url: this.link(`/games/${game.id}`) });
  }

  async test(): Promise<void> {
    if (!this.settings().webhookUrl) throw new Error("Paste the webhook URL first");
    if (!(await this.post({ title: "👋 LootDen is connected", description: "New games, game nights and achievements will show up here." }))) throw new Error(this.lastError ?? "Discord didn't take the message");
  }
}
