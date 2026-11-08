import { json, type Db } from "../db/database.js";
import type { FetchLike } from "../metadata/http.js";
import type { UserRecord } from "../users/repo.js";

const KEY = "chat";
export const CHAT_MASK = "********";

/**
 * The link to Dendrop, the family's self-hosted chat (github.com/Spacegoose02/dendrop).
 * A webhook is enough for one-way posts (Share to chat, alerts); a bot adds buttons people click
 * (approve a request, give more time, install on my PC, I'm in) and Bandit answering in a channel.
 */
export interface ChatSettings {
  enabled: boolean;
  /** Dendrop's address, e.g. https://chat.example.com */
  url: string;
  /** A Dendrop bot's token (Server settings, Bots). */
  botToken: string;
  /** An incoming webhook address (Server settings, Webhooks), used when there's no bot. */
  webhookUrl: string;
  /** Where everyone's posts go: shares, looking for a group, achievements, finished games. */
  familyChannelId: number | null;
  /** Where grown-ups' posts go: requests, more-time asks, alerts. */
  grownupsChannelId: number | null;
  /** Bandit answers questions asked here (the bot needs "reads messages"). */
  helperChannelId: number | null;
  /** The LootDen profile whose Bandit allowance chat answers use. */
  helperUserId: number | null;
  /** Bandit's answers in chat are kid-safe (on unless the channel is grown-ups only). */
  helperKidSafe: boolean;
  post: {
    /** LootDen's alerts (the kinds switched on under Scanning & alerts) go to the grown-ups channel. */
    alerts: boolean;
    requests: boolean;
    timeAsks: boolean;
    achievements: boolean;
    finished: boolean;
    newGames: boolean;
  };
}

const DEFAULTS: ChatSettings = {
  enabled: false,
  url: "",
  botToken: "",
  webhookUrl: "",
  familyChannelId: null,
  grownupsChannelId: null,
  helperChannelId: null,
  helperUserId: null,
  helperKidSafe: true,
  post: { alerts: true, requests: true, timeAsks: true, achievements: true, finished: true, newGames: true },
};

export interface ChatButton {
  id?: string;
  url?: string;
  label: string;
  style?: "primary" | "secondary" | "success" | "danger";
  disabled?: boolean;
}

/** A click on one of the bot's buttons, as Dendrop sends it. */
export interface ChatInteraction {
  id: number;
  messageId: number;
  channelId: number;
  buttonId: string;
  role: string;
  user: { id: number; username: string; displayName: string };
}

/** What a click handler answers: a private reply to the clicker, and a new look for the message. */
export interface ChatAnswer {
  reply?: string;
  update?: { content?: string; buttons?: ChatButton[] };
}

export interface ChatChannel {
  id: number;
  serverId: number;
  serverName: string;
  name: string;
  kind: string;
  conversationId: number;
}

/** Things the link does in LootDen; set by buildApp so this file needs no other services. */
export interface ChatHooks {
  users: () => UserRecord[];
  approveRequest: (id: number) => Promise<string>;
  declineRequest: (id: number) => string;
  decideTime: (id: number, approve: boolean, minutes?: number) => string;
  /** Sends a game to the clicker's PC; answers what happened. */
  installForUser: (user: UserRecord, gameId: string) => string;
  /** Bandit's answer to one question, or a reason he can't. */
  askHelper: (asUserId: number, kidSafe: boolean, question: string, signal: AbortSignal) => Promise<string>;
}

interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

const defaultSocket: SocketFactory = (url, headers) => new (WebSocket as unknown as new (u: string, o: object) => SocketLike)(url, { headers });

const clipText = (s: string, n = 3900) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const idOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** The LootDen profile behind a Dendrop account: same username, else same email-like name. */
export function matchUser(users: UserRecord[], who: { username: string; displayName?: string }): UserRecord | undefined {
  const name = who.username.trim().toLowerCase();
  if (!name) return undefined;
  return (
    users.find((u) => u.username.toLowerCase() === name) ??
    users.find((u) => (u.email ?? "").toLowerCase() === name) ??
    users.find((u) => (u.email ?? "").toLowerCase().split("@")[0] === name)
  );
}

/** A family channel message, as the in-game menu shows it. */
export interface FamilyMessage {
  id: number;
  from: string;
  text: string;
  at: string;
  /** Posted by LootDen's bot (alerts, and lines sent from the in-game menu). */
  mine: boolean;
}

export class ChatLink {
  private socket: SocketLike | null = null;
  private ping: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private failures = 0;
  private botUserId: number | null = null;
  private helperConversation: number | null = null;
  private stopped = true;
  private readonly lfg = new Map<number, { title: string; starter: string; players: string[] }>();
  hooks: ChatHooks | null = null;
  connected = false;
  lastError: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly publicUrl: () => string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly log: { warn: (o: object, m: string) => void } = { warn: () => {} },
    private readonly makeSocket: SocketFactory = defaultSocket,
  ) {}

  settings(): ChatSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    const s = json<Partial<ChatSettings>>(row?.value ?? "{}", {});
    return { ...DEFAULTS, ...s, post: { ...DEFAULTS.post, ...s.post } };
  }

  view() {
    const s = this.settings();
    return {
      ...s,
      botToken: s.botToken ? CHAT_MASK : "",
      webhookUrl: s.webhookUrl ? CHAT_MASK : "",
      hasBot: !!(s.url && s.botToken),
      hasWebhook: !!s.webhookUrl,
      connected: this.connected,
      error: this.lastError,
    };
  }

  /** Whether anything can be posted at all (Share to chat shows only then). */
  ready(): boolean {
    const s = this.settings();
    return s.enabled && (!!(s.url && s.botToken && s.familyChannelId) || !!s.webhookUrl);
  }

  async save(patch: Partial<ChatSettings>): Promise<ReturnType<ChatLink["view"]>> {
    const cur = this.settings();
    const str = (v: unknown, keep: string, max = 500) => (v === undefined ? keep : String(v).trim().slice(0, max));
    const secret = (v: unknown, keep: string) => (v === undefined || v === CHAT_MASK ? keep : String(v).trim().slice(0, 500));
    const url = str(patch.url, cur.url).replace(/\/+$/, "");
    if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new Error("Dendrop's address looks like https://chat.example.com");
    const webhookUrl = secret(patch.webhookUrl, cur.webhookUrl);
    if (webhookUrl && !/^https?:\/\/[^\s]+\/api\/hooks\/\d+\/\S+$/i.test(webhookUrl)) throw new Error("A Dendrop webhook address looks like https://chat.example.com/api/hooks/3/…");
    const pick = <K extends keyof ChatSettings["post"]>(k: K) => (patch.post?.[k] === undefined ? cur.post[k] : !!patch.post[k]);
    const next: ChatSettings = {
      enabled: patch.enabled === undefined ? cur.enabled : !!patch.enabled,
      url,
      botToken: secret(patch.botToken, cur.botToken),
      webhookUrl,
      familyChannelId: patch.familyChannelId === undefined ? cur.familyChannelId : idOrNull(patch.familyChannelId),
      grownupsChannelId: patch.grownupsChannelId === undefined ? cur.grownupsChannelId : idOrNull(patch.grownupsChannelId),
      helperChannelId: patch.helperChannelId === undefined ? cur.helperChannelId : idOrNull(patch.helperChannelId),
      helperUserId: patch.helperUserId === undefined ? cur.helperUserId : idOrNull(patch.helperUserId),
      helperKidSafe: patch.helperKidSafe === undefined ? cur.helperKidSafe : !!patch.helperKidSafe,
      post: { alerts: pick("alerts"), requests: pick("requests"), timeAsks: pick("timeAsks"), achievements: pick("achievements"), finished: pick("finished"), newGames: pick("newGames") },
    };
    if (next.enabled && !next.webhookUrl && !(next.url && next.botToken)) throw new Error("Add a webhook address, or Dendrop's address and a bot token");
    if (next.botToken && !next.url) throw new Error("Add Dendrop's address for the bot");
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(next));
    await this.restart();
    return this.view();
  }

  // ---- Bot API ---------------------------------------------------------------------------

  private hasBot(s = this.settings()): boolean {
    return s.enabled && !!s.url && !!s.botToken;
  }

  private async bot<T>(method: string, path: string, body?: unknown): Promise<T> {
    const s = this.settings();
    const res = await this.fetchImpl(`${s.url}/api/bot/v1${path}`, {
      method,
      headers: { authorization: `Bot ${s.botToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text.slice(0, 200);
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? msg;
      } catch {
        /* plain text */
      }
      throw new Error(res.status === 401 ? "Dendrop doesn't accept the bot token (make a new one under Server settings, Bots)" : `Dendrop answered ${res.status}: ${msg}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** The text channels the bot can post in, for the settings page. */
  async channels(): Promise<ChatChannel[]> {
    if (!this.hasBot()) throw new Error("Link a Dendrop bot first");
    const servers = await this.bot<Array<{ id: number; name: string; channels?: Array<{ id: number; serverId?: number; kind: string; name: string; conversationId: number }> }>>("GET", "/servers");
    return servers.flatMap((sv) =>
      (sv.channels ?? []).filter((c) => c.kind === "text").map((c) => ({ id: c.id, serverId: sv.id, serverName: sv.name, name: c.name, kind: c.kind, conversationId: c.conversationId })),
    );
  }

  /**
   * The family channel's last messages, for the in-game menu. Needs the bot to read messages
   * (Dendrop, Server settings, Bots). Encrypted and deleted messages are left out.
   */
  async familyMessages(limit = 15): Promise<FamilyMessage[]> {
    const s = this.settings();
    if (!s.enabled || !this.hasBot(s) || !s.familyChannelId) throw new Error("The family chat isn't linked");
    const list = await this.bot<Array<{ id: number; authorId: number; body: string; createdAt: string; deleted?: boolean; keyVersion?: number | null; webhook?: { name: string } | null; author?: { displayName?: string; username?: string } | null }>>(
      "GET",
      `/channels/${s.familyChannelId}/messages?limit=${Math.min(50, Math.max(1, limit))}`,
    );
    return (Array.isArray(list) ? list : [])
      .filter((m) => !m.deleted && m.keyVersion == null && String(m.body ?? "").trim())
      .map((m) => ({
        id: m.id,
        from: m.webhook?.name ?? (m.authorId === this.botUserId ? "LootDen" : (m.author?.displayName || m.author?.username || "Someone")),
        text: String(m.body).slice(0, 500),
        at: m.createdAt,
        mine: m.authorId === this.botUserId,
      }));
  }

  /** A line from the in-game menu, posted by the bot under the player's name. */
  async sayInFamily(by: string, text: string): Promise<void> {
    const s = this.settings();
    const t = text.trim().slice(0, 500);
    if (!t) throw new Error("Write something first");
    if (!s.enabled || !this.hasBot(s) || !s.familyChannelId) throw new Error("The family chat isn't linked");
    await this.postTo(s.familyChannelId, `🎮 ${by}: ${t}`);
  }

  /** Posts in a channel through the bot. Answers the new message's id. */
  async postTo(channelId: number, content: string, buttons?: ChatButton[]): Promise<number | null> {
    const m = await this.bot<{ id: number }>("POST", `/channels/${channelId}/messages`, { content: clipText(content), ...(buttons?.length ? { buttons } : {}) });
    return m?.id ?? null;
  }

  private async webhook(content: string): Promise<void> {
    const s = this.settings();
    const res = await this.fetchImpl(s.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: clipText(content), username: "LootDen" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(res.status === 404 ? "Dendrop doesn't know that webhook address any more" : `Dendrop answered ${res.status}`);
  }

  /**
   * Posts to the family (or grown-ups) channel: through the bot when there is one (with buttons),
   * else the webhook (text only). Never throws; answers whether it was posted.
   */
  async post(where: "family" | "grownups", content: string, buttons?: ChatButton[]): Promise<{ ok: boolean; messageId: number | null; error?: string }> {
    const s = this.settings();
    if (!s.enabled) return { ok: false, messageId: null, error: "Chat isn't linked" };
    const channel = where === "family" ? s.familyChannelId : (s.grownupsChannelId ?? s.familyChannelId);
    try {
      if (this.hasBot(s) && channel) return { ok: true, messageId: await this.postTo(channel, content, buttons) };
      if (s.webhookUrl && (where === "family" || !s.grownupsChannelId)) {
        const links = (buttons ?? []).filter((b) => b.url).map((b) => `${b.label}: ${b.url}`);
        await this.webhook([content, ...links].join("\n"));
        return { ok: true, messageId: null };
      }
      return { ok: false, messageId: null, error: "Pick a channel for this under Settings, Chat" };
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "Posting to Dendrop failed");
      return { ok: false, messageId: null, error: (err as Error).message };
    }
  }

  gameLink(gameId: string): string {
    return `${this.publicUrl().replace(/\/+$/, "")}/games/${encodeURIComponent(gameId)}`;
  }

  // ---- What LootDen posts ----------------------------------------------------------------

  /** Share to chat: a game (Surprise us, a game's page). Dendrop turns the link into a card. */
  async share(by: string, game: { id: string; title: string }, note: string | null): Promise<{ ok: boolean; error?: string }> {
    const line = note?.trim() ? `${by}: ${note.trim().slice(0, 300)}` : `${by} shared ${game.title}`;
    const r = await this.post("family", `${line}\n${this.gameLink(game.id)}`, this.hasBot() ? [{ id: `install:${game.id}`, label: "Install on my PC", style: "primary" }] : undefined);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** Looking for a group: "Who wants to play X?" with an I'm in button. Grown-up games go to the grown-ups channel. */
  async lookingForGroup(by: string, game: { id: string; title: string; kidSafe: boolean | null }, installedOn: string[], note: string | null): Promise<{ ok: boolean; error?: string }> {
    const where = game.kidSafe === true ? "family" : "grownups";
    const lines = [`🎮 ${by} wants to play **${game.title}**! Who's in?`];
    if (note?.trim()) lines.push(note.trim().slice(0, 300));
    if (installedOn.length) lines.push(`Installed on: ${installedOn.join(", ")}`);
    lines.push(this.gameLink(game.id));
    const r = await this.post(where, lines.join("\n"), this.hasBot() ? [{ id: `lfg:join`, label: "I'm in", style: "success" }, { id: `install:${game.id}`, label: "Install on my PC" }] : undefined);
    if (r.ok && r.messageId) this.lfg.set(r.messageId, { title: game.title, starter: by, players: [by] });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** A request someone made, with Approve and Decline. */
  async requestMade(id: number, by: string, title: string, note: string | null): Promise<void> {
    if (!this.settings().post.requests) return;
    const text = [`📬 ${by} asked for **${title}**`, note].filter(Boolean).join("\n");
    await this.post("grownups", text, [
      { id: `req:approve:${id}`, label: "Approve", style: "success" },
      { id: `req:decline:${id}`, label: "Decline", style: "danger" },
      { url: `${this.publicUrl().replace(/\/+$/, "")}/requests`, label: "Open requests" },
    ]);
  }

  /** A kid asked for more time, with +15, +30, the asked minutes and No. */
  async timeAsked(id: number, by: string, minutes: number, note: string | null): Promise<void> {
    if (!this.settings().post.timeAsks) return;
    const options = [...new Set([15, 30, minutes])].sort((a, b) => a - b).slice(0, 3);
    await this.post("grownups", [`⏰ ${by} asked for ${minutes} more minutes`, note ? `"${note}"` : null].filter(Boolean).join("\n"), [
      ...options.map((m) => ({ id: `time:yes:${id}:${m}`, label: `+${m} min`, style: (m === minutes ? "success" : "secondary") as ChatButton["style"] })),
      { id: `time:no:${id}`, label: "Not now", style: "danger" },
    ]);
  }

  /** An alert from the bell, for the grown-ups channel. Requests and time asks have their own posts. */
  async alert(title: string, body: string | null, link: string | null): Promise<void> {
    if (!this.settings().post.alerts) return;
    const full = link ? `${this.publicUrl().replace(/\/+$/, "")}${link}` : null;
    await this.post("grownups", [`🔔 ${title}`, body, full].filter(Boolean).join("\n"));
  }

  async newGame(game: { id: string; title: string; kidSafe: boolean | null }): Promise<void> {
    if (!this.settings().post.newGames) return;
    await this.post(game.kidSafe === true ? "family" : "grownups", `🆕 **${game.title}** is in the library\n${this.gameLink(game.id)}`, this.hasBot() ? [{ id: `install:${game.id}`, label: "Install on my PC", style: "primary" }] : undefined);
  }

  /** Rare achievements (10% of players or fewer) someone just unlocked. */
  async achievements(by: string, kid: boolean, game: string, items: Array<{ name: string; rarity: number | null }>, gameKidSafe: boolean): Promise<void> {
    if (!this.settings().post.achievements || !items.length) return;
    const list = items
      .slice(0, 5)
      .map((a) => `🏆 ${a.name}${a.rarity != null ? ` (${a.rarity}% of players)` : ""}`)
      .join("\n");
    await this.post(gameKidSafe || kid ? "family" : "grownups", `${by} unlocked in **${game}**:\n${list}`);
  }

  async finished(by: string, game: { id: string; title: string; kidSafe: boolean | null }, status: "done" | "completed"): Promise<void> {
    if (!this.settings().post.finished) return;
    const what = status === "completed" ? "100% completed" : "finished";
    await this.post(game.kidSafe === true ? "family" : "grownups", `🎉 ${by} ${what} **${game.title}**!\n${this.gameLink(game.id)}`);
  }

  // ---- Clicks and messages ---------------------------------------------------------------

  /** What a click does. Exported for tests through handleClick. */
  async handleClick(i: ChatInteraction): Promise<ChatAnswer> {
    const hooks = this.hooks;
    if (!hooks) return { reply: "LootDen isn't ready yet" };
    const me = matchUser(hooks.users(), i.user);
    const grownUp = me ? me.role === "admin" : i.role === "owner" || i.role === "admin";
    const [kind, action, idText, extra] = i.buttonId.split(":");
    const id = Number(idText);
    try {
      if (kind === "req") {
        if (!grownUp) return { reply: "Only LootDen admins can answer requests" };
        const title = action === "approve" ? await hooks.approveRequest(id) : hooks.declineRequest(id);
        return { update: { content: `${action === "approve" ? "✅" : "❌"} ${title}: ${action === "approve" ? "approved" : "declined"} by ${i.user.displayName}`, buttons: [] } };
      }
      if (kind === "time") {
        if (!grownUp) return { reply: "Only grown-ups can give more time" };
        const minutes = action === "yes" ? Number(extra) : undefined;
        const who = hooks.decideTime(id, action === "yes", minutes);
        return { update: { content: action === "yes" ? `✅ ${who} got ${minutes} more minutes from ${i.user.displayName}` : `❌ ${i.user.displayName} said not now to ${who}`, buttons: [] } };
      }
      if (kind === "install") {
        if (!me) return { reply: "Your Dendrop name doesn't match a LootDen profile, so LootDen doesn't know your PC" };
        return { reply: hooks.installForUser(me, [action, idText, extra].filter((p) => p !== undefined).join(":")) };
      }
      if (kind === "lfg" && action === "join") {
        const g = this.lfg.get(i.messageId);
        if (!g) return { reply: "That invite is too old; ask them to post a new one" };
        if (g.players.includes(i.user.displayName)) return { reply: "You're already in!" };
        g.players.push(i.user.displayName);
        return { reply: `You're in for ${g.title}!`, update: { content: `🎮 ${g.starter} wants to play **${g.title}**!\nIn: ${g.players.join(", ")}` } };
      }
      return { reply: "LootDen doesn't know that button" };
    } catch (err) {
      return { reply: (err as Error).message };
    }
  }

  /** A message in Bandit's channel: answer it there. */
  async handleMessage(m: { id: number; conversationId: number; authorId: number; body: string; keyVersion?: number | null; webhook?: unknown }): Promise<void> {
    const s = this.settings();
    if (!this.hooks || !s.helperChannelId || !this.helperConversation || m.conversationId !== this.helperConversation) return;
    if (m.authorId === this.botUserId || m.webhook || m.keyVersion != null) return;
    const question = String(m.body ?? "").trim();
    if (!question) return;
    if (!s.helperUserId) {
      await this.postTo(s.helperChannelId, "Bandit needs a LootDen profile to answer as: pick one under Settings, Chat.").catch(() => null);
      return;
    }
    let answer: string;
    try {
      answer = await this.hooks.askHelper(s.helperUserId, s.helperKidSafe, question.slice(0, 2000), AbortSignal.timeout(120_000));
    } catch (err) {
      answer = (err as Error).message;
    }
    await this.postTo(s.helperChannelId, `🦝 ${answer}`).catch((err: Error) => this.log.warn({ err: err.message }, "Bandit's chat answer failed"));
  }

  private async onEvent(raw: unknown): Promise<void> {
    let e: { type?: string; interaction?: ChatInteraction; message?: Parameters<ChatLink["handleMessage"]>[0] };
    try {
      e = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (e.type === "interaction.created" && e.interaction) {
      const i = e.interaction;
      const a = await this.handleClick(i);
      if (a.update) await this.bot("PATCH", `/messages/${i.messageId}`, a.update).catch((err: Error) => this.log.warn({ err: err.message }, "Updating a Dendrop message failed"));
      if (a.reply) await this.bot("POST", `/interactions/${i.id}/reply`, { content: a.reply }).catch(() => null);
    } else if (e.type === "message.created" && e.message) {
      await this.handleMessage(e.message);
    }
  }

  // ---- Gateway ---------------------------------------------------------------------------

  async restart(): Promise<void> {
    this.stop();
    this.failures = 0;
    this.lastError = null;
    if (!this.hasBot()) return;
    this.stopped = false;
    await this.connect().catch(() => {});
  }

  stop(): void {
    this.stopped = true;
    if (this.ping) clearInterval(this.ping);
    if (this.retry) clearTimeout(this.retry);
    this.ping = this.retry = null;
    const s = this.socket;
    this.socket = null;
    this.connected = false;
    try {
      s?.close();
    } catch {
      /* already closed */
    }
  }

  private async connect(): Promise<void> {
    const s = this.settings();
    try {
      const me = await this.bot<{ id: number }>("GET", "/me");
      this.botUserId = me.id;
      this.helperConversation = s.helperChannelId ? ((await this.channels()).find((c) => c.id === s.helperChannelId)?.conversationId ?? null) : null;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.reconnectSoon();
      throw err;
    }
    const ws = this.makeSocket(`${s.url.replace(/^http/i, "ws")}/api/bot/v1/gateway`, { authorization: `Bot ${s.botToken}` });
    this.socket = ws;
    ws.onopen = () => {
      this.connected = true;
      this.failures = 0;
      this.lastError = null;
    };
    ws.onmessage = (ev) => void this.onEvent(ev.data).catch((err: Error) => this.log.warn({ err: err.message }, "Dendrop event failed"));
    ws.onerror = () => {
      this.lastError = "Couldn't reach Dendrop's bot gateway";
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.connected = false;
      this.reconnectSoon();
    };
    this.ping = setInterval(() => {
      try {
        this.socket?.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* reconnects on close */
      }
    }, 25_000);
    this.ping.unref();
  }

  private reconnectSoon(): void {
    if (this.stopped || this.retry) return;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    const wait = Math.min(300_000, 5_000 * 2 ** this.failures++);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect().catch(() => {});
    }, wait);
    this.retry.unref();
  }

  /** Sends a test post to each channel that's set. */
  async test(): Promise<string[]> {
    const s = this.settings();
    const out: string[] = [];
    const a = await this.post("family", "👋 LootDen is linked to this channel.");
    if (!a.ok) throw new Error(a.error ?? "Couldn't post");
    out.push("family");
    if (this.hasBot(s) && s.grownupsChannelId && s.grownupsChannelId !== s.familyChannelId) {
      const b = await this.post("grownups", "👋 LootDen's grown-up posts (requests, more time, alerts) come here.");
      if (!b.ok) throw new Error(b.error ?? "Couldn't post");
      out.push("grownups");
    }
    return out;
  }
}
