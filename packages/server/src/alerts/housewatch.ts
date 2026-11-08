import { zonedParts } from "@lootden/shared";
import type { DiscordPoster } from "../integrations/discord.js";
import type { FamilyService } from "../users/family.js";
import type { GameNights } from "../users/gamenight.js";
import type { PresenceService } from "../users/presence.js";
import type { UserRepo } from "../users/repo.js";
import type { Notifier } from "./notifier.js";
import type { PushService } from "./webpush.js";

/**
 * Things that happen at a time rather than on a request, checked every minute: a kid running
 * out of today's play time while playing, and game night starting within the hour.
 */
export class HouseWatch {
  private timer: NodeJS.Timeout | null = null;
  /** user id → the day they were last reported out of time, so it's said once a day. */
  private outOfTime = new Map<number, string>();

  constructor(
    private readonly users: UserRepo,
    private readonly family: FamilyService,
    private readonly presence: PresenceService,
    private readonly gameNights: GameNights,
    private readonly notifier: Notifier,
    private readonly push: PushService,
    private readonly discord: DiscordPoster,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    await this.timeLimits();
    await this.gameNightReminders();
  }

  private async timeLimits(): Promise<void> {
    const today = zonedParts(new Date(), this.family.timeZone()).date;
    for (const np of this.presence.nowPlaying({ id: null, admin: true, kid: false })) {
      const user = this.users.byId(np.userId);
      if (!user?.kidMode || np.remainingSeconds === null || np.remainingSeconds > 0) continue;
      if (this.outOfTime.get(np.userId) === today) continue;
      this.outOfTime.set(np.userId, today);
      await this.notifier.send("timeLimit", `${np.name} reached today's play time`, `Still playing ${np.title} on ${np.device}`, "/requests");
    }
  }

  private async gameNightReminders(): Promise<void> {
    for (const n of this.gameNights.dueReminders(60)) {
      const what = n.game ? ` (${n.game.title})` : "";
      await this.notifier.send("gameNight", `${n.title} starts in ${n.inMinutes} minutes${what}`, n.players.map((p) => p.name).join(", ") || null, "/game-night");
      for (const p of n.players) void this.push.toUser(p.id, { title: `🎮 ${n.title} in ${n.inMinutes} minutes`, body: n.game ? `Playing ${n.game.title}` : null, link: "/game-night", tag: `night-${n.id}` });
      void this.discord.gameNight(n, n.inMinutes);
    }
  }
}
