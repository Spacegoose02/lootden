import { useState } from "react";
import type { GameSummary } from "@lootden/shared";

/** How far (as a ratio) art may be from the card's shape and still be cropped to fill it. */
const FILL_SLACK = 1.2;

type CoverGame = Pick<GameSummary, "id" | "title" | "coverUrl"> & { backgroundUrl?: string | null };

/**
 * Cover art. If the cover is missing or won't load, a crop of the game's background is
 * used, then a generated tile with the title.
 */
export function Cover({ game, size = "card" }: { game: CoverGame; size?: "card" | "hero" }) {
  // Failures are remembered per address, so one broken image doesn't blank the next game
  // shown in the same spot (the Featured banner reuses this component as it rotates).
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const fail = (url: string) => setFailed((s) => new Set(s).add(url));
  // Art that is nearly the card's shape (a 2:3 or slightly wide box scan) fills the card, cropping
  // a sliver, instead of sitting between thin blurred bars that make neighbouring cards look uneven.
  const [fills, setFills] = useState<ReadonlySet<string>>(new Set());
  const measure = (url: string, img: HTMLImageElement) => {
    if (!img.naturalWidth || !img.naturalHeight || !img.clientWidth || !img.clientHeight) return;
    const off = img.naturalWidth / img.naturalHeight / (img.clientWidth / img.clientHeight);
    if (off > 1 / FILL_SLACK && off < FILL_SLACK) setFills((s) => (s.has(url) ? s : new Set(s).add(url)));
  };

  if (game.coverUrl && !failed.has(game.coverUrl)) {
    const url = game.coverUrl;
    // The game page shows the whole image at its own shape.
    if (size === "hero") return <img className="cover cover-hero cover-natural" src={url} alt="" onError={() => fail(url)} />;
    // Cards keep one shape; art of another shape is fitted whole over a blurred copy instead of cropped.
    return (
      <div className={`cover cover-${size} cover-frame${fills.has(url) ? " cover-fill" : ""}`}>
        <span className="cover-blur" style={{ backgroundImage: `url("${url}")` }} />
        <img src={url} alt="" loading="lazy" onLoad={(e) => measure(url, e.currentTarget)} onError={() => fail(url)} />
      </div>
    );
  }
  if (game.backgroundUrl && !failed.has(game.backgroundUrl)) {
    const url = game.backgroundUrl;
    return <img className={`cover cover-${size}`} src={url} alt="" loading={size === "hero" ? undefined : "lazy"} onError={() => fail(url)} />;
  }
  let hash = 0;
  for (const c of game.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return (
    <div className={`cover cover-${size} cover-placeholder`} style={{ background: `linear-gradient(150deg, hsl(${hue} 55% 32%), hsl(${(hue + 50) % 360} 60% 18%))` }}>
      <span>{game.title}</span>
    </div>
  );
}
