/**
 * Couch and handheld navigation: arrow keys and a gamepad (ROG Ally, Steam Deck,
 * any XInput pad) move focus between on-screen items by position, A activates,
 * B goes back. Mouse and touch keep working as normal.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]';

type Dir = "up" | "down" | "left" | "right";

function visible(el: HTMLElement): boolean {
  // A closed <details> still lays its contents out in Chromium; only its summary can be reached.
  const shut = el.closest("details:not([open])");
  if (shut && !(el.tagName === "SUMMARY" && el.parentElement === shut)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

/**
 * The selection box. Chromium only draws :focus-visible after keyboard input, so focus moved by
 * a gamepad after any tap or click (the usual case on a touchscreen handheld) showed nothing at
 * all. A box drawn over the page also can't be clipped by scrolling rows the way an outline is.
 */
let ring: HTMLElement | null = null;
let ringFrame = 0;

function trackRing(): void {
  ringFrame = 0;
  if (document.documentElement.dataset.nav !== "pad") return void ring?.classList.remove("on");
  const el = document.activeElement as HTMLElement | null;
  if (!ring) {
    ring = document.createElement("div");
    ring.className = "pad-ring";
    ring.setAttribute("aria-hidden", "true");
    document.body.append(ring);
  }
  let target = el && el !== document.body && !(el instanceof HTMLIFrameElement) ? el : null;
  // Toggle switches hide the real checkbox, so box its label instead.
  if (target && !visible(target)) target = target.closest("label");
  const r = target?.getBoundingClientRect();
  if (target && r && r.width > 0 && r.height > 0) {
    const radius = getComputedStyle(target).borderRadius;
    Object.assign(ring.style, { transform: `translate(${r.left - 5}px, ${r.top - 5}px)`, width: `${r.width + 10}px`, height: `${r.height + 10}px`, borderRadius: radius === "0px" ? "10px" : `calc(${radius} + 5px)` });
    ring.classList.add("on");
  } else ring.classList.remove("on");
  // Followed every frame while shown: tiles grow on focus and rows scroll smoothly.
  ringFrame = requestAnimationFrame(trackRing);
}

/** Controller or arrow keys: show the selection box until the mouse or a finger takes over. */
export function setNavMode(mode: "pad" | "pointer"): void {
  if (document.documentElement.dataset.nav === mode) return;
  document.documentElement.dataset.nav = mode;
  if (mode === "pad" && !ringFrame) ringFrame = requestAnimationFrame(trackRing);
}

/**
 * Areas focus moves between as a whole: the filter bar, the games, the menu. Coming back to one
 * picks the item you left it from, so up from the games to the filters and down again lands on
 * the same game instead of whichever one sits nearest the filter.
 */
const ZONES = '[data-nav-zone], .filters, .collection, nav, header';
const lastInZone = new WeakMap<Element, HTMLElement>();
const zoneOf = (el: Element) => el.closest(ZONES);

/** A select being changed with the d-pad (A starts and ends it); otherwise the d-pad moves past it. */
let editing: HTMLSelectElement | null = null;
function setEditing(el: HTMLSelectElement | null): void {
  editing = el;
  ring?.classList.toggle("editing", !!el);
}

const ahead = (dir: Dir, from: DOMRect, r: DOMRect) => {
  const dx = r.left + r.width / 2 - (from.left + from.width / 2);
  const dy = r.top + r.height / 2 - (from.top + from.height / 2);
  return dir === "right" ? dx > 4 : dir === "left" ? dx < -4 : dir === "down" ? dy > 4 : dy < -4;
};

/** Distance along the move from edge to edge, plus a heavy price for leaving the row or column. */
function score(dir: Dir, from: DOMRect, r: DOMRect): number {
  const across = dir === "left" || dir === "right";
  const main = Math.max(0, dir === "right" ? r.left - from.right : dir === "left" ? from.left - r.right : dir === "down" ? r.top - from.bottom : from.top - r.bottom);
  const gap = across ? Math.max(0, r.top - from.bottom, from.top - r.bottom) : Math.max(0, r.left - from.right, from.left - r.right);
  const centre = across ? Math.abs(r.top + r.height / 2 - (from.top + from.height / 2)) : Math.abs(r.left + r.width / 2 - (from.left + from.width / 2));
  return main + gap * 4 + centre * 0.3;
}

const onScreen = (r: DOMRect) => r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;

/**
 * Where the page's sticky bars (the top bar, a filter bar) end, for an item outside them. An item
 * scrolled under them is hidden, so it's skipped as a target and scrolled out from under them.
 */
function coveredTop(el: Element): number {
  let bottom = 0;
  for (const bar of document.querySelectorAll<HTMLElement>(".topbar, main .filters")) {
    if (bar.contains(el) || getComputedStyle(bar).position !== "sticky") continue;
    const r = bar.getBoundingClientRect();
    if (r.height > 0 && r.top < 1 + bottom + 80) bottom = Math.max(bottom, r.bottom);
  }
  return bottom;
}

/** Inside one of the bars that stay put while the page scrolls (the top bar with the menu). */
const inStickyBar = (el: Element) => !!el.closest(".topbar");

/** Mostly under a sticky bar: there on the page, but not something you can see. */
const hidden = (el: Element, r: DOMRect) => {
  const top = coveredTop(el);
  return top > 0 && r.top < top && r.bottom - Math.max(r.top, top) < r.height * 0.4;
};

/** Scrolls an item into view below the sticky bars, not under them. */
function reveal(el: HTMLElement, instant: boolean): void {
  const root = document.documentElement;
  const before = [root.style.scrollPaddingTop, root.style.scrollPaddingBottom];
  root.style.scrollPaddingTop = `${coveredTop(el) + 12}px`;
  // The controller hints along the bottom cover the page too.
  root.style.scrollPaddingBottom = `${(document.querySelector(".pad-hints")?.getBoundingClientRect().height ?? 0) + 16}px`;
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: instant ? "auto" : "smooth" });
  [root.style.scrollPaddingTop, root.style.scrollPaddingBottom] = before;
}

/** An open menu, the alerts panel or a video: B and Esc close it before going back a page. */
const openPopup = () => document.querySelector('[role="dialog"], [role="menu"]');

/**
 * Where focus last was, so a press after the focused item went away (a filter changed, a list
 * reloaded, a section opened) carries on from about the same spot instead of the top of the page.
 */
let lastSpot: { path: string; rect: DOMRect } | null = null;
const remember = (el: HTMLElement) => (lastSpot = { path: location.pathname, rect: el.getBoundingClientRect() });

/** The item nearest a spot on screen. */
function nearest(items: HTMLElement[], to: DOMRect): HTMLElement | undefined {
  const cx = to.left + to.width / 2;
  const cy = to.top + to.height / 2;
  let best: HTMLElement | undefined;
  let bestD = Infinity;
  for (const el of items) {
    const r = el.getBoundingClientRect();
    const d = Math.hypot(r.left + r.width / 2 - cx, (r.top + r.height / 2 - cy) * 1.5);
    if (d < bestD) [best, bestD] = [el, d];
  }
  return best;
}

export function moveFocus(dir: Dir, repeating = false): void {
  setNavMode("pad");
  setEditing(null);
  // An open menu, alerts panel or picture keeps the d-pad inside it until B closes it.
  const popup = openPopup();
  const scope: ParentNode = popup?.querySelector(FOCUSABLE) ? popup : document;
  const items = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
  const current = document.activeElement as HTMLElement | null;
  if (!current || current === document.body || !items.includes(current)) {
    const inMain = items.filter((el) => el.closest("main"));
    const resume = !popup && lastSpot?.path === location.pathname ? nearest(inMain.length ? inMain : items, lastSpot.rect) : undefined;
    const first = resume ?? (popup ? items[0] : (inMain[0] ?? items[0]));
    if (first) {
      first.focus({ preventScroll: true });
      reveal(first, repeating);
      remember(first);
    }
    return;
  }
  const from = current.getBoundingClientRect();
  const here = zoneOf(current);
  // From the page itself, the page comes first: up through a long library goes row by row,
  // scrolling the rows above back out from under the top bar, and only reaches the menu at the top.
  const fromPage = !inStickyBar(current);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  let bestOnPage = false;
  const rects = new Map<HTMLElement, DOMRect>();
  for (const el of items) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    if (!ahead(dir, from, r)) continue;
    const onPage = fromPage && !inStickyBar(el);
    // From the top bar, a card scrolled under it is something you can't see: skip past it.
    if (!onPage && hidden(el, r) && !hidden(current, from)) continue;
    // Left and right stay in the row: off the end of the filters isn't a jump up to Sign out.
    if ((dir === "left" || dir === "right") && (r.bottom <= from.top || r.top >= from.bottom) && zoneOf(el) !== here) continue;
    rects.set(el, r);
    const sc = score(dir, from, r);
    if ((onPage && !bestOnPage) || (onPage === bestOnPage && sc < bestScore)) {
      bestScore = sc;
      best = el;
      bestOnPage = onPage;
    }
  }
  const zone = best && zoneOf(best);
  if (best && zone && zone !== here) {
    // Into another area: where you were in it last, else (for the games) the first one on screen.
    const remembered = lastInZone.get(zone);
    const first = zone.matches(".collection, [data-nav-zone]") ? items.find((el) => zoneOf(el) === zone && rects.has(el) && onScreen(rects.get(el)!) && !hidden(el, rects.get(el)!)) : undefined;
    best = remembered && remembered.isConnected && rects.has(remembered) && onScreen(rects.get(remembered)!) ? remembered : (first ?? best);
  }
  if (best) {
    if (here) lastInZone.set(here, current);
    best.focus({ preventScroll: true });
    // Smooth scrolling lags behind a held d-pad, so a held direction jumps.
    reveal(best, repeating);
    remember(best);
  }
}

/** Y: between the filters (or the top of the page) and the games, wherever focus is. */
export function switchZone(): void {
  setNavMode("pad");
  setEditing(null);
  const current = document.activeElement as HTMLElement | null;
  const zones = [...document.querySelectorAll("main .filters, main .collection, main [data-nav-zone]")];
  if (zones.length < 2) return;
  const here = current ? zones.findIndex((z) => z.contains(current)) : -1;
  if (here >= 0 && current) lastInZone.set(zones[here]!, current);
  const next = zones[(here + 1) % zones.length]!;
  const target = lastInZone.get(next);
  const el = target?.isConnected && visible(target) ? target : [...next.querySelectorAll<HTMLElement>(FOCUSABLE)].find(visible);
  el?.focus({ preventScroll: true });
  if (el) reveal(el, false);
}

/** LT and RT: the previous or next tab of the page's tab bar (Library's Installed, All games, Backlog...). */
export function switchTab(by: number): void {
  const bar = document.querySelector<HTMLElement>('main [role="tablist"]');
  const tabs = bar ? [...bar.querySelectorAll<HTMLElement>('[role="tab"]')].filter(visible) : [];
  if (tabs.length < 2) return;
  setNavMode("pad");
  setEditing(null);
  const at = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
  const next = tabs[(Math.max(0, at) + by + tabs.length) % tabs.length]!;
  next.click();
  next.focus({ preventScroll: true });
  reveal(next, false);
}

/**
 * LB and RB: the previous or next section of the top menu (Home, Library, Downloads...). The menu
 * knows its sections, including the ones folded into More, so it does the navigating.
 */
export const SECTION_EVENT = "lootden:section";
export function switchSection(by: number): void {
  setNavMode("pad");
  setEditing(null);
  window.dispatchEvent(new CustomEvent<number>(SECTION_EVENT, { detail: by }));
}

/** A or Enter on a select: change it with the d-pad until A, B or Enter again. */
export function toggleEditing(el: HTMLSelectElement): void {
  setEditing(editing === el ? null : el);
}

/** One option up or down in the select being changed, telling React about it. */
function stepSelect(el: HTMLSelectElement, by: number): void {
  const options = [...el.options];
  let i = el.selectedIndex;
  do i += by;
  while (i >= 0 && i < options.length && options[i]!.disabled);
  if (i < 0 || i >= options.length) return;
  el.selectedIndex = i;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Text boxes keep left and right for the cursor until it reaches the end of the text. Selects keep them only while being changed. */
const keepsKey = (el: Element | null, dir: Dir) => {
  if (el instanceof HTMLSelectElement) return el === editing;
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement) || ["checkbox", "radio", "button", "submit", "range"].includes(el.type) || (dir !== "left" && dir !== "right")) return false;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (start === null || end === null) return true; // number and similar inputs don't say
  return dir === "left" ? start > 0 || end > 0 : start < el.value.length || end < el.value.length;
};

const isTextField = (el: Element | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;


/** A game has the controller: the in-browser player's frame is focused, or LootDen is in the background behind an emulator. */
function padBelongsElsewhere(): boolean {
  if (document.visibilityState === "hidden" || !document.hasFocus()) return true;
  const active = document.activeElement;
  return active instanceof HTMLIFrameElement || document.fullscreenElement instanceof HTMLIFrameElement;
}

/**
 * The d-pad on a controller Chromium doesn't recognise as standard (DirectInput, some handheld
 * drivers): it arrives as one hat axis, usually the 10th, going -1 (up) clockwise to 1 (up-left).
 */
function padHat(pad: Gamepad): Dir | null {
  if (pad.mapping === "standard") return null;
  const v = pad.axes[9];
  if (v === undefined || v > 1.05) return null; // about 1.29 at rest
  const step = Math.round(((v + 1) / 2) * 7); // 0 up, 1 up-right, 2 right … 7 up-left
  return (["up", "up", "right", "down", "down", "down", "left", "up"] as const)[step] ?? null;
}

/** Controllers the browser can see right now. */
export const connectedPads = (): Gamepad[] => [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p && p.connected);

/**
 * Installs keyboard and gamepad navigation once for the whole app. onBack is read on every
 * press, so the caller can pass a fresh function without reinstalling (reinstalling used to
 * stop gamepad polling after the first page change, because "gamepadconnected" only fires once).
 */
export function installSpatialNavigation(onBack: () => void): () => void {
  const back = () => {
    const popup = openPopup();
    // The popups close on Esc themselves (Layout listens on document, the video player on window).
    if (popup) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else onBack();
  };
  const keys: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  const onKey = (e: KeyboardEvent) => {
    const el = document.activeElement;
    // Enter starts and ends changing a select with the arrows; Esc ends it too.
    if (el instanceof HTMLSelectElement && (e.key === "Enter" || (e.key === "Escape" && el === editing))) {
      e.preventDefault();
      toggleEditing(el);
      return;
    }
    // Esc goes back a page, like B. The ROG Ally sends Esc for B when Armoury Crate has LootDen in Desktop mode.
    if (e.key === "Escape" && !e.defaultPrevented && !openPopup() && !isTextField(document.activeElement) && !(document.activeElement instanceof HTMLIFrameElement)) {
      back();
      return;
    }
    const dir = keys[e.key];
    if (!dir || keepsKey(document.activeElement, dir) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (document.activeElement instanceof HTMLIFrameElement) return;
    e.preventDefault();
    moveFocus(dir, e.repeat);
  };
  window.addEventListener("keydown", onKey);
  const onFocusOut = (e: FocusEvent) => {
    if (e.target === editing) setEditing(null);
  };
  window.addEventListener("focusout", onFocusOut, true);
  // Only a real mouse move hides the box; Chromium also fires mousemove when the page scrolls under a still cursor.
  const onPointer = (e: PointerEvent | MouseEvent) => {
    if (e.type === "mousemove" && Math.abs((e as MouseEvent).movementX) + Math.abs((e as MouseEvent).movementY) < 3) return;
    setNavMode("pointer");
  };
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("mousemove", onPointer, true);

  // Gamepad polling: d-pad / left stick move, A (0) clicks, B (1) goes back, Y (3) jumps between
  // the filters and the games, the right stick scrolls, the bumpers (4, 5) switch sections of the
  // top menu, and the triggers (6, 7) switch the page's tabs.
  let frame = 0;
  const held = new Map<string, number>();
  const repeat = (id: string, pressed: boolean, action: (repeating: boolean) => void) => {
    const now = performance.now();
    const since = held.get(id);
    if (!pressed) return void held.delete(id);
    if (since === undefined) {
      held.set(id, now + 300);
      action(false);
    } else if (now > since) {
      held.set(id, now + 110);
      action(true);
    }
  };
  const activate = () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return moveFocus("down");
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el.click();
    if (el instanceof HTMLSelectElement) return toggleEditing(el);
    // Text boxes take focus for typing (the on-screen keyboard on handhelds); everything else is clicked.
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.focus();
    el.click();
  };
  const scrollBy = (dy: number) => (document.scrollingElement ?? document.documentElement).scrollBy({ top: dy });
  let idle = 0;
  const poll = () => {
    frame = 0;
    const pads = connectedPads();
    if (!pads.length) {
      // Keep looking slowly rather than wait for "gamepadconnected": Chromium doesn't always send it
      // for a pad that was already plugged in, or when Armoury Crate switches the Ally into Gamepad mode.
      idle = window.setTimeout(start, 1000);
      return;
    }
    if (padBelongsElsewhere()) held.clear();
    else
      for (const pad of pads) {
        document.documentElement.dataset.gamepad = "on";
        const [ax = 0, ay = 0, , ry = 0] = pad.axes;
        const b = (i: number) => !!pad.buttons[i]?.pressed;
        const hat = padHat(pad);
        const any = pad.buttons.some((x) => x.pressed) || Math.abs(ax) > 0.6 || Math.abs(ay) > 0.6;
        if (any) setNavMode("pad");
        // While a select is being changed the d-pad picks its options instead of moving.
        const move = (dir: Dir, by: number) => (repeating: boolean) => (editing && document.activeElement === editing ? stepSelect(editing, by) : moveFocus(dir, repeating));
        // The left stick moves along whichever way it's pushed most, so a slightly diagonal push
        // doesn't move down and sideways at once and skip past the item it was aimed at.
        const sx = Math.abs(ax) >= Math.abs(ay) ? ax : 0;
        const sy = Math.abs(ay) > Math.abs(ax) ? ay : 0;
        repeat(`${pad.index}up`, b(12) || hat === "up" || sy < -0.55, move("up", -1));
        repeat(`${pad.index}down`, b(13) || hat === "down" || sy > 0.55, move("down", 1));
        repeat(`${pad.index}left`, b(14) || hat === "left" || sx < -0.55, move("left", -1));
        repeat(`${pad.index}right`, b(15) || hat === "right" || sx > 0.55, move("right", 1));
        repeat(`${pad.index}a`, b(0), activate);
        repeat(`${pad.index}b`, b(1), () => {
          // B first stops changing a select or leaves a text box, then closes a menu or video, then goes back a page.
          const el = document.activeElement;
          if (editing && el === editing) setEditing(null);
          else if (isTextField(el) && !(el instanceof HTMLSelectElement)) (el as HTMLElement).blur();
          else back();
        });
        repeat(`${pad.index}y`, b(3), switchZone);
        repeat(`${pad.index}lt`, b(6), () => switchTab(-1));
        repeat(`${pad.index}rt`, b(7), () => switchTab(1));
        repeat(`${pad.index}lb`, b(4), () => switchSection(-1));
        repeat(`${pad.index}rb`, b(5), () => switchSection(1));
        if (pad.mapping === "standard" && Math.abs(ry) > 0.25) scrollBy(ry * 18);
      }
    frame = requestAnimationFrame(poll);
  };
  const start = () => {
    window.clearTimeout(idle);
    if (!frame) frame = requestAnimationFrame(poll);
  };
  window.addEventListener("gamepadconnected", start);
  // Polling pauses while the window is in the background, so check again on focus.
  window.addEventListener("focus", start);
  start();

  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("focusout", onFocusOut, true);
    window.removeEventListener("gamepadconnected", start);
    window.removeEventListener("focus", start);
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("mousemove", onPointer, true);
    window.clearTimeout(idle);
    cancelAnimationFrame(frame);
  };
}
