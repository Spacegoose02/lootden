import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_HELPER_DAILY_LIMIT,
  DEFAULT_HELPER_KID_DAILY_LIMIT,
  DEFAULT_HELPER_MODEL,
  HELPER_ANSWER_LENGTHS,
  HELPER_EFFORTS,
  HELPER_MAX_MESSAGE,
  HELPER_MAX_TURNS,
  HELPER_MODELS,
  HELPER_NAME,
  helperAllowed,
  helperCost,
  type HelperAccess,
  type HelperChatMessage,
  type HelperEffort,
  type HelperSettings,
  type HelperSettingsView,
  type HelperStatus,
  type HelperTokens,
  type HelperUsageReport,
  type User,
} from "@lootden/shared";
import type { Vault } from "../auth/vault.js";
import { json, now, type Db } from "../db/database.js";

/** What the AI is asked: the system prompt split into its fixed part and this chat's part, and the chat so far. */
export interface HelperPrompt {
  apiKey: string;
  model: string;
  effort: HelperEffort;
  maxTokens: number;
  system: string;
  context: string;
  messages: HelperChatMessage[];
  /** An opaque id for the person, so the provider can spot abuse without knowing who it is. */
  userRef: string;
}

/** Pieces of the answer's text, then once at the end what it used (the model that answered and its tokens). */
export type HelperPiece = { text: string } | { usage: HelperTokens; model: string };

/** Streams the answer. Swapped out in tests so they never call the real API. */
export type HelperAi = (prompt: HelperPrompt, signal: AbortSignal) => AsyncIterable<HelperPiece>;

/** The game the person is looking at, as Bandit is told about it. */
export interface HelperGameContext {
  title: string;
  platform?: string | null;
  genres?: string[];
  releaseYear?: number | null;
  summary?: string | null;
  store?: string | null;
}

const KEY = "helper";
const MASK = "********";

/** Same for everyone, so it's cached by the provider between messages. */
const BASE_PROMPT = `You are ${HELPER_NAME}, the gaming helper inside LootDen, a family's self-hosted game library. You're a friendly raccoon with a gaming headset: upbeat, playful, and genuinely useful.

What you help with:
- Getting unstuck: puzzles, bosses, quests, builds, where to go next.
- Tips, strategies, controls and settings (including handhelds like the Steam Deck and ROG Ally, and controllers).
- Choosing what to play, and explaining what a game is about.
- Fixing common PC game problems (performance, crashes, controller not working) in plain steps.

How you answer:
- Keep it short and easy to scan: a sentence or two, or a few bullet points. Many people read you on a TV or handheld with a controller.
- Avoid spoilers. If an answer would spoil the story, say so and give a gentle hint first; only spoil if they clearly ask.
- If you're not sure about details for a specific game (exact item locations, patch changes), say so instead of guessing.
- Stay on games and gaming. For anything else, steer back to games kindly.
- Never ask for passwords, addresses or other personal details, and never help with cheating in online multiplayer, piracy, or getting around parental controls or play time limits.`;

const KID_PROMPT = `This player is a child using a kid profile. Be extra kind, encouraging and simple:
- Use short sentences and easy words. A fun emoji now and then is fine.
- Keep everything suitable for young children: no violence details, scary content, swearing, romance, or mature games. If they ask about a game that isn't for kids, suggest asking a grown-up and offer a kid-friendly game instead.
- Never suggest chatting with strangers online, buying things, or sharing personal information. Don't link to websites.
- If they seem upset, sad or unsafe, be warm and tell them to talk to a grown-up they trust.
- Only talk about games and play. If they ask about other things, cheerfully bring it back to games.`;

/** Anthropic's API through the official SDK, streaming the answer's text. */
export const anthropicAi: HelperAi = async function* (p, signal) {
  const client = new Anthropic({ apiKey: p.apiKey, maxRetries: 2 });
  const stream = client.beta.messages.stream(
    {
      model: p.model,
      max_tokens: p.maxTokens,
      output_config: { effort: p.effort },
      // When a model declines, the API tries its recommended fallback model instead of just refusing.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // The fixed prompt and the chat so far are cached, so follow-up questions cost less.
      cache_control: { type: "ephemeral" },
      system: [
        { type: "text", text: p.system },
        { type: "text", text: p.context },
      ],
      messages: p.messages.map((m) => ({ role: m.role, content: m.content })),
      metadata: { user_id: p.userRef },
    },
    { signal },
  );
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield { text: event.delta.text };
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") yield { text: "\n\nSorry, I can't help with that one. Ask me something else about your games!" };
  else if (final.stop_reason === "max_tokens") yield { text: "…" };
  const u = final.usage;
  yield {
    model: final.model,
    usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
  };
};

/** A problem to show the person as it is. */
export class HelperProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const wholeNumber = (v: unknown, max: number, what: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new HelperProblem(400, `${what} is a whole number from 0 (no limit) to ${max}`);
  return n;
};

/** Server settings, who may use Bandit, limits and budgets, usage, and building the prompt. */
export class HelperService {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly envKey: string,
    /** Today's date (YYYY-MM-DD) in the household's time zone, for daily limits and the month's budget. */
    private readonly today: () => string = () => now().slice(0, 10),
    private readonly ai: HelperAi = anthropicAi,
  ) {}

  private stored(): HelperSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    const s = json<Partial<HelperSettings>>(row?.value, {});
    const count = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : d);
    return {
      enabled: s.enabled ?? true,
      provider: "anthropic",
      apiKey: s.apiKey ?? "",
      model: HELPER_MODELS.some((m) => m.id === s.model) ? s.model! : DEFAULT_HELPER_MODEL,
      effort: HELPER_EFFORTS.includes(s.effort!) ? s.effort! : "low",
      answerLength: s.answerLength && s.answerLength in HELPER_ANSWER_LENGTHS ? s.answerLength : "medium",
      dailyLimit: count(s.dailyLimit, DEFAULT_HELPER_DAILY_LIMIT),
      kidDailyLimit: count(s.kidDailyLimit, DEFAULT_HELPER_KID_DAILY_LIMIT),
      monthlyBudget: typeof s.monthlyBudget === "number" && s.monthlyBudget >= 0 ? s.monthlyBudget : 0,
    };
  }

  /** The key to use: one saved in Settings, else the environment's. */
  private apiKey(): string {
    const saved = this.stored().apiKey;
    if (saved) {
      try {
        return this.vault.decrypt(saved);
      } catch {
        return "";
      }
    }
    return this.envKey;
  }

  configured(): boolean {
    return this.stored().enabled && !!this.apiKey();
  }

  private month(): string {
    return this.today().slice(0, 7);
  }

  /** Estimated US dollars spent this month. */
  spentThisMonth(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM helper_usage WHERE day LIKE ?").get(`${this.month()}-%`) as { c: number };
    return row.c;
  }

  paused(): boolean {
    const budget = this.stored().monthlyBudget;
    return budget > 0 && this.spentThisMonth() >= budget;
  }

  view(): HelperSettingsView {
    const s = this.stored();
    return {
      settings: { ...s, apiKey: s.apiKey ? MASK : "" },
      keyFromEnvironment: !s.apiKey && !!this.envKey,
      ready: this.configured(),
      paused: this.paused(),
    };
  }

  /** Saves an admin's changes. The masked key leaves the saved one as it is; an empty one clears it. */
  save(patch: Partial<HelperSettings>): HelperSettingsView {
    const next: HelperSettings = { ...this.stored() };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (patch.model !== undefined) {
      if (!HELPER_MODELS.some((m) => m.id === patch.model)) throw new HelperProblem(400, "Pick one of the listed models");
      next.model = patch.model;
    }
    if (patch.effort !== undefined) {
      if (!HELPER_EFFORTS.includes(patch.effort)) throw new HelperProblem(400, "Thinking is low, medium or high");
      next.effort = patch.effort;
    }
    if (patch.answerLength !== undefined) {
      if (!(patch.answerLength in HELPER_ANSWER_LENGTHS)) throw new HelperProblem(400, "Answer length is short, medium or long");
      next.answerLength = patch.answerLength;
    }
    if (patch.dailyLimit !== undefined) next.dailyLimit = wholeNumber(patch.dailyLimit, 10_000, "The daily limit");
    if (patch.kidDailyLimit !== undefined) next.kidDailyLimit = wholeNumber(patch.kidDailyLimit, 10_000, "The kids' daily limit");
    if (patch.monthlyBudget !== undefined) {
      const b = Number(patch.monthlyBudget);
      if (!Number.isFinite(b) || b < 0 || b > 100_000) throw new HelperProblem(400, "The monthly budget is an amount in dollars, 0 for no budget");
      next.monthlyBudget = Math.round(b * 100) / 100;
    }
    if (typeof patch.apiKey === "string" && patch.apiKey !== MASK) {
      const key = patch.apiKey.trim();
      if (key && !/^[\w-]{20,300}$/.test(key)) throw new HelperProblem(400, "That doesn't look like an API key");
      next.apiKey = key ? this.vault.encrypt(key) : "";
    }
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(next));
    return this.view();
  }

  private accessRow(userId: number): { allowed: number | null; enabled: number; daily_limit: number | null } | undefined {
    return this.db.prepare("SELECT allowed, enabled, daily_limit FROM helper_access WHERE user_id = ?").get(userId) as
      | { allowed: number | null; enabled: number; daily_limit: number | null }
      | undefined;
  }

  access(user: User): HelperAccess {
    const row = this.accessRow(user.id);
    const set = row?.allowed == null ? null : row.allowed === 1;
    return { allowed: helperAllowed(set, user.kidMode), isDefault: set === null, dailyLimit: row?.daily_limit ?? null };
  }

  /** A parent's switch (null: back to the default) and the person's own daily limit (null: the server's). */
  setAccess(user: User, patch: { allowed?: boolean | null; dailyLimit?: number | null }): HelperAccess {
    this.db.prepare("INSERT INTO helper_access (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING").run(user.id);
    if (patch.allowed !== undefined) this.db.prepare("UPDATE helper_access SET allowed = ? WHERE user_id = ?").run(patch.allowed === null ? null : patch.allowed ? 1 : 0, user.id);
    if (patch.dailyLimit !== undefined)
      this.db.prepare("UPDATE helper_access SET daily_limit = ? WHERE user_id = ?").run(patch.dailyLimit === null ? null : wholeNumber(patch.dailyLimit, 10_000, "The daily limit"), user.id);
    return this.access(user);
  }

  /** The person's own on/off switch. */
  setEnabled(user: User, enabled: boolean): HelperStatus {
    this.db.prepare("INSERT INTO helper_access (user_id, enabled) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled").run(user.id, enabled ? 1 : 0);
    return this.status(user);
  }

  /** Messages a day for this person: their own limit, else the server's for kids or grown-ups. 0 is no limit. */
  dailyLimit(user: User): number {
    const own = this.accessRow(user.id)?.daily_limit;
    if (own != null) return own;
    const s = this.stored();
    return user.kidMode ? s.kidDailyLimit : s.dailyLimit;
  }

  private usedToday(userId: number): number {
    const row = this.db.prepare("SELECT count FROM helper_usage WHERE user_id = ? AND day = ?").get(userId, this.today()) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  status(user: User): HelperStatus {
    const configured = this.configured();
    const { allowed } = this.access(user);
    const enabled = (this.accessRow(user.id)?.enabled ?? 1) === 1;
    const limit = this.dailyLimit(user);
    return {
      configured,
      allowed,
      enabled,
      available: configured && allowed && enabled,
      kid: user.kidMode,
      remaining: limit ? Math.max(0, limit - this.usedToday(user.id)) : null,
      paused: configured && this.paused(),
    };
  }

  /** A question that got no answer (the provider failed) doesn't count toward the daily limit. */
  refund(userId: number): void {
    this.db.prepare("UPDATE helper_usage SET count = MAX(0, count - 1) WHERE user_id = ? AND day = ?").run(userId, this.today());
  }

  /** Adds what one answer used to today's tally. */
  record(userId: number, model: string, tokens: HelperTokens): void {
    const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    this.db
      .prepare(
        "UPDATE helper_usage SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost = cost + ? WHERE user_id = ? AND day = ?",
      )
      .run(input, tokens.output, helperCost(model, tokens), userId, this.today());
  }

  /** This month: spend against the budget, per person and per day. */
  usage(users: User[]): HelperUsageReport {
    const month = this.month();
    const today = this.today();
    const rows = this.db.prepare("SELECT user_id, day, count, input_tokens, output_tokens, cost FROM helper_usage WHERE day LIKE ?").all(`${month}-%`) as Array<{
      user_id: number;
      day: string;
      count: number;
      input_tokens: number;
      output_tokens: number;
      cost: number;
    }>;
    const days = new Map<string, { day: string; messages: number; cost: number }>();
    const people = users.map((u) => {
      const own = rows.filter((r) => r.user_id === u.id);
      const sum = (k: "count" | "input_tokens" | "output_tokens" | "cost") => own.reduce((a, r) => a + r[k], 0);
      const access = this.access(u);
      return {
        userId: u.id,
        name: u.displayName,
        avatar: u.avatar,
        kid: u.kidMode,
        allowed: access.allowed,
        isDefault: access.isDefault,
        dailyLimit: access.dailyLimit,
        effectiveLimit: this.dailyLimit(u),
        today: own.find((r) => r.day === today)?.count ?? 0,
        messages: sum("count"),
        inputTokens: sum("input_tokens"),
        outputTokens: sum("output_tokens"),
        cost: sum("cost"),
      };
    });
    for (const r of rows) {
      const d = days.get(r.day) ?? { day: r.day, messages: 0, cost: 0 };
      d.messages += r.count;
      d.cost += r.cost;
      days.set(r.day, d);
    }
    const spent = rows.reduce((a, r) => a + r.cost, 0);
    const budget = this.stored().monthlyBudget;
    return {
      month,
      spent,
      budget,
      paused: budget > 0 && spent >= budget,
      messages: rows.reduce((a, r) => a + r.count, 0),
      people,
      days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    };
  }

  /**
   * Bandit's answer to the latest message, as text. Checks the person may use him, has messages
   * left today, and the month's budget isn't used up, before anything is sent to the provider.
   * What the answer used is added to the person's tally when it finishes.
   */
  async chat(user: User, history: unknown, game: HelperGameContext | null, signal: AbortSignal): Promise<AsyncIterable<string>> {
    const st = this.status(user);
    if (!st.configured) throw new HelperProblem(503, `${HELPER_NAME} isn't set up on this server yet. An admin can add an AI key in Settings.`);
    if (!st.allowed) throw new HelperProblem(403, user.kidMode ? `Ask a grown-up to switch ${HELPER_NAME} on for you.` : `An admin has switched ${HELPER_NAME} off for you.`);
    if (!st.enabled) throw new HelperProblem(403, `${HELPER_NAME} is switched off. Turn him on in your Profile.`);
    if (st.paused) throw new HelperProblem(429, `${HELPER_NAME} is resting until next month (this month's AI budget is used up).`);
    if (st.remaining === 0) throw new HelperProblem(429, `That's all of today's questions. ${HELPER_NAME} will be back tomorrow!`);
    const messages = cleanHistory(history);
    const s = this.stored();
    this.db
      .prepare("INSERT INTO helper_usage (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1")
      .run(user.id, this.today());
    const pieces = this.ai(
      {
        apiKey: this.apiKey(),
        model: s.model,
        effort: s.effort,
        maxTokens: HELPER_ANSWER_LENGTHS[s.answerLength],
        system: BASE_PROMPT,
        context: contextPrompt(user, game),
        messages,
        userRef: `lootden-${user.id}`,
      },
      signal,
    );
    const record = (model: string, usage: HelperTokens) => this.record(user.id, model, usage);
    return (async function* () {
      for await (const p of pieces) {
        if ("text" in p) yield p.text;
        else record(p.model, p.usage);
      }
    })();
  }
}

/** The chat as the browser sent it, checked: alternating turns ending with the person's, trimmed to the last few. */
export function cleanHistory(raw: unknown): HelperChatMessage[] {
  if (!Array.isArray(raw)) throw new HelperProblem(400, "Send the chat as a list of messages");
  const out: HelperChatMessage[] = [];
  for (const m of raw as Array<Partial<HelperChatMessage>>) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") throw new HelperProblem(400, "Each message needs a role (user or assistant) and text");
    if (m.role === "user" && m.content.length > HELPER_MAX_MESSAGE) throw new HelperProblem(400, "That message is too long");
    // Bandit's own answers come back from the browser, so they're capped too.
    const content = m.content.trim().slice(0, HELPER_MAX_MESSAGE * 4);
    if (!content) continue;
    // Two in a row from the same side are joined, as the API wants turns to alternate.
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${content}`;
    else out.push({ role: m.role, content });
  }
  const last = out[out.length - 1];
  if (!last || last.role !== "user") throw new HelperProblem(400, "Ask something first");
  let recent = out.slice(-HELPER_MAX_TURNS);
  while (recent.length && recent[0]!.role !== "user") recent = recent.slice(1);
  return recent;
}

/** The part of the prompt that changes: who's asking and what game they're on. */
export function contextPrompt(user: User, game: HelperGameContext | null): string {
  const lines: string[] = [];
  if (user.kidMode) lines.push(KID_PROMPT);
  lines.push(`You're talking with ${user.displayName.slice(0, 40)}${user.kidMode ? " (a kid)" : ""}.`);
  if (game) {
    const facts = [
      `Title: ${game.title}`,
      game.store ? `From their ${game.store} library` : null,
      game.platform && game.platform !== "pc" ? `Platform: ${game.platform} (played with an emulator)` : game.platform === "pc" ? "Platform: PC" : null,
      game.releaseYear ? `Released: ${game.releaseYear}` : null,
      game.genres?.length ? `Genres: ${game.genres.slice(0, 6).join(", ")}` : null,
      game.summary ? `About: ${game.summary.slice(0, 800)}` : null,
    ].filter(Boolean);
    lines.push(`They're looking at this game in LootDen, so questions are probably about it:\n${facts.join("\n")}`);
  } else lines.push("They aren't on a game's page right now; if they don't say which game they mean, ask.");
  return lines.join("\n\n");
}
