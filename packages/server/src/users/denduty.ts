import type { Vault } from "../auth/vault.js";
import { json, type Db } from "../db/database.js";
import type { FetchLike } from "../metadata/http.js";
import type { FamilyService } from "./family.js";
import type { PresenceService } from "./presence.js";
import type { UserRepo } from "./repo.js";

/**
 * Den Duty link: Den Duty is the family's chore tracker (a sibling app). LootDen polls its
 * /api/v1 gaming endpoint with a control token and
 *   - locks a kid's games while a Den Duty time-out says so (all games, or just Roblox),
 *   - can keep games closed until the kid's chores for today are done,
 *   - hands out game time a kid bought in Den Duty's rewards shop, and marks it given there,
 *   - lets family goals reached in Den Duty unlock a game night.
 */

export interface DenDutySettings {
  /** Den Duty's address, like http://192.168.1.10:8081 */
  url: string;
  homeId: string;
  /** LootDen profile id to Den Duty kid id. */
  kids: Record<string, string>;
  /** Time-outs that lock games lock them here. */
  locks: boolean;
  /** No games until today's chores are done (waiting for a grown-up counts). */
  choresFirst: boolean;
  /** Game time bought in Den Duty's shop is added as bonus time. */
  gameTime: boolean;
}

/** What the settings page shows; the token never comes back. */
export interface DenDutyView extends DenDutySettings {
  hasToken: boolean;
  connected: boolean;
  error: string | null;
  lastSyncAt: string | null;
  /** Den Duty's kids, for matching them to profiles. */
  denKids: Array<{ id: string; name: string }>;
  /** Family goals reached lately (for game night). */
  goals: Array<{ id: string; title: string; icon: string; reward: string | null; reachedAt: string }>;
}

interface GamingKid {
  id: string;
  name: string;
  chores: { due: number; done: number; left: number } | null;
  locks: Array<{ id: string; what: string; games: "all" | "roblox"; endsAt: string }>;
  gameTime: Array<{ orderId: string; title: string; icon: string; minutes: number; boughtAt: string }>;
}

interface GamingState {
  today: string;
  kids: GamingKid[];
  familyGoalsReached: Array<{ id: string; title: string; icon: string; reward: string | null; reachedAt: string; done: boolean }>;
}

const KEY = "denduty";
const TOKEN_KEY = "denduty_token";
const DEFAULTS: DenDutySettings = { url: "", homeId: "", kids: {}, locks: true, choresFirst: false, gameTime: true };
const SYNC_MS = 60_000;

const clean = (s: unknown) => String(s ?? "").trim();

/** Lock reasons in words, the way a kid reads them. */
export interface DenDutyLock {
  all: string | null;
  roblox: string | null;
}

export class DenDutyLink {
  private state: GamingState | null = null;
  private error: string | null = null;
  private lastSyncAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;
  /** Locks already acted on, so "close the game" goes out once per new time-out. */
  private readonly closedFor = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly users: UserRepo,
    private readonly family: FamilyService,
    private readonly presence: PresenceService,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  settings(): DenDutySettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    return { ...DEFAULTS, ...json<Partial<DenDutySettings>>(row?.value, {}) };
  }

  private token(): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(TOKEN_KEY) as { value: string } | undefined;
    return row ? this.vault.decrypt(row.value) : "";
  }

  view(): DenDutyView {
    const s = this.settings();
    return {
      ...s,
      hasToken: !!this.token(),
      connected: !!this.state && !this.error,
      error: this.error,
      lastSyncAt: this.lastSyncAt,
      denKids: (this.state?.kids ?? []).map((k) => ({ id: k.id, name: k.name })),
      goals: (this.state?.familyGoalsReached ?? []).map(({ done: _d, ...g }) => g),
    };
  }

  /** Admin saves the link. A blank token keeps the one saved; `token: null` removes it. */
  async save(patch: Partial<DenDutySettings> & { token?: string | null }): Promise<DenDutyView> {
    const cur = this.settings();
    let url = patch.url === undefined ? cur.url : clean(patch.url).replace(/\/+$/, "");
    if (url && !/^https?:\/\/[^/\s]+/i.test(url)) throw new Error("Den Duty's address starts with http:// or https://");
    // A pasted page address works too: keep the server part.
    if (url) url = new URL(url).origin;
    let homeId = patch.homeId === undefined ? cur.homeId : clean(patch.homeId);
    // People paste a whole Den Duty link; the home id is the part after /homes/.
    const m = /homes\/([\w-]+)/.exec(homeId);
    if (m) homeId = m[1]!;
    if (homeId && !/^[\w-]{1,64}$/.test(homeId)) throw new Error("That doesn't look like a Den Duty home id");
    const kids: Record<string, string> = {};
    const src = patch.kids === undefined ? cur.kids : patch.kids;
    for (const [userId, kidId] of Object.entries(src ?? {})) {
      if (!kidId || !this.users.byId(Number(userId))) continue;
      kids[String(Number(userId))] = clean(kidId).slice(0, 64);
    }
    const bool = (v: unknown, keep: boolean) => (typeof v === "boolean" ? v : keep);
    const next: DenDutySettings = {
      url,
      homeId,
      kids,
      locks: bool(patch.locks, cur.locks),
      choresFirst: bool(patch.choresFirst, cur.choresFirst),
      gameTime: bool(patch.gameTime, cur.gameTime),
    };
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(next));
    if (patch.token === null) this.db.prepare("DELETE FROM settings WHERE key = ?").run(TOKEN_KEY);
    else if (typeof patch.token === "string" && patch.token.trim()) {
      this.db
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(TOKEN_KEY, this.vault.encrypt(patch.token.trim()));
    }
    this.state = null;
    this.error = null;
    if (this.configured()) await this.sync();
    return this.view();
  }

  configured(): boolean {
    const s = this.settings();
    return !!(s.url && s.homeId && this.token());
  }

  /** Polls Den Duty every minute while the link is set up. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sync().catch(() => {}), SYNC_MS);
    this.timer.unref();
    setTimeout(() => void this.sync().catch(() => {}), 5_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async call<T>(method: "GET" | "POST", path: string): Promise<T> {
    const s = this.settings();
    const res = await this.fetchImpl(`${s.url}/api/v1/homes/${encodeURIComponent(s.homeId)}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token()}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      body: method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) throw new Error("Den Duty refused the token. Make a control token in Den Duty, Settings, Home Assistant and API tokens.");
    if (res.status === 404) throw new Error("Den Duty doesn't know that home, or it's too old for LootDen (update Den Duty).");
    if (!res.ok) throw new Error(`Den Duty answered ${res.status}`);
    return (await res.json()) as T;
  }

  /** One poll: fetch the kids' state, hand out game time, close games a new time-out locks. */
  sync(): Promise<void> {
    if (!this.configured()) {
      this.state = null;
      return Promise.resolve();
    }
    this.syncing ??= this.doSync().finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    try {
      this.state = await this.call<GamingState>("GET", "/gaming");
      this.error = null;
      this.lastSyncAt = new Date().toISOString();
    } catch (err) {
      this.error = (err as Error).message;
      return;
    }
    const s = this.settings();
    for (const [userId, kidId] of Object.entries(s.kids)) {
      const kid = this.state.kids.find((k) => k.id === kidId);
      if (!kid) continue;
      const id = Number(userId);
      if (s.gameTime) await this.handOut(id, kid);
      if (s.locks) this.closeLocked(id, kid);
    }
  }

  /** Game time bought in Den Duty's shop: claimed there first, so it's never given twice. */
  private async handOut(userId: number, kid: GamingKid): Promise<void> {
    for (const g of kid.gameTime) {
      let claim: { already: boolean };
      try {
        claim = await this.call<{ ok: boolean; already: boolean }>("POST", `/gaming/orders/${encodeURIComponent(g.orderId)}/claim`);
      } catch {
        continue;
      }
      if (claim.already) continue;
      try {
        this.family.giveTime(userId, Math.min(600, g.minutes));
      } catch {
        continue;
      }
      for (const np of this.presence.nowPlaying({ id: null, admin: true, kid: false })) {
        if (np.userId === userId) this.presence.send(np.device, "Den Duty", { kind: "message", text: `${g.icon} ${g.minutes} minutes of game time from the Den Duty shop!` });
      }
    }
  }

  /** A time-out that locks all games started while the kid plays: the game gets closed. */
  private closeLocked(userId: number, kid: GamingKid): void {
    for (const lock of kid.locks) {
      for (const np of this.presence.nowPlaying({ id: null, admin: true, kid: false })) {
        if (np.userId !== userId || !np.gameId) continue;
        if (lock.games === "roblox" && np.source !== "roblox") continue;
        const key = `${lock.id}|${np.device}|${np.gameId}`;
        if (this.closedFor.has(key)) continue;
        this.closedFor.add(key);
        try {
          this.presence.send(np.device, "Den Duty", { kind: "close", gameId: np.gameId, text: `Time-out: ${lock.what}.` });
        } catch {
          // The game stopped meanwhile.
        }
      }
    }
  }

  /** What Den Duty says about a profile right now, as play time locks. */
  lockFor(userId: number): DenDutyLock {
    const none: DenDutyLock = { all: null, roblox: null };
    if (!this.state) return none;
    const s = this.settings();
    const kidId = s.kids[String(userId)];
    const kid = kidId ? this.state.kids.find((k) => k.id === kidId) : undefined;
    if (!kid) return none;
    const now = Date.now();
    const live = kid.locks.filter((l) => Date.parse(l.endsAt) > now);
    const all = s.locks ? live.find((l) => l.games === "all") : undefined;
    const roblox = s.locks ? live.find((l) => l.games === "roblox") : undefined;
    const until = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: this.family.timeZone() });
    if (all) return { all: `Time-out: ${all.what}. Games are back ${until(all.endsAt)}.`, roblox: null };
    if (s.choresFirst && kid.chores && kid.chores.left > 0) {
      const n = kid.chores.left;
      return { all: `Chores first! ${n} chore${n === 1 ? "" : "s"} left today in Den Duty, then the games unlock.`, roblox: null };
    }
    return { all: null, roblox: roblox ? `Time-out: ${roblox.what}. Roblox is back ${until(roblox.endsAt)}.` : null };
  }

  /** Family goals reached in Den Duty lately. */
  goalsReached(): GamingState["familyGoalsReached"] {
    return this.state?.familyGoalsReached ?? [];
  }
}
