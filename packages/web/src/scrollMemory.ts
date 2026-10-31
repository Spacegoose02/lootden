import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/** Where each page in the history was: how far down, and the link or button that had focus. */
interface Spot {
  y: number;
  /** The focused link's address, or the focused element's label, to find it again. */
  focus: { href?: string; label?: string } | null;
}

const KEY = "lootden:spots";
const spots = new Map<string, Spot>(
  (() => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as Array<[string, Spot]>;
    } catch {
      return [];
    }
  })(),
);
const persist = () => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify([...spots].slice(-50)));
  } catch {
    // Private mode: back still works within this page load.
  }
};

function focusSpot(): Spot["focus"] {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body || !el.closest("main")) return null;
  const href = el instanceof HTMLAnchorElement ? el.getAttribute("href") ?? undefined : undefined;
  const label = el.getAttribute("aria-label") ?? undefined;
  return href || label ? { href, label } : null;
}

function findFocus(f: NonNullable<Spot["focus"]>): HTMLElement | null {
  const main = document.querySelector("main");
  if (!main) return null;
  const all = [...main.querySelectorAll<HTMLElement>(f.href ? "a[href]" : "[aria-label]")];
  return all.find((el) => (f.href ? el.getAttribute("href") === f.href : el.getAttribute("aria-label") === f.label)) ?? null;
}

/**
 * Back (the browser's, the app's, a controller's B) lands where you were: the same spot down
 * the page and, with a controller or keys, the same game selected. Pages load their lists
 * after they appear, so it keeps trying for a few seconds until the page is long enough, and
 * gives up as soon as you scroll or press something yourself. New pages start at the top.
 */
export function useScrollMemory(): void {
  const location = useLocation();
  const type = useNavigationType();
  const current = useRef(location.key);

  useEffect(() => {
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    let timer: number | undefined;
    // Saved straight away (it's only a map), so a click right after scrolling still has it.
    const save = () => {
      spots.set(current.current, { y: window.scrollY, focus: focusSpot() });
      window.clearTimeout(timer);
      timer = window.setTimeout(persist, 300);
    };
    window.addEventListener("scroll", save, { passive: true });
    document.addEventListener("focusin", save);
    return () => {
      window.removeEventListener("scroll", save);
      document.removeEventListener("focusin", save);
      window.clearTimeout(timer);
    };
  }, []);

  useLayoutEffect(() => {
    current.current = location.key;
    if (type === "PUSH") {
      window.scrollTo(0, 0);
      return;
    }
    if (type === "REPLACE") {
      // Same page, new address (a filter or tab changed): it stays where it is.
      spots.set(location.key, { y: window.scrollY, focus: focusSpot() });
      return;
    }
    const spot = spots.get(location.key);
    if (!spot) return;
    let frame = 0;
    let stopped = false;
    const until = Date.now() + 4000;
    const stop = () => (stopped = true);
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    events.forEach((e) => window.addEventListener(e, stop, { passive: true, once: true }));
    let scrolled = spot.y === 0;
    let focused = !spot.focus || document.documentElement.dataset.nav !== "pad";
    const tryRestore = () => {
      if (stopped) return;
      if (!scrolled && document.documentElement.scrollHeight - window.innerHeight >= spot.y - 2) {
        window.scrollTo(0, spot.y);
        scrolled = true;
      }
      if (!focused && scrolled) {
        const el = findFocus(spot.focus!);
        if (el) {
          el.focus({ preventScroll: true });
          focused = true;
        }
      }
      if ((!scrolled || !focused) && Date.now() < until) frame = requestAnimationFrame(tryRestore);
    };
    tryRestore();
    return () => {
      cancelAnimationFrame(frame);
      events.forEach((e) => window.removeEventListener(e, stop));
    };
  }, [location.key, type]);
}
