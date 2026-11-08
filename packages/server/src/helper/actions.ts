import { cleanSmartRules, HELPER_NAME, type User } from "@lootden/shared";
import type { AppContext } from "../context.js";

/**
 * Things Bandit can offer to do: send a game to a PC, wake a PC, make a shelf. He never does them
 * himself. His answer ends with an [[action {...}]] line, the app shows it as a button, and only
 * when the person presses it does the browser call POST /api/helper/action. That runs with the
 * person's own permissions, the same checks as doing it by hand.
 */
export type HelperAction =
  | { type: "install"; gameId: string; pc: string }
  | { type: "wake"; pc: string }
  | { type: "shelf"; name: string; emoji?: string; gameIds?: string[]; rules?: unknown; household?: boolean };

export const ACTION_PROMPT = `You can also offer to do things in LootDen for them. You never do them yourself: you offer, and LootDen shows a button they press to go ahead. To offer one, end your answer with exactly one line like this (JSON on one line, nothing after it):
[[action {"type":"install","gameId":"<id>","pc":"<PC name>"}]]   send a game to a PC to download and install
[[action {"type":"wake","pc":"<PC name>"}]]   switch a PC on (Wake-on-LAN)
[[action {"type":"shelf","name":"<name>","emoji":"<one emoji>","gameIds":["<id>",...]}]]   a shelf with these games
[[action {"type":"shelf","name":"<name>","rules":{...}}]]   a smart shelf that fills itself; rules can have genres (list), platform, tags (list), played (true/false), installed (true/false), together (true for co-op/party games), kidSafe, minRating (0-100), fromYear, toYear, addedDays, search, sort (title/added/rating/release/random), limit
Only use game ids and PC names from the house list below. Say in words what the button will do, ask if they'd like it, and never say it's done. Offer at most one action per answer, and only when they ask for something to be done.`;

const MAX_GAMES = 500;

/** What the house has, for the prompt: games with ids, which PCs have them, and the PCs. */
export function houseContext(ctx: AppContext, user: User): string {
  const kid = user.kidMode;
  const installed = new Map<string, string[]>();
  for (const pc of ctx.presence.copiesByPc()) for (const c of pc.copies) installed.set(c.gameId, [...(installed.get(c.gameId) ?? []), pc.device]);
  const games = ctx.library.list(kid ? { kidSafe: true } : {}).slice(0, MAX_GAMES);
  const lines = games.map((g) => {
    const bits = [g.id, g.title];
    if (g.platform !== "pc") bits.push(g.platform);
    if (g.together?.length) bits.push(`together: ${g.together.join(", ")}`);
    const on = installed.get(g.id);
    if (on?.length) bits.push(`installed on: ${on.join(", ")}`);
    return bits.join(" | ");
  });
  const pcs = ctx.presence.pcs().map((pc) => {
    const who = pc.lastUser ? `, used by ${pc.lastUser}` : "";
    const now = pc.playing[0] ? `, ${pc.playing[0].name} is playing ${pc.playing[0].title}` : "";
    return `${pc.name}: ${pc.online ? "on" : "off"}${who}${now}`;
  });
  return [
    ACTION_PROMPT,
    `The family's PCs:\n${pcs.join("\n") || "(none yet: the LootDen app hasn't run on any PC)"}`,
    `The game library (id | title | platform | ways to play together | PCs it's installed on)${games.length === MAX_GAMES ? `, the first ${MAX_GAMES}` : ""}:\n${lines.join("\n") || "(empty)"}`,
  ].join("\n\n");
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Checks an action from the browser (it came from the AI, so nothing is trusted). */
export function cleanAction(raw: unknown): HelperAction {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (a.type === "install") {
    const gameId = str(a.gameId, 300);
    const pc = str(a.pc, 100);
    if (!gameId || !pc) throw new Error("Which game, and which PC?");
    return { type: "install", gameId, pc };
  }
  if (a.type === "wake") {
    const pc = str(a.pc, 100);
    if (!pc) throw new Error("Which PC?");
    return { type: "wake", pc };
  }
  if (a.type === "shelf") {
    const name = str(a.name, 60);
    if (!name) throw new Error("Give the shelf a name");
    const gameIds = Array.isArray(a.gameIds) ? [...new Set(a.gameIds.map((x) => str(x, 300)).filter(Boolean))].slice(0, 200) : undefined;
    const rules = cleanSmartRules(a.rules) ?? undefined;
    if (!rules && !gameIds?.length) throw new Error("The shelf needs games or rules");
    return { type: "shelf", name, emoji: str(a.emoji, 8) || undefined, gameIds: rules ? undefined : gameIds, rules, household: a.household === true };
  }
  throw new Error(`${HELPER_NAME} can't do that yet`);
}

/** Runs an action the person said yes to, with their own permissions. Returns what happened, in words. */
export async function runAction(ctx: AppContext, who: { user: User; admin: boolean }, action: HelperAction): Promise<{ text: string; link?: string }> {
  const { user, admin } = who;
  const pcOk = (pc: string) => {
    if (!ctx.presence.pcs().some((p) => p.name === pc)) throw new Error(`LootDen doesn't know a PC called ${pc}`);
    if (!admin && ctx.presence.lastUserOf(pc) !== user.id) throw new Error("You can do that on PCs you use. Ask a grown-up for the others.");
  };
  if (action.type === "install") {
    pcOk(action.pc);
    const game = ctx.library.get(action.gameId, false);
    if (!game || (user.kidMode && game.kidSafe !== true)) throw new Error("That game isn't in the library");
    if (game.kind !== "game") throw new Error("Updates and DLC are applied from the Updates page");
    ctx.presence.send(action.pc, user.displayName, { kind: "install", gameId: game.id, title: game.title });
    const on = ctx.presence.pcs().find((p) => p.name === action.pc)?.online;
    return { text: on ? `${game.title} is on its way to ${action.pc}.` : `${game.title} will install on ${action.pc} when it next comes on.`, link: `/games/${game.id}` };
  }
  if (action.type === "wake") {
    pcOk(action.pc);
    await ctx.presence.wakePc(action.pc);
    return { text: `Sent ${action.pc} the wake-up signal. It should be on in a minute.` };
  }
  const id = ctx.shelves.create(user.id, admin, { name: action.name, emoji: action.emoji ?? null, household: action.household === true && admin, rules: action.rules ?? null });
  let added = 0;
  for (const gameId of action.gameIds ?? []) {
    const g = ctx.library.get(gameId, false);
    if (!g || (user.kidMode && g.kidSafe !== true)) continue;
    ctx.shelves.addGame(id, user.id, admin, gameId);
    added++;
  }
  return { text: action.rules ? `Made the smart shelf "${action.name}". It fills itself as games match.` : `Made the shelf "${action.name}" with ${added} game${added === 1 ? "" : "s"}.`, link: "/library" };
}
