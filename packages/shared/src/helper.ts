/**
 * Bandit, LootDen's AI gaming helper: a chat that helps with the game you're playing or looking
 * at. An admin sets up the AI provider on the server; each person can switch Bandit off, and kid
 * profiles only get him once a grown-up switches him on for them.
 */

export const HELPER_NAME = "Bandit";

/** Bandit's raccoon (a built avatar seed): Neon fur, Laser grid, gaming headset. */
export const HELPER_AVATAR = "b-11-9-0-3-3";
/** The same raccoon while he's thinking (curious eyes). */
export const HELPER_AVATAR_THINKING = "b-11-9-5-3-3";

/**
 * Models an admin can pick from, with Anthropic's prices in US dollars per million tokens
 * (input, output, cache reads, cache writes). The first is the default. Costs shown in LootDen
 * are estimates from these and the token counts the API reports.
 */
export const HELPER_MODELS: Array<{ id: string; name: string; note: string; price: { input: number; output: number; cacheRead: number; cacheWrite: number } }> = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", note: "Smartest answers", price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", note: "Fast and clever, about half the price", price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", note: "Quickest and cheapest by far", price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
];
export const DEFAULT_HELPER_MODEL = HELPER_MODELS[0]!.id;

/** How long answers may get, as the most tokens one answer can use (thinking included). */
export const HELPER_ANSWER_LENGTHS = { short: 2000, medium: 6000, long: 16000 } as const;
export type HelperAnswerLength = keyof typeof HELPER_ANSWER_LENGTHS;

/** How hard the model thinks before answering: more thinking is smarter, slower and costs more. */
export const HELPER_EFFORTS = ["low", "medium", "high"] as const;
export type HelperEffort = (typeof HELPER_EFFORTS)[number];

/** Messages a person can send a day when the admin hasn't changed it. 0 means no limit. */
export const DEFAULT_HELPER_DAILY_LIMIT = 50;
export const DEFAULT_HELPER_KID_DAILY_LIMIT = 20;

/** Longest message a person can send, and how much of the chat goes back to the AI each time. */
export const HELPER_MAX_MESSAGE = 2000;
export const HELPER_MAX_TURNS = 20;

/** The server's AI settings as an admin sees them. The API key comes back masked. */
export interface HelperSettings {
  enabled: boolean;
  provider: "anthropic";
  apiKey: string;
  model: string;
  effort: HelperEffort;
  answerLength: HelperAnswerLength;
  /** Messages per person per day; 0 is unlimited. A person's own limit wins. */
  dailyLimit: number;
  /** The same for kid profiles. */
  kidDailyLimit: number;
  /** US dollars a month; once this month's estimated spend reaches it, Bandit pauses until next month. 0: no budget. */
  monthlyBudget: number;
}

export interface HelperSettingsView {
  settings: HelperSettings;
  /** The key comes from ANTHROPIC_API_KEY instead of the settings. */
  keyFromEnvironment: boolean;
  /** A key is set and the helper is switched on. */
  ready: boolean;
  /** This month's budget is used up. */
  paused: boolean;
}

/** What Bandit cost this month, for the admin. */
export interface HelperUsageReport {
  /** YYYY-MM, in the household's time zone. */
  month: string;
  /** Estimated US dollars this month. */
  spent: number;
  budget: number;
  paused: boolean;
  messages: number;
  people: Array<{
    userId: number;
    name: string;
    avatar: string;
    kid: boolean;
    /** The parent's switch, and whether it's the default. */
    allowed: boolean;
    isDefault: boolean;
    /** Their own daily limit; null uses the server's (effectiveLimit). */
    dailyLimit: number | null;
    effectiveLimit: number;
    today: number;
    messages: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }>;
  days: Array<{ day: string; messages: number; cost: number }>;
}

/** Whether Bandit shows for the signed-in person, and why not. */
export interface HelperStatus {
  /** The server has an AI set up and switched on. */
  configured: boolean;
  /** An admin lets this person use Bandit (kid profiles: off until a grown-up allows it). */
  allowed: boolean;
  /** The person's own switch. */
  enabled: boolean;
  /** configured && allowed && enabled (he may still be paused or out of messages). */
  available: boolean;
  kid: boolean;
  /** Messages left today; null when there's no limit. */
  remaining: number | null;
  /** The monthly budget is used up, so Bandit rests until next month. */
  paused: boolean;
}

/** An admin's switch for one person. null: the default (on for grown-ups, off for kids). */
export interface HelperAccess {
  allowed: boolean;
  /** True when no admin has set it, so the default applies. */
  isDefault: boolean;
  /** This person's own daily message limit (0: no limit); null uses the server's. */
  dailyLimit: number | null;
}

export interface HelperChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** What Bandit is looking at with you: a LootDen game, or another store's game. */
export type HelperGameRef = { gameId: string } | { store: { addon: string; id: string; title?: string } };

export interface HelperChatRequest {
  messages: HelperChatMessage[];
  game?: HelperGameRef | null;
}

/** Grown-ups get Bandit unless an admin says no; kids only when an admin says yes. */
export function helperAllowed(setting: boolean | null | undefined, kid: boolean): boolean {
  return setting ?? !kid;
}

/** Starter questions, so a controller player can ask something without typing. */
export function helperSuggestions(gameTitle: string | null, kid: boolean): string[] {
  if (gameTitle)
    return kid
      ? [`What's ${gameTitle} about?`, "Give me a tip for beginners", "I'm stuck, can you help?", "Is there a fun secret to find?"]
      : [`Beginner tips for ${gameTitle}`, "I'm stuck. Help without big spoilers", "Best settings for a handheld", "What should I do next?"];
  return kid
    ? ["Pick a game for me to play", "Tell me a gaming joke", "How do I get better at games?"]
    : ["What should I play next?", "Suggest a co-op game for tonight", "How do I fix stutter in PC games?"];
}

/** Token counts one answer used, as the API reports them. */
export interface HelperTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Estimated US dollars for one answer. Unknown models are priced like the default (the most expensive listed). */
export function helperCost(model: string, t: HelperTokens): number {
  const p = (HELPER_MODELS.find((m) => model.startsWith(m.id)) ?? HELPER_MODELS[0]!).price;
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1_000_000;
}
