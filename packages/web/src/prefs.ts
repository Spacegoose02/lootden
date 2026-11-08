import { useEffect, useState } from "react";

/**
 * Controller and handheld choices. They belong to this person on this device (like the theme),
 * so they live in the browser's storage and never touch the server's settings.
 */
export interface PadPrefs {
  /** LootDen's own keyboard for text boxes: with a controller (auto), always, or never (Windows' own keyboard). */
  keyboard: "auto" | "on" | "off";
  /** A short rumble when the selection moves, on A and at the edge of the page. */
  haptics: boolean;
  /** Quiet clicks when the selection moves and on A and B. */
  sounds: boolean;
  /** 0 to 100. */
  volume: number;
  /** Which buttons the hints show: worked out from the controller, or chosen. */
  glyphs: "auto" | "xbox" | "playstation" | "nintendo";
  /** The button hints along the bottom while a controller is in use. */
  hints: boolean;
  /** Menu (Start) opens the selected game's options and View (Select) the quick menu. */
  quickMenus: boolean;
  /** L3 jumps to a letter in a list of games and R3 back to the top. */
  stickJumps: boolean;
}

export const PAD_DEFAULTS: PadPrefs = { keyboard: "auto", haptics: true, sounds: false, volume: 40, glyphs: "auto", hints: true, quickMenus: true, stickJumps: true };

const KEY = "gm-pad-prefs";
const EVENT = "lootden:pad-prefs";
let cached: PadPrefs | null = null;

function clean(raw: unknown): PadPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof PadPrefs, unknown>>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const volume = typeof r.volume === "number" && Number.isFinite(r.volume) ? Math.min(100, Math.max(0, Math.round(r.volume))) : PAD_DEFAULTS.volume;
  return {
    keyboard: pick(r.keyboard, ["auto", "on", "off"] as const, PAD_DEFAULTS.keyboard),
    haptics: bool(r.haptics, PAD_DEFAULTS.haptics),
    sounds: bool(r.sounds, PAD_DEFAULTS.sounds),
    volume,
    glyphs: pick(r.glyphs, ["auto", "xbox", "playstation", "nintendo"] as const, PAD_DEFAULTS.glyphs),
    hints: bool(r.hints, PAD_DEFAULTS.hints),
    quickMenus: bool(r.quickMenus, PAD_DEFAULTS.quickMenus),
    stickJumps: bool(r.stickJumps, PAD_DEFAULTS.stickJumps),
  };
}

/** The current choices, for code outside React (the gamepad loop). */
export function padPrefs(): PadPrefs {
  if (cached) return cached;
  try {
    cached = clean(JSON.parse(localStorage.getItem(KEY) || "{}"));
  } catch {
    cached = { ...PAD_DEFAULTS };
  }
  return cached;
}

export function setPadPrefs(patch: Partial<PadPrefs>): PadPrefs {
  cached = clean({ ...padPrefs(), ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(cached));
  } catch {
    // private mode: kept until the app closes
  }
  if (typeof document !== "undefined") document.documentElement.dataset.padHints = cached.hints ? "on" : "off";
  window.dispatchEvent(new Event(EVENT));
  return cached;
}

if (typeof document !== "undefined") document.documentElement.dataset.padHints = padPrefs().hints ? "on" : "off";

export function usePadPrefs(): [PadPrefs, (patch: Partial<PadPrefs>) => void] {
  const [prefs, setPrefs] = useState(padPrefs);
  useEffect(() => {
    const on = () => setPrefs(padPrefs());
    window.addEventListener(EVENT, on);
    // Another window of the app (or tab) changed them.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY) return;
      cached = null;
      on();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return [prefs, (patch) => setPrefs(setPadPrefs(patch))];
}

/** Video previews on game cards and attract mode, per device. */
export interface MediaPrefs {
  /** Play a game's trailer, muted, when the pointer or controller selection rests on its card. */
  previews: boolean;
  /** Minutes idle with a controller before attract mode starts; 0 is never. */
  attractMinutes: number;
}

export const MEDIA_DEFAULTS: MediaPrefs = { previews: true, attractMinutes: 5 };
const MEDIA_KEY = "gm-media-prefs";
const MEDIA_EVENT = "lootden:media-prefs";

export function mediaPrefs(): MediaPrefs {
  try {
    const r = JSON.parse(localStorage.getItem(MEDIA_KEY) || "{}") as Partial<MediaPrefs>;
    return {
      previews: typeof r.previews === "boolean" ? r.previews : MEDIA_DEFAULTS.previews,
      attractMinutes: [0, 2, 5, 10, 20].includes(r.attractMinutes as number) ? (r.attractMinutes as number) : MEDIA_DEFAULTS.attractMinutes,
    };
  } catch {
    return { ...MEDIA_DEFAULTS };
  }
}

export function useMediaPrefs(): [MediaPrefs, (patch: Partial<MediaPrefs>) => void] {
  const [prefs, setPrefs] = useState(mediaPrefs);
  useEffect(() => {
    const on = () => setPrefs(mediaPrefs());
    window.addEventListener(MEDIA_EVENT, on);
    return () => window.removeEventListener(MEDIA_EVENT, on);
  }, []);
  return [
    prefs,
    (patch) => {
      const next = { ...mediaPrefs(), ...patch };
      try {
        localStorage.setItem(MEDIA_KEY, JSON.stringify(next));
      } catch {
        // private mode
      }
      window.dispatchEvent(new Event(MEDIA_EVENT));
    },
  ];
}
