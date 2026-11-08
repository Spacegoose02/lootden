import { now, type Db } from "../db/database.js";
import type { ConnectorSettings } from "../connectors/settings.js";
import type { FetchLike } from "../metadata/http.js";

export type AlertKind = "released" | "found" | "grabbed" | "imported" | "updates" | "flagged" | "sources" | "requests" | "failed" | "deals" | "test";

/** Extra details some alerts carry, so a chat bot can put buttons on them. */
export interface AlertMeta {
  /** A game request waiting for an answer. */
  request?: { id: number; by: string; title: string; note: string | null };
  /** A kid's ask for more time today. */
  time?: { id: number; by: string; minutes: number; note: string | null };
}

export interface Alert {
  id: number;
  kind: AlertKind;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  read: boolean;
}

/**
 * Alerts for admins: kept for the bell in the web UI, and pushed through an Apprise API server
 * (https://github.com/caronc/apprise-api) to Discord, Telegram, ntfy, email or a phone.
 */
export class Notifier {
  constructor(
    private readonly db: Db,
    private readonly settings: () => ConnectorSettings["notify"],
    private readonly publicUrl: () => string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly log: { warn: (o: object, m: string) => void } = { warn: () => {} },
  ) {}

  /** Called after an alert is recorded. */
  onSent: () => void = () => {};

  /** Called for every alert with whether its kind is switched on (the chat link listens). */
  onAlert: ((a: { kind: AlertKind; title: string; body: string | null; link: string | null; wanted: boolean; meta: AlertMeta }) => void) | null = null;

  /** Records an alert and sends it on when that kind is switched on. Never throws. */
  async send(kind: AlertKind, title: string, body: string | null = null, link: string | null = null, meta: AlertMeta = {}): Promise<void> {
    this.db.prepare("INSERT INTO notifications (kind, title, body, link, created_at) VALUES (?, ?, ?, ?, ?)").run(kind, title, body, link, now());
    this.db.prepare("DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT 200)").run();
    this.onSent();
    const s = this.settings();
    const wanted = kind === "test" || kind === "failed" || (s as unknown as Record<string, boolean>)[kind];
    try {
      this.onAlert?.({ kind, title, body, link, wanted: !!wanted, meta });
    } catch {
      /* a listener never stops the alert */
    }
    if (!s.appriseUrl || !wanted) return;
    await this.apprise(title, body, link).catch((err: Error) => this.log.warn({ err: err.message }, "Apprise notification failed"));
  }

  /** Posts to Apprise: a stateful key (…/notify/<key>) or the stateless endpoint with target URLs. */
  async apprise(title: string, body: string | null, link: string | null): Promise<void> {
    const s = this.settings();
    const base = s.appriseUrl.replace(/\/+$/, "");
    const stateful = /\/notify\/[^/]+$/.test(base);
    const targets = s.appriseTargets.split(/[\s,]+/).filter(Boolean);
    if (!stateful && !targets.length) throw new Error("Add an Apprise config key to the URL (…/notify/lootden) or at least one target URL");
    const full = link ? `${this.publicUrl().replace(/\/+$/, "")}${link}` : "";
    const res = await this.fetchImpl(stateful ? base : `${base}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(stateful ? {} : { urls: targets.join(",") }), title: `LootDen: ${title}`, body: [body, full].filter(Boolean).join("\n") || title, type: "info" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Apprise answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  /** A chat webhook is set, so things can be shared into the family chat. */
  canChat(): boolean {
    return !!this.settings().chatWebhook;
  }

  /**
   * Posts a message into a family chat through its incoming webhook (a Dendrop or Discord
   * webhook). The body is Discord's shape, which Dendrop reads too.
   */
  async chat(text: string): Promise<void> {
    const url = this.settings().chatWebhook;
    if (!url) throw new Error("Add a chat webhook first (Settings, Scanning & alerts)");
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, username: "LootDen" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`The chat webhook answered ${res.status}`);
  }

  list(limit = 50): { alerts: Alert[]; unread: number } {
    const rows = this.db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    const unread = (this.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL").get() as { n: number }).n;
    return {
      unread,
      alerts: rows.map((r) => ({
        id: Number(r.id),
        kind: r.kind as AlertKind,
        title: String(r.title),
        body: (r.body as string | null) ?? null,
        link: (r.link as string | null) ?? null,
        createdAt: String(r.created_at),
        read: r.read_at != null,
      })),
    };
  }

  markRead(): void {
    this.db.prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL").run(now());
  }
}
