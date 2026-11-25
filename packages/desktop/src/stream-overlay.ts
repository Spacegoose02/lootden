import { STREAM_FITS, STREAM_FIT_LABELS, type StreamFit } from "@lootden/shared";

/**
 * LootDen's menu on an Xbox stream page in the built-in browser. The stream takes the whole
 * screen (the page's own full screen hides the toolbar), so this menu is how to change the
 * screen fit without a keyboard: View + Menu held for a second on a controller, a tap on the
 * small tab at the top of a touch screen (the ROG Ally, the Steam Deck), or the mouse at the top.
 *
 * It runs in a world of its own, which the page's scripts can't reach. What the person picks
 * waits in `__lootdenStreamAsks` until the browser collects it (streamAsksScript), and the
 * browser then applies the fit to every stream, so the toolbar, Ctrl+Shift+F and this menu agree.
 * Its elements go inside the page's full-screen element, since nothing else shows in full screen.
 */
export const STREAM_OVERLAY_WORLD = 1078;

export function streamOverlayScript(fit: StreamFit): string {
  const fits = STREAM_FITS.map((f) => ({ id: f, label: STREAM_FIT_LABELS[f].replace(/ \(.*\)$/, "") }));
  return `(() => {
  const FITS = ${JSON.stringify(fits)};
  const w = window;
  w.__lootdenStreamFit = ${JSON.stringify(fit)};
  w.__lootdenStreamAsks = w.__lootdenStreamAsks || [];
  if (w.__lootdenStreamMenu) return w.__lootdenStreamMenu.refresh();

  const css = document.createElement("style");
  css.textContent = \`
    #__lootden_stream { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font: 15px system-ui, sans-serif; color: #fff; }
    #__lootden_stream .tab { position: absolute; top: 0; left: 50%; transform: translateX(-50%); pointer-events: auto; padding: 4px 18px 6px; border-radius: 0 0 12px 12px; background: rgba(10, 10, 20, .55); border: 1px solid rgba(255,255,255,.2); border-top: 0; font-size: 13px; cursor: pointer; opacity: .35; transition: opacity .3s; }
    #__lootden_stream .tab:hover, #__lootden_stream.peek .tab { opacity: 1; }
    #__lootden_stream .panel { position: absolute; top: 0; left: 50%; transform: translate(-50%, -110%); transition: transform .2s; pointer-events: auto; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: center; padding: 14px 18px; max-width: 92vw; background: rgba(14, 14, 28, .94); border: 1px solid rgba(255,255,255,.18); border-top: 0; border-radius: 0 0 16px 16px; }
    #__lootden_stream.open .panel { transform: translate(-50%, 0); }
    #__lootden_stream.open .tab { display: none; }
    #__lootden_stream .panel b { width: 100%; text-align: center; font-weight: 600; }
    #__lootden_stream button { all: unset; box-sizing: border-box; min-width: 120px; min-height: 48px; padding: 10px 16px; text-align: center; border-radius: 12px; background: rgba(255,255,255,.1); border: 2px solid rgba(255,255,255,.2); cursor: pointer; }
    #__lootden_stream button[aria-pressed="true"] { background: #2ef2ff; color: #061018; border-color: #2ef2ff; }
    #__lootden_stream button.focus { outline: 3px solid #ffd23f; outline-offset: 2px; }
    #__lootden_stream .hint { width: 100%; text-align: center; font-size: 12px; opacity: .7; }
  \`;
  const root = document.createElement("div");
  root.id = "__lootden_stream";
  root.innerHTML = '<div class="tab" role="button">▾ LootDen</div><div class="panel" role="dialog" aria-label="LootDen"><b>Screen fit</b></div>';
  const tab = root.querySelector(".tab");
  let peekTimer = 0;
  const panel = root.querySelector(".panel");
  const buttons = [];
  const add = (label, run, fitId) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (fitId) b.dataset.fit = fitId;
    b.addEventListener("click", (e) => { e.stopPropagation(); run(); });
    panel.appendChild(b);
    buttons.push(b);
  };
  for (const f of FITS) add(f.label, () => { w.__lootdenStreamAsks.push("fit:" + f.id); w.__lootdenStreamFit = f.id; refresh(); }, f.id);
  add("Exit full screen", () => { close(); document.exitFullscreen && document.exitFullscreen().catch(() => {}); });
  add("Close", () => close());
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Controller: left and right to choose, A to pick, B to close. The buttons also reach the game.";
  panel.appendChild(hint);
  root.appendChild(css);

  let focus = 0;
  let isOpen = false;
  let shown = w.__lootdenStreamFit;
  function refresh() {
    // A new fit (from here, the toolbar or Ctrl+Shift+F) shows for a moment, so a change is seen.
    const label = (FITS.find((f) => f.id === w.__lootdenStreamFit) || FITS[0]).label;
    tab.textContent = "▾ LootDen · " + label;
    if (shown !== w.__lootdenStreamFit) {
      shown = w.__lootdenStreamFit;
      root.classList.add("peek");
      clearTimeout(peekTimer);
      peekTimer = setTimeout(() => root.classList.remove("peek"), 2500);
    }
    for (const b of buttons) {
      if (b.dataset.fit) b.setAttribute("aria-pressed", String(b.dataset.fit === w.__lootdenStreamFit));
      b.classList.toggle("focus", isOpen && buttons[focus] === b);
    }
    place();
  }
  function open(fromPad) {
    isOpen = true;
    root.classList.add("open");
    focus = Math.max(0, FITS.findIndex((f) => f.id === w.__lootdenStreamFit));
    padOpen = !!fromPad;
    refresh();
  }
  function close() {
    isOpen = false;
    padOpen = false;
    root.classList.remove("open");
    refresh();
  }
  // In full screen only the full-screen element shows, so the menu lives inside it.
  function place() {
    const host = document.fullscreenElement || document.documentElement;
    if (root.parentNode !== host) host.appendChild(root);
  }
  document.addEventListener("fullscreenchange", place, true);
  tab.addEventListener("click", (e) => { e.stopPropagation(); open(false); });
  tab.addEventListener("touchstart", (e) => { e.preventDefault(); e.stopPropagation(); open(false); }, { passive: false });
  document.addEventListener("keydown", (e) => {
    // Ctrl+Shift+F, for when the browser doesn't see the key before the page does.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopImmediatePropagation();
      w.__lootdenStreamAsks.push("fit:next");
    }
  }, true);
  document.addEventListener("mousemove", (e) => {
    if (e.clientY > 60) return;
    root.classList.add("peek");
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => root.classList.remove("peek"), 3000);
  }, true);
  document.addEventListener("pointerdown", (e) => { if (isOpen && !root.contains(e.target)) close(); }, true);

  // The controller: View + Menu held for a second opens the menu; while it's open the d-pad
  // (or the left stick) moves, A picks and B closes.
  let comboSince = 0;
  let padOpen = false;
  let last = {};
  function poll() {
    const pad = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find((p) => p && p.connected);
    if (pad) {
      const down = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
      const combo = down(8) && down(9);
      if (combo && !comboSince) comboSince = performance.now();
      if (!combo) comboSince = 0;
      if (comboSince && performance.now() - comboSince > 1000) {
        comboSince = Infinity;
        isOpen ? close() : open(true);
      }
      const x = pad.axes[0] || 0;
      const now = { a: down(0), b: down(1), left: down(14) || x < -0.6, right: down(15) || x > 0.6 };
      const pressed = (k) => now[k] && !last[k];
      if (isOpen && padOpen) {
        if (pressed("left")) { focus = (focus + buttons.length - 1) % buttons.length; refresh(); }
        if (pressed("right")) { focus = (focus + 1) % buttons.length; refresh(); }
        if (pressed("a")) buttons[focus].click();
        if (pressed("b")) close();
      }
      last = now;
    }
    requestAnimationFrame(poll);
  }
  requestAnimationFrame(poll);
  w.__lootdenStreamMenu = { refresh };
  refresh();
})()`;
}

/** Collects what the person picked in the stream menu since the last look. */
export const streamAsksScript = `(() => { const a = window.__lootdenStreamAsks || []; window.__lootdenStreamAsks = []; return a; })()`;
