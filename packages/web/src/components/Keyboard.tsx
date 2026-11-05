import { useEffect, useRef, useState } from "react";
import { PAD_EVENT, TYPE_EVENT, type PadPress } from "../gamepad";
import { feel } from "../feedback";
import { padPrefs } from "../prefs";
import { PadGlyph } from "./PadHints";

type Field = HTMLInputElement | HTMLTextAreaElement;

const LETTERS = ["1234567890", "qwertyuiop", "asdfghjkl'", "zxcvbnm,.-"];
const SYMBOLS = ["!@#$%^&*()", "-_=+[]{}\\|", ";:\"/?<>`~€", "£¥§°…•·×÷"];

/** Text boxes the keyboard can't usefully fill in. */
const SKIP = new Set(["checkbox", "radio", "file", "range", "color", "date", "datetime-local", "time", "month", "week", "hidden"]);

/** Sets a box's text so React sees it (React ignores a plain `.value =`). */
function setText(el: Field, text: string, caret: number): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    // email and number boxes have no selection
  }
}

/**
 * LootDen's own keyboard for a controller. A on a text box opens it (instead of hoping Windows
 * shows its touch keyboard in full screen); the d-pad picks keys, A types, X deletes, Y adds a
 * space, LT and RT move the cursor, L3 is Shift, Menu finishes and B closes. Switched under
 * Settings, Controller and handheld.
 */
export function Keyboard() {
  const [field, setField] = useState<Field | null>(null);
  const [text, setTextState] = useState("");
  const [caret, setCaret] = useState(0);
  const [shift, setShift] = useState(false);
  const [symbols, setSymbols] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const state = useRef({ text, caret, field });
  state.current = { text, caret, field };

  // A on a text box: take it, unless the keyboard is switched off (or only for controllers and this isn't one).
  useEffect(() => {
    const onType = (e: Event) => {
      const el = (e as CustomEvent<Field>).detail;
      const choice = padPrefs().keyboard;
      if (choice === "off" || (choice === "auto" && document.documentElement.dataset.nav !== "pad")) return;
      if (el instanceof HTMLInputElement && SKIP.has(el.type)) return;
      if (el.readOnly || el.disabled) return;
      e.preventDefault();
      const value = el.value;
      setField(el);
      setTextState(value);
      setCaret(el.selectionStart ?? value.length);
      setShift(false);
      setSymbols(false);
      feel("open");
    };
    window.addEventListener(TYPE_EVENT, onType);
    return () => window.removeEventListener(TYPE_EVENT, onType);
  }, []);

  // Focus the middle of the keys when it opens, so the d-pad starts there.
  useEffect(() => {
    if (field) panel.current?.querySelector<HTMLElement>('[data-key="g"]')?.focus({ preventScroll: true });
  }, [field]);

  const put = (next: string, at: number) => {
    const el = state.current.field;
    if (!el) return;
    const max = el.maxLength > 0 ? el.maxLength : Infinity;
    if (next.length > max) return;
    setTextState(next);
    setCaret(at);
    setText(el, next, at);
  };
  const type = (s: string) => {
    const { text: t, caret: c } = state.current;
    put(t.slice(0, c) + s + t.slice(c), c + s.length);
    if (shift) setShift(false);
  };
  const backspace = () => {
    const { text: t, caret: c } = state.current;
    if (c > 0) put(t.slice(0, c - 1) + t.slice(c), c - 1);
  };
  const moveCaret = (by: number) => {
    const { text: t, caret: c } = state.current;
    const at = Math.min(t.length, Math.max(0, c + by));
    setCaret(at);
    try {
      state.current.field?.setSelectionRange(at, at);
    } catch {
      // no selection on this kind of box
    }
  };
  const close = (submit: boolean) => {
    const el = state.current.field;
    state.current.field = null;
    setField(null);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (!submit) return;
    // Enter: the box's form if it has one, otherwise whatever listens for Enter (search boxes).
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    if (el instanceof HTMLInputElement && el.form) el.form.requestSubmit();
  };

  // Controller buttons while it's open; a real keyboard works too.
  useEffect(() => {
    if (!field) return;
    const onPad = (e: Event) => {
      const { button } = (e as CustomEvent<{ button: PadPress }>).detail;
      const jobs: Partial<Record<PadPress, () => void>> = {
        x: backspace,
        y: () => type(" "),
        lt: () => moveCaret(-1),
        rt: () => moveCaret(1),
        l3: () => setShift((s) => !s),
        menu: () => close(true),
        b: () => close(false),
        view: () => setSymbols((s) => !s),
        lb: () => moveCaret(-1000),
        rb: () => moveCaret(1000),
      };
      const job = jobs[button];
      if (!job) return;
      e.preventDefault();
      feel(button === "b" ? "back" : "select");
      job();
    };
    const onKey = (e: KeyboardEvent) => {
      // The Enter sent to the box when finishing is for the page, not for us.
      if (!state.current.field || e.target === state.current.field) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "Escape") return (e.preventDefault(), e.stopImmediatePropagation(), close(false));
      if (e.key === "Backspace") return (e.preventDefault(), backspace());
      if (e.key === "Enter" && !(document.activeElement as HTMLElement | null)?.closest(".osk-keys")) return (e.preventDefault(), close(true));
      if (e.key.length === 1) {
        e.preventDefault();
        type(e.key);
      }
    };
    window.addEventListener(PAD_EVENT, onPad);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener(PAD_EVENT, onPad);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, shift]);

  if (!field) return null;
  const rows = symbols ? SYMBOLS : LETTERS;
  const label = field.getAttribute("aria-label") || field.placeholder || "Type";
  const secret = field instanceof HTMLInputElement && field.type === "password";
  const shown = secret ? "•".repeat(text.length) : text;
  const key = (ch: string) => (shift && !symbols ? ch.toUpperCase() : ch);

  return (
    <div className="osk-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className="osk panel" role="dialog" aria-modal="true" aria-label="Keyboard" ref={panel}>
        <div className="osk-preview" aria-live="polite">
          <small className="muted">{label}</small>
          <div className="osk-text">
            <span>{shown.slice(0, caret)}</span>
            <i className="osk-caret" aria-hidden="true" />
            <span>{shown.slice(caret)}</span>
          </div>
        </div>
        <div className="osk-keys">
          {rows.map((row) => (
            <div className="osk-row" key={row}>
              {[...row].map((ch) => (
                <button key={ch} type="button" data-key={ch} onClick={() => type(key(ch))}>
                  {key(ch)}
                </button>
              ))}
            </div>
          ))}
          <div className="osk-row osk-actions">
            <button type="button" className={shift ? "active" : ""} aria-pressed={shift} onClick={() => setShift((s) => !s)}>
              <PadGlyph button="l3" /> Shift
            </button>
            <button type="button" className={symbols ? "active" : ""} aria-pressed={symbols} onClick={() => setSymbols((s) => !s)}>
              <PadGlyph button="view" /> {symbols ? "abc" : "#+="}
            </button>
            <button type="button" className="osk-space" onClick={() => type(" ")}>
              <PadGlyph button="y" /> Space
            </button>
            <button type="button" onClick={backspace} aria-label="Delete">
              <PadGlyph button="x" /> ⌫
            </button>
            <button type="button" onClick={() => moveCaret(-1)} aria-label="Cursor left">
              <PadGlyph button="lt" /> ←
            </button>
            <button type="button" onClick={() => moveCaret(1)} aria-label="Cursor right">
              → <PadGlyph button="rt" />
            </button>
            <button type="button" className="osk-done" onClick={() => close(true)}>
              <PadGlyph button="menu" /> Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
