import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Link } from "react-router-dom";
import type { GameInfo, GameSummary } from "@lootden/shared";
import { mediaPrefs } from "../prefs";
import { previewFor, TrailerVideo } from "./GameManuals";
import { Badges } from "./Badges";
import { Cover } from "./Cover";
import { VersionTag } from "./VersionTag";
import { t } from "../i18n";

/** Tilts the card toward the pointer and moves the light across its cover (fx.css). */
function tilt(e: PointerEvent<HTMLElement>) {
  if (e.pointerType !== "mouse") return;
  const r = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const s = e.currentTarget.style;
  s.setProperty("--mx", `${Math.round(x * 100)}%`);
  s.setProperty("--my", `${Math.round(y * 100)}%`);
  s.setProperty("--ry", `${((x - 0.5) * 10).toFixed(2)}deg`);
  s.setProperty("--rx", `${((0.5 - y) * 10).toFixed(2)}deg`);
}

function untilt(e: PointerEvent<HTMLElement>) {
  for (const v of ["--mx", "--my", "--rx", "--ry"]) e.currentTarget.style.removeProperty(v);
}

/** Names this card's cover so the browser morphs it into the game page's cover (View Transitions). */
function nameCover(e: { currentTarget: HTMLElement }) {
  document.querySelectorAll<HTMLElement>("[data-vt-cover]").forEach((el) => {
    el.style.viewTransitionName = "";
    delete el.dataset.vtCover;
  });
  const cover = e.currentTarget.querySelector<HTMLElement>(".cover");
  if (!cover) return;
  cover.style.viewTransitionName = "game-cover";
  cover.dataset.vtCover = "";
}

const PREVIEW_DELAY = 900;
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The trailer, muted, over the cover once the pointer or the controller's selection rests on a card. */
function useHoverPreview(gameId: string) {
  const [trailer, setTrailer] = useState<GameInfo["trailer"]>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const on = useRef(false);
  const start = () => {
    if (!mediaPrefs().previews || reducedMotion()) return;
    on.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void previewFor(gameId).then((tr) => on.current && setTrailer(tr)), PREVIEW_DELAY);
  };
  const stop = () => {
    on.current = false;
    clearTimeout(timer.current);
    setTrailer(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { trailer, start, stop };
}

export function GameCard({ game }: { game: GameSummary }) {
  const preview = useHoverPreview(game.id);
  return (
    <Link
      to={`/games/${game.id}`}
      className={`card${preview.trailer ? " previewing" : ""}`}
      aria-label={game.title}
      viewTransition
      state={{ preview: { id: game.id, title: game.title, coverUrl: game.coverUrl } }}
      onClick={nameCover}
      onPointerMove={tilt}
      onPointerEnter={(e) => e.pointerType === "mouse" && preview.start()}
      onPointerLeave={(e) => {
        untilt(e);
        preview.stop();
      }}
      onFocus={() => document.documentElement.dataset.nav === "pad" && preview.start()}
      onBlur={preview.stop}
    >
      <Cover game={game} />
      {preview.trailer && (
        <div className="card-preview" aria-hidden="true">
          <TrailerVideo trailer={preview.trailer} title={game.title} preview />
        </div>
      )}
      <VersionTag game={game} />
      <div className="card-body">
        <div className="card-title">{game.title}</div>
        <div className="card-meta">
          {game.releaseYear ?? ""}
          {game.genres[0] ? ` · ${game.genres[0]}` : ""}
        </div>
        <Badges game={game} compact />
      </div>
    </Link>
  );
}

/** aspect: box art shape (width / height) for a console's shelf; PC covers are 3:4. */
export function GameGrid({ games, aspect }: { games: GameSummary[]; aspect?: number }) {
  return (
    <div className={`grid${aspect ? " grid-shaped" : ""}`} style={aspect ? ({ "--cover-aspect": String(aspect) } as CSSProperties) : undefined}>
      {games.map((g) => (
        <GameCard key={g.id} game={g} />
      ))}
    </div>
  );
}

/** Horizontally scrolling row with snap points; swipe on touch, arrows or d-pad elsewhere. */
export function GameRow({ title, games, note }: { title: string; games: GameSummary[]; note?: string }) {
  return (
    <section className="row">
      <h2>{t(title)}</h2>
      {note && <p className="muted small row-note">{note}</p>}
      <div className="row-track">
        {games.map((g) => (
          <GameCard key={g.id} game={g} />
        ))}
      </div>
    </section>
  );
}
