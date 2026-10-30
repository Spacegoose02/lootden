import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { GameSummary } from "@lootden/shared";
import { Badges } from "./Badges";
import { Cover } from "./Cover";
import { VersionTag } from "./VersionTag";

export function GameCard({ game }: { game: GameSummary }) {
  return (
    <Link to={`/games/${game.id}`} className="card" aria-label={game.title}>
      <Cover game={game} />
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
      <h2>{title}</h2>
      {note && <p className="muted small row-note">{note}</p>}
      <div className="row-track">
        {games.map((g) => (
          <GameCard key={g.id} game={g} />
        ))}
      </div>
    </section>
  );
}
