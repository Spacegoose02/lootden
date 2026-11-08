import { useEffect, useRef, useState } from "react";
import { bridgeError, desktop, type OverlayState } from "../desktop";
import { feel } from "../feedback";
import { HELPER_EVENT } from "../gamepad";
import { useHelperGame } from "../helperGame";
import { formatPlaytime } from "../api";
import { OverlayChat } from "./OverlayChat";
import { PadGlyph } from "./PadHints";
import { t } from "../i18n";

type Running = OverlayState["games"][number];

/** Bandit's idea of the game: a LootDen game by id, another store's by its key. */
function helperRef(g: Running | null) {
  if (!g) return null;
  const store = /^store:([^:]+):(.+)$/.exec(g.gameId);
  if (store) return { ref: { store: { addon: store[1]!, id: store[2]!, title: g.title } }, title: g.title };
  if (g.gameId.startsWith("roblox:")) return null;
  return { ref: { gameId: g.gameId }, title: g.title };
}

function since(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? "just started" : `${formatPlaytime(s)} this session`;
}

/**
 * The in-game menu: the desktop app brings LootDen up over a running game when View + Menu (or
 * the Xbox button) is held, and this is what it shows. Bandit opens over it with the game
 * already picked, and B goes back to the game.
 */
export function GameOverlay() {
  const [state, setState] = useState<OverlayState | null>(null);
  const [pick, setPick] = useState(0);
  const [confirmClose, setConfirmClose] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!desktop?.onOverlay) return;
    void desktop.overlay?.("state").then((s) => s && "open" in s && setState(s), () => {});
    return desktop.onOverlay((s) => {
      setState(s);
      setConfirmClose(false);
      setError("");
      if (s.open) {
        setPick(0);
        feel("open");
      }
    });
  }, []);

  const open = !!state?.open;
  const game = open ? (state!.games[Math.min(pick, state!.games.length - 1)] ?? null) : null;
  useHelperGame(helperRef(game));

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    setNow(Date.now());
    // Resume is selected, so A goes straight back to the game.
    setTimeout(() => box.current?.querySelector<HTMLElement>(".overlay-resume")?.focus({ preventScroll: true }), 0);
    // B or Esc: back to the game, unless Bandit or the keyboard is open over the menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".bandit-panel, .osk, .quick-sheet")) return;
      e.preventDefault();
      void desktop?.overlay?.("resume");
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearInterval(t);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open || !desktop?.overlay) return null;
  type Action = "state" | "resume" | "dismiss" | "pause" | "screenshot" | "close" | "browser";
  const run = (action: Action, id?: string) => async () => {
    setError("");
    try {
      const r = await desktop!.overlay!(action, id);
      if (action === "pause" && r && "suspended" in r) setState((s) => (s ? { ...s, paused: r.suspended ? [...s.paused, r.gameId] : s.paused.filter((x) => x !== r.gameId) } : s));
    } catch (e) {
      setError(bridgeError(e));
    }
  };
  const ownGame = game && (game.source === "lootden" || game.source === "emulated");
  const paused = !!game && state!.paused.includes(game.gameId);

  return (
    <div className="overlay-backdrop">
      <div className="game-overlay panel" role="dialog" aria-modal="true" aria-label="In-game menu" ref={box}>
        <header className="overlay-head">
          <div>
            <small className="muted">{game ? (paused ? "Paused" : "Playing") : "Nothing running"}</small>
            <h2>{game?.title ?? "LootDen"}</h2>
            {game && (
              <p className="muted small">
                {[game.store, since(game.startedAt, now)].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
          <time className="overlay-clock">{new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
        </header>

        {state!.games.length > 1 && (
          <div className="segmented" role="radiogroup" aria-label="Running games">
            {state!.games.map((g, i) => (
              <button key={g.gameId} role="radio" aria-checked={i === pick} className={i === pick ? "active" : ""} onClick={() => setPick(i)}>
                {g.title}
              </button>
            ))}
          </div>
        )}

        <div className="overlay-actions">
          <button className="primary overlay-resume" onClick={run("resume")}>
            ▶ {t("Back to the game")}
          </button>
          {ownGame && (
            <button onClick={run("pause", game!.gameId)}>{paused ? "▶ Carry on (unpause)" : "⏸ Pause the game"}</button>
          )}
          <button
            onClick={() => {
              window.dispatchEvent(new Event(HELPER_EVENT));
            }}
          >
            🦝 Ask Bandit{game ? ` about ${game.title}` : ""}
          </button>
          {desktop.openBrowser && <button onClick={run("browser")}>🌐 Browser (guides, wikis)</button>}
          <button onClick={run("screenshot")}>📸 Screenshot for the family wall</button>
          <button onClick={run("dismiss")}>🏠 Stay in LootDen</button>
          {game &&
            (confirmClose ? (
              <button className="danger" onClick={run("close", game.gameId)}>
                Yes, close {game.title} now (unsaved progress is lost)
              </button>
            ) : (
              <button className="ghost" onClick={() => setConfirmClose(true)}>
                ✕ Close the game…
              </button>
            ))}
        </div>
        <OverlayChat />
        {error && <p className="error">{error}</p>}
        <p className="muted small overlay-foot">
          <PadGlyph button="b" /> back to the game · hold <PadGlyph button="view" />
          <PadGlyph button="menu" /> in a game to open this menu
        </p>
      </div>
    </div>
  );
}
