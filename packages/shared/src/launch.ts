/**
 * Launch options for a game on one PC: extra ways to start it (a mod launcher like SMAPI or
 * RAGE Plugin Hook, a config tool), each made of steps run in order with waits between them,
 * and steps run before the game starts and after it closes (switch HDR on, close Discord).
 * Kept per PC in the desktop app's settings, because paths differ from PC to PC.
 */

/** Starts a program. Relative paths are inside the game's folder. */
export interface LaunchRunStep {
  type: "run";
  /** The program, script (.bat, .cmd, .ps1, .sh) or file to open. `{game}` is the game's folder. */
  path: string;
  /** Command-line arguments, as typed (quotes group words). */
  args?: string;
  /** Folder it starts in; blank means the program's own folder. */
  cwd?: string;
  /** Wait until it closes before the next step (a script that sets things up). */
  waitForExit?: boolean;
  /** Start it minimised / without a window (scripts). */
  hidden?: boolean;
}

/** Waits a number of seconds before the next step (a game that has to load before its mod loader). */
export interface LaunchWaitStep {
  type: "wait";
  seconds: number;
}

/** Closes every running program with this file name, e.g. "Discord.exe". */
export interface LaunchCloseStep {
  type: "close";
  name: string;
}

export type LaunchStep = LaunchRunStep | LaunchWaitStep | LaunchCloseStep;

/** One way to start a game: "Play with SMAPI", "LSPDFR". */
export interface LaunchAction {
  id: string;
  name: string;
  steps: LaunchStep[];
}

/** Everything set for one game on this PC. */
export interface LaunchProfile {
  /** Extra ways to start the game. */
  actions: LaunchAction[];
  /** The action ▶ Play uses; null or missing means the game's own way. */
  defaultAction?: string | null;
  /** Run before the game starts, and after it closes. */
  before: LaunchStep[];
  after: LaunchStep[];
  /** Skip the steps every game runs (set under This computer). */
  skipGlobal?: boolean;
}

/** Steps every game on this PC runs before it starts and after it closes. */
export interface GlobalLaunchScripts {
  before: LaunchStep[];
  after: LaunchStep[];
}

/** The key a game's launch options are kept under: a LootDen game's id, or another store's game. */
export function launchKey(game: { gameId: string } | { addon: string; externalId: string }): string {
  return "gameId" in game ? `lootden:${game.gameId}` : `store:${game.addon}:${game.externalId}`;
}

export const MAX_LAUNCH_STEPS = 20;
export const MAX_LAUNCH_ACTIONS = 10;
/** Longest single wait: ten minutes. */
export const MAX_LAUNCH_WAIT = 600;

const text = (v: unknown, max: number) => String(v ?? "").replace(/[\0\r\n]/g, " ").trim().slice(0, max);

/** A step as typed in the app, checked and trimmed. Throws on one that can't run. */
export function cleanLaunchStep(input: unknown): LaunchStep {
  const s = (input ?? {}) as Record<string, unknown>;
  if (s.type === "wait") {
    const seconds = Math.round(Number(s.seconds));
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > MAX_LAUNCH_WAIT) throw new Error(`A wait is 1 to ${MAX_LAUNCH_WAIT} seconds`);
    return { type: "wait", seconds };
  }
  if (s.type === "close") {
    const name = text(s.name, 260);
    if (!name || /[\\/]/.test(name)) throw new Error("Close takes a program's file name, like Discord.exe");
    return { type: "close", name };
  }
  if (s.type === "run") {
    const path = text(s.path, 1024);
    if (!path) throw new Error("Pick the program to start");
    const step: LaunchRunStep = { type: "run", path };
    const args = text(s.args, 2000);
    const cwd = text(s.cwd, 1024);
    if (args) step.args = args;
    if (cwd) step.cwd = cwd;
    if (s.waitForExit) step.waitForExit = true;
    if (s.hidden) step.hidden = true;
    return step;
  }
  throw new Error("Unknown step");
}

export function cleanLaunchSteps(input: unknown): LaunchStep[] {
  const list = Array.isArray(input) ? input : [];
  if (list.length > MAX_LAUNCH_STEPS) throw new Error(`At most ${MAX_LAUNCH_STEPS} steps`);
  return list.map(cleanLaunchStep);
}

/** A whole profile from the app's editor, checked. Ids are kept when they look like ids, otherwise made up. */
export function cleanLaunchProfile(input: unknown): LaunchProfile {
  const p = (input ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(p.actions) ? p.actions : [];
  if (raw.length > MAX_LAUNCH_ACTIONS) throw new Error(`At most ${MAX_LAUNCH_ACTIONS} ways to start a game`);
  const seen = new Set<string>();
  const actions = raw.map((a, i): LaunchAction => {
    const r = (a ?? {}) as Record<string, unknown>;
    let id = /^[a-z0-9-]{1,40}$/i.test(String(r.id ?? "")) ? String(r.id) : `a${i + 1}`;
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    const name = text(r.name, 60) || `Option ${i + 1}`;
    const steps = cleanLaunchSteps(r.steps);
    if (!steps.some((s) => s.type === "run")) throw new Error(`"${name}" needs a program to start`);
    return { id, name, steps };
  });
  const def = typeof p.defaultAction === "string" && seen.has(p.defaultAction) ? p.defaultAction : null;
  return { actions, defaultAction: def, before: cleanLaunchSteps(p.before), after: cleanLaunchSteps(p.after), ...(p.skipGlobal ? { skipGlobal: true } : {}) };
}

/** Nothing set: the profile can be dropped. */
export function emptyLaunchProfile(p: LaunchProfile): boolean {
  return !p.actions.length && !p.before.length && !p.after.length && !p.skipGlobal;
}

/** Splits typed arguments into a list: spaces separate, "double quotes" group. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let has = false;
  for (const ch of input) {
    if (ch === '"') {
      quoted = !quoted;
      has = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** A short line describing a step, for lists. */
export function describeLaunchStep(s: LaunchStep): string {
  if (s.type === "wait") return `Wait ${s.seconds} s`;
  if (s.type === "close") return `Close ${s.name}`;
  const name = s.path.split(/[\\/]/).pop() ?? s.path;
  return `Start ${name}${s.args ? ` ${s.args}` : ""}${s.waitForExit ? " and wait for it" : ""}`;
}
