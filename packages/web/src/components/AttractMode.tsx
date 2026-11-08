import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { GameInfo, GameSummary } from "@lootden/shared";
import { api } from "../api";
import { connectedPads, PAD_EVENT } from "../gamepad";
import { t } from "../i18n";
import { mediaPrefs } from "../prefs";
import { previewFor, TrailerVideo } from "./GameManuals";

/** How long one game stays up when its trailer doesn't end first (or it has none). */
const SLIDE_MS = 40_000;
const STILL_MS = 9_000;

/** A fingerprint of every pad's buttons and sticks, so any touch counts as someone being there. */
function padState(): string {
  return connectedPads()
    .map((p) => p.buttons.map((b) => (b.pressed ? 1 : 0)).join("") + p.axes.map((a) => (Math.abs(a) > 0.3 ? Math.sign(a) : 0)).join(""))
    .join("|");
}

/**
 * Attract mode, like an arcade cabinet or Big Box: when the app sits idle with a controller,
 * trailers from the library play full screen (muted) until someone touches anything.
 */
export function AttractMode() {
  const [active, setActive] = useState(false);
  const location = useLocation();
  const last = useRef(Date.now());
  const busy = location.pathname.startsWith("/play/") || location.pathname.startsWith("/login");

  useEffect(() => {
    const touch = () => {
      last.current = Date.now();
      setActive(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".attract")) {
        e.preventDefault();
        e.stopPropagation();
      }
      touch();
    };
    const onPad = (e: Event) => {
      if (document.querySelector(".attract")) e.preventDefault();
      touch();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", touch, true);
    window.addEventListener("pointermove", touch, true);
    window.addEventListener("wheel", touch, true);
    window.addEventListener(PAD_EVENT, onPad);
    let seen = padState();
    const tick = setInterval(() => {
      const now = padState();
      if (now !== seen) {
        seen = now;
        touch();
        return;
      }
      const minutes = mediaPrefs().attractMinutes;
      const pad = document.documentElement.dataset.nav === "pad";
      if (minutes > 0 && pad && !busy && !document.hidden && Date.now() - last.current > minutes * 60_000) setActive(true);
    }, 500);
    return () => {
      clearInterval(tick);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", touch, true);
      window.removeEventListener("pointermove", touch, true);
      window.removeEventListener("wheel", touch, true);
      window.removeEventListener(PAD_EVENT, onPad);
    };
  }, [busy]);

  return active ? <Attract /> : null;
}

function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function Attract() {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [at, setAt] = useState(0);
  const [trailer, setTrailer] = useState<GameInfo["trailer"] | undefined>(undefined);

  useEffect(() => {
    void api.games({ sort: "added", order: "desc" }).then(
      (all) => setGames(shuffle(all.filter((g) => g.kind === "game" && g.coverUrl)).slice(0, 40)),
      () => setGames([]),
    );
  }, []);

  const game = games.length ? games[at % games.length] : null;
  useEffect(() => {
    if (!game) return;
    let live = true;
    setTrailer(undefined);
    void previewFor(game.id).then((tr) => live && setTrailer(tr));
    return () => {
      live = false;
    };
  }, [game]);

  // A game with no trailer shows its art for a few seconds; a trailer plays to its end (or SLIDE_MS).
  useEffect(() => {
    if (!game || trailer === undefined) return;
    const next = setTimeout(() => setAt((n) => n + 1), trailer ? SLIDE_MS : STILL_MS);
    return () => clearTimeout(next);
  }, [game, trailer]);

  return (
    <div className="attract" role="dialog" aria-label={t("Attract mode")}>
      {game && (
        <>
          {trailer ? (
            <div className="attract-video">
              <TrailerVideo trailer={trailer} title={game.title} preview onEnded={() => setAt((n) => n + 1)} />
            </div>
          ) : (
            <div className="attract-still" style={{ backgroundImage: `url("${game.coverUrl}")` }} />
          )}
          <div className="attract-caption">
            {game.coverUrl && <img src={game.coverUrl} alt="" />}
            <div>
              <h2>{game.title}</h2>
              <p className="muted">
                {[game.releaseYear, game.genres.slice(0, 2).join(", ")].filter(Boolean).join(" · ")}
              </p>
            </div>
          </div>
        </>
      )}
      <p className="attract-hint">{t("Press any button")}</p>
    </div>
  );
}
