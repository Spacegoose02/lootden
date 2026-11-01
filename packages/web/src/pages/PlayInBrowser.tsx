import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { platformFor, secondsLeft, type Allowance, type GameDetail } from "@lootden/shared";
import { api } from "../api";

/** Time to save before a hard stop closes the game, as in the desktop app. */
const GRACE_SECONDS = 60;

/**
 * Plays an emulated game in the browser. Saves sync with the desktop app through the player's
 * save backups. Play time counts like the app's: limits and bedtime apply, and the session is
 * recorded when the page closes.
 */
export function PlayInBrowser() {
  const { id = "" } = useParams();
  const [game, setGame] = useState<GameDetail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [closed, setClosed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    api.game(id).then(setGame, (e: Error) => setError(e.message));
  }, [id]);

  // Today's allowance first: out of time or past bedtime, the game doesn't start.
  const [today, setToday] = useState<Allowance | null | undefined>(undefined);
  useEffect(() => {
    api.allowance().then(setToday, () => setToday(null));
  }, []);
  const blocked = today && today.limited && !today.canPlay ? (today.reason ?? "No play time left today") : "";
  // Waits for the game too: a PS2 game's page may need loading again first (below).
  const running = game !== null && today !== undefined && !blocked && !closed;

  // While it runs: heads-ups, then time's up (and with a hard stop, closed after a minute to save).
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = true;
      const seconds = Math.round((Date.now() - started) / 1000);
      if (seconds < 1) return;
      void fetch("/api/me/activity", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: id, device: "Browser", event: "played", seconds, endedAt: new Date().toISOString() }),
      }).catch(() => {});
    };
    let upAt: number | null = null;
    const warned = new Set<number>();
    const check = async () => {
      const a = await api.allowance().catch(() => null);
      if (!a?.limited) return;
      // The server doesn't count this session yet.
      const used = (Date.now() - started) / 1000;
      const left = secondsLeft({ ...a, remainingSeconds: a.remainingSeconds === null ? null : a.remainingSeconds - used });
      if (left === null) return;
      if (left > 0) {
        upAt = null;
        const m = [10, 5, 1].find((x) => left <= x * 60 && !warned.has(x));
        if (m) {
          [10, 5, 1].filter((x) => left <= x * 60).forEach((x) => warned.add(x));
          setNotice(`${Math.max(1, Math.ceil(left / 60))} minute${left > 60 ? "s" : ""} of play time left. Time to find a save point!`);
        }
        return;
      }
      if (upAt === null) {
        upAt = Date.now();
        setNotice(a.hardStop ? `Time's up! Save your game now: it closes in ${GRACE_SECONDS} seconds.` : "That's today's play time. Save and take a break!");
        frame.current?.contentWindow?.postMessage("lootden:save", location.origin);
      } else if (a.hardStop && Date.now() - upAt >= GRACE_SECONDS * 1000) {
        // Removing the frame saves once more (the player uploads on pagehide).
        setClosed(true);
        setNotice(a.reason ?? "That's all the play time for today.");
      }
    };
    const t = setInterval(() => void check(), 20_000);
    void check();
    window.addEventListener("pagehide", report);
    return () => {
      clearInterval(t);
      window.removeEventListener("pagehide", report);
      report();
    };
  }, [running, id]);

  if (error) return <p className="error">{error}</p>;
  const ps2 = Boolean(game && platformFor(game.platform).browserPlayer);
  // PS2 (TabStationToo) needs this page cross-origin isolated, which only a full page load from the
  // server gives. Arriving here by an in-app link, load the page again once.
  // A reload within the last 10 seconds that didn't isolate it won't do better: show the emulator's own message.
  if (ps2 && !self.crossOriginIsolated && Date.now() - Number(sessionStorage.getItem("lootden-isolate") ?? 0) > 10_000) {
    sessionStorage.setItem("lootden-isolate", String(Date.now()));
    location.reload();
    return null;
  }
  return (
    <div className="play-browser">
      <div className="inline play-bar">
        {/* This page is cross-origin isolated for PS2: leave it with a full page load so the rest of LootDen isn't. */}
        {ps2 ? (
          <a href={`/games/${id}`} className="button">
            ← Back
          </a>
        ) : (
          <Link to={`/games/${id}`} className="button">
            ← Back
          </Link>
        )}
        <strong>{game?.title}</strong>
        {game && (
          <span className="muted small">
            {platformFor(game.platform).name} in the browser ·{" "}
            {ps2 ? "experimental · memory cards stay in this browser · click the TV to give it the keyboard" : "your save syncs with the desktop app · click the game to give it the controller"}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!ps2 && (
          <button disabled={!running} onClick={() => frame.current?.contentWindow?.postMessage("lootden:save", location.origin)}>
            Sync save now
          </button>
        )}
        <button disabled={!running} onClick={() => frame.current?.requestFullscreen()}>Fullscreen</button>
      </div>
      {notice && (
        <p className="panel" role="status">
          ⏱️ {notice}
        </p>
      )}
      {blocked ? (
        <p className="panel">🌙 {blocked}</p>
      ) : running ? (
        /* Focused so keys and the controller go to the game, not LootDen's menus. */
        <iframe ref={frame} onLoad={() => frame.current?.focus()} className="play-frame" src={`/api/games/${id}/play`} title={game?.title ?? "Game"} allow="fullscreen; gamepad; autoplay; cross-origin-isolated" allowFullScreen />
      ) : today === undefined ? (
        <p className="muted">Loading…</p>
      ) : null}
    </div>
  );
}
