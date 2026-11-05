import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { GLYPHS, PAD_STYLE_EVENT, padStyle, type PadButton, type PadStyle } from "../feedback";
import { usePadPrefs } from "../prefs";

/** The controller's family, following the pad in use (or the style chosen in Settings). */
export function usePadStyle(): PadStyle {
  const [prefs] = usePadPrefs();
  const [style, setStyle] = useState(padStyle);
  useEffect(() => {
    const on = () => setStyle(padStyle());
    on();
    window.addEventListener(PAD_STYLE_EVENT, on);
    return () => window.removeEventListener(PAD_STYLE_EVENT, on);
  }, [prefs.glyphs]);
  return style;
}

/** One button as it's printed on this controller, in its colour where the face buttons have one. */
export function PadGlyph({ button }: { button: PadButton }) {
  const style = usePadStyle();
  const text = GLYPHS[style][button];
  const face = button === "a" || button === "b" || button === "x" || button === "y";
  return <kbd className={`pad-glyph ${face ? `pad-${button}` : "pad-shoulder"} pad-style-${style}`}>{text}</kbd>;
}

type Hint = [PadButton, string];

/** What A does on the selected thing, and what else works there. */
function hintsFor(el: Element | null, quickMenus: boolean, keyboard: boolean): Hint[] {
  const out: Hint[] = [];
  const game = el?.closest('a[href*="/games/"], a[href*="/store/"]');
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) out.push(["a", el.type === "checkbox" ? "Switch" : "Pick"]);
  else if (el instanceof HTMLSelectElement) out.push(["a", "Change"]);
  else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) out.push(["a", keyboard ? "Keyboard" : "Type"]);
  else if (game) out.push(["a", "Open"]);
  else out.push(["a", "Select"]);
  out.push(["b", "Back"]);
  if (game && quickMenus) out.push(["menu", "Options"]);
  return out;
}

/**
 * What the controller buttons do, along the bottom while a controller is in use (shown by CSS).
 * It follows the selection: a game offers Options on Menu, a text box the keyboard, and the
 * Filters, Tabs and Sections hints show only on pages that have them.
 */
export function PadHints() {
  const [prefs] = usePadPrefs();
  const location = useLocation();
  const [, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener("focusin", on);
    // Tabs and filters appear after a page loads its data.
    const t = window.setTimeout(on, 600);
    return () => {
      window.removeEventListener("focusin", on);
      window.clearTimeout(t);
    };
  }, [location.pathname, location.search]);
  if (!prefs.hints) return null;
  const el = typeof document !== "undefined" ? document.activeElement : null;
  const hints = hintsFor(el, prefs.quickMenus, prefs.keyboard !== "off");
  const zones = typeof document !== "undefined" ? document.querySelectorAll("main .filters, main .collection, main [data-nav-zone]").length : 0;
  const tabs = typeof document !== "undefined" ? document.querySelectorAll('main [role="tablist"] [role="tab"]').length : 0;
  // Shown only while Bandit is on (styles.css, data-helper).
  hints.push(["x", "Bandit"]);
  if (zones >= 2) hints.push(["y", "Filters and games"]);
  return (
    <footer className="pad-hints" aria-hidden="true">
      {hints.map(([b, label]) => (
        <span key={b} className={b === "x" ? "pad-hint-helper" : undefined}>
          <PadGlyph button={b} />
          {label}
        </span>
      ))}
      {tabs >= 2 && (
        <span>
          <PadGlyph button="lt" />
          <PadGlyph button="rt" />
          Tabs
        </span>
      )}
      <span>
        <PadGlyph button="lb" />
        <PadGlyph button="rb" />
        Sections
      </span>
      {prefs.quickMenus && (
        <span>
          <PadGlyph button="view" />
          Quick menu
        </span>
      )}
    </footer>
  );
}
