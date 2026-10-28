import { useEffect, useState } from "react";
import type { GameInfo } from "@lootden/shared";

/** A game's trailer and screenshots (with a lightbox), from its IGDB, RAWG or Steam details. */
export function GameMedia({ game }: { game: Pick<GameInfo, "name" | "trailer" | "screenshots"> }) {
  const [shot, setShot] = useState<string | null>(null);
  const at = shot ? game.screenshots.indexOf(shot) : -1;
  const step = (by: number) => setShot(game.screenshots[(at + by + game.screenshots.length) % game.screenshots.length] ?? null);
  // Esc, and B on a controller (sent as Esc while a dialog is open), close the big screenshot.
  useEffect(() => {
    if (!shot) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setShot(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shot]);
  return (
    <>
      {game.trailer && (
        <section className="row">
          <h2>Trailer</h2>
          <div className="video-frame trailer">
            {"youtubeId" in game.trailer ? (
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${game.trailer.youtubeId}?rel=0`}
                title={`${game.name} trailer`}
                allow="encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
              />
            ) : (
              <video src={game.trailer.url} poster={game.trailer.poster ?? undefined} controls preload="none" />
            )}
          </div>
        </section>
      )}

      {game.screenshots.length > 0 && (
        <section className="row">
          <h2>Screenshots</h2>
          <div className="screenshots">
            {game.screenshots.map((s) => (
              <button key={s} className="screenshot" onClick={() => setShot(s)}>
                <img src={s} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        </section>
      )}

      {shot && (
        // Buttons so a controller can page through the screenshots and close them: the d-pad stays inside the picture while it's open.
        <div className="lightbox" role="dialog" aria-label="Screenshot" onClick={() => setShot(null)}>
          <img className="lightbox-image" src={shot} alt="" />
          <div className="lightbox-nav" onClick={(e) => e.stopPropagation()}>
            {game.screenshots.length > 1 && (
              <button className="secondary" aria-label="Previous screenshot" onClick={() => step(-1)}>
                ‹
              </button>
            )}
            <span className="muted small">
              {at + 1} / {game.screenshots.length}
            </span>
            {game.screenshots.length > 1 && (
              <button className="secondary" aria-label="Next screenshot" onClick={() => step(1)}>
                ›
              </button>
            )}
            <button className="ghost" onClick={() => setShot(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
