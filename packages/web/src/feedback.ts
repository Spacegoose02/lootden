import { padPrefs } from "./prefs";

/**
 * Rumble and sound for controller navigation, so a move, a press and the edge of the page feel
 * different, like a console's menus. Both are switched under Settings, Controller and handheld.
 */
export type Feel = "move" | "select" | "back" | "edge" | "open";

let lastPad: Gamepad | null = null;
/** The controller pressed last (the gamepad loop tells us), which is the one that rumbles. */
export const rememberPad = (pad: Gamepad) => void (lastPad = pad);

const RUMBLE: Record<Feel, [number, number, number]> = {
  // duration ms, strong motor, weak motor
  move: [18, 0, 0.18],
  select: [35, 0.25, 0.35],
  back: [25, 0.1, 0.25],
  edge: [60, 0.45, 0.2],
  open: [30, 0.15, 0.3],
};

const TONE: Record<Feel, [number, number, number]> = {
  // start Hz, end Hz, length ms
  move: [880, 880, 30],
  select: [660, 990, 70],
  back: [660, 440, 70],
  edge: [220, 180, 60],
  open: [520, 780, 80],
};

let audio: AudioContext | null = null;

function rumble(feel: Feel): void {
  const pad = lastPad && navigator.getGamepads?.()[lastPad.index];
  const act = (pad as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }) | null)?.vibrationActuator;
  if (!act?.playEffect) return;
  const [duration, strongMagnitude, weakMagnitude] = RUMBLE[feel];
  act.playEffect("dual-rumble", { duration, strongMagnitude, weakMagnitude }).catch(() => {});
}

function beep(feel: Feel, volume: number): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    const [from, to, ms] = TONE[feel];
    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.linearRampToValueAtTime(to, t + ms / 1000);
    // Soft: a quick fade in and out so it's a tick, not a beep.
    const peak = 0.12 * (volume / 100);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  } catch {
    // no audio device
  }
}

/** Only for controller and arrow-key navigation: a mouse click never rumbles or clicks. */
export function feel(kind: Feel): void {
  const p = padPrefs();
  if (p.haptics) rumble(kind);
  if (p.sounds && p.volume > 0) beep(kind, p.volume);
}

// ---- Button names ----------------------------------------------------------------

export type PadStyle = "xbox" | "playstation" | "nintendo";

/** Works out the controller's family from the name Chromium reports (with its USB vendor id). */
export function styleOf(id: string): PadStyle {
  if (/054c|playstation|dualsense|dualshock|wireless controller/i.test(id)) return "playstation";
  if (/057e|nintendo|pro controller|joy-?con/i.test(id)) return "nintendo";
  return "xbox";
}

export type PadButton = "a" | "b" | "x" | "y" | "lb" | "rb" | "lt" | "rt" | "view" | "menu" | "l3" | "r3";

/**
 * What's printed on each button, by position: the bottom face button is A on Xbox, Cross on
 * PlayStation and B on Nintendo.
 */
export const GLYPHS: Record<PadStyle, Record<PadButton, string>> = {
  xbox: { a: "A", b: "B", x: "X", y: "Y", lb: "LB", rb: "RB", lt: "LT", rt: "RT", view: "View", menu: "Menu", l3: "L3", r3: "R3" },
  playstation: { a: "✕", b: "○", x: "□", y: "△", lb: "L1", rb: "R1", lt: "L2", rt: "R2", view: "Create", menu: "Options", l3: "L3", r3: "R3" },
  nintendo: { a: "B", b: "A", x: "Y", y: "X", lb: "L", rb: "R", lt: "ZL", rt: "ZR", view: "−", menu: "+", l3: "LS", r3: "RS" },
};

let detected: PadStyle = "xbox";
const STYLE_EVENT = "lootden:pad-style";
export const PAD_STYLE_EVENT = STYLE_EVENT;

/** The gamepad loop reports the controller in use; hints follow it unless a style was chosen. */
export function seePad(pad: Gamepad): void {
  rememberPad(pad);
  const s = styleOf(pad.id);
  if (s === detected) return;
  detected = s;
  window.dispatchEvent(new Event(STYLE_EVENT));
}

export function padStyle(): PadStyle {
  const chosen = padPrefs().glyphs;
  return chosen === "auto" ? detected : chosen;
}
