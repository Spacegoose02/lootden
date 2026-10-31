import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PC_PLATFORM, togetherLabel, type GameSummary } from "@lootden/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { bridgeError, desktop } from "../desktop";
import { Cover } from "./Cover";

type Filter = "installed" | "backlog" | "fresh" | "together" | "controller";
const FILTERS: Array<[Filter, string]> = [
  ["installed", desktop ? "On this PC" : "Installed"],
  ["backlog", "From my backlog"],
  ["fresh", "Never played"],
  ["together", "Play together"],
  ["controller", "Controller"],
];

/** The same pick all day for one person: a small hash of the date and their id. */
function dailyPick<T>(items: T[], salt: string): T | null {
  if (!items.length) return null;
  let h = 2166136261;
  for (const c of `${new Date().toDateString()}|${salt}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return items[(h >>> 0) % items.length]!;
}

/** Games, what's installed, the backlog and play history: what the roulette picks from. */
function usePool() {
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [backlog, setBacklog] = useState<Set<string>>(new Set());
  const [played, setPlayed] = useState<Set<string>>(new Set());
  useEffect(() => {
    api.games({ platform: PC_PLATFORM }).then(setGames, () => setGames([]));
    api.myGames().then(
      (s) => {
        setPlayed(new Set(s.filter((x) => x.lastPlayedAt).map((x) => x.gameId)));
        if (!desktop) setInstalled(new Set(s.filter((x) => x.installedAt && !x.uninstalledAt).map((x) => x.gameId)));
      },
      () => {},
    );
    if (desktop) void desktop.installed().then((l) => setInstalled(new Set(l.map((g) => g.gameId))), () => {});
    api.backlog().then((b) => setBacklog(new Set(b.items.filter((i) => i.status === "backlog" || i.status === "playing").map((i) => i.gameId))), () => {});
  }, []);
  return { games, installed, backlog, played };
}

/** Spin for a game: a slot-machine reel of covers that slows down on the pick. */
export function GameRoulette({ onClose }: { onClose: () => void }) {
  const { games, installed, backlog, played } = usePool();
  const [filters, setFilters] = useState<Set<Filter>>(() => new Set());
  const [reel, setReel] = useState<GameSummary[]>([]);
  const [pick, setPick] = useState<GameSummary | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [error, setError] = useState("");
  const track = useRef<HTMLDivElement>(null);
  const pool = useMemo(
    () =>
      (games ?? []).filter(
        (g) =>
          (!filters.has("installed") || installed.has(g.id)) &&
          (!filters.has("backlog") || backlog.has(g.id)) &&
          (!filters.has("fresh") || !played.has(g.id)) &&
          (!filters.has("together") || !!g.together?.length) &&
          (!filters.has("controller") || g.controllerSupport === "full" || g.controllerSupport === "partial"),
      ),
    [games, filters, installed, backlog, played],
  );
  const toggle = (f: Filter) => {
    const next = new Set(filters);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    setFilters(next);
  };
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const spin = () => {
    if (!pool.length || spinning) return;
    const chosen = pool[Math.floor(Math.random() * pool.length)]!;
    const filler = Array.from({ length: 34 }, () => pool[Math.floor(Math.random() * pool.length)]!);
    setReel([...filler, chosen, ...filler.slice(0, 3)]);
    setPick(null);
    setError("");
    setSpinning(true);
    void api.spun().catch(() => {});
    // Start at the left, then glide to the pick on the next frame.
    requestAnimationFrame(() => {
      const el = track.current;
      if (!el) return;
      el.style.transition = "none";
      el.style.transform = "translateX(0)";
      requestAnimationFrame(() => {
        const item = el.children[34] as HTMLElement | undefined;
        const box = el.parentElement!.getBoundingClientRect();
        const offset = item ? item.offsetLeft - box.width / 2 + item.offsetWidth / 2 : 0;
        el.style.transition = reduced ? "none" : "transform 3.4s cubic-bezier(0.12, 0.8, 0.18, 1)";
        el.style.transform = `translateX(${-offset}px)`;
        setTimeout(() => {
          setSpinning(false);
          setPick(chosen);
        }, reduced ? 50 : 3500);
      });
    });
  };
  const play = async (g: GameSummary) => {
    try {
      await desktop!.play(g.id);
      onClose();
    } catch (e) {
      setError(bridgeError(e));
    }
  };
  return (
    <div className="celebration" role="dialog" aria-modal="true" aria-label="Game roulette" onClick={(e) => e.target === e.currentTarget && !spinning && onClose()}>
      <div className="roulette-card">
        <p className="eyebrow">Can't decide?</p>
        <h2>Spin the roulette 🎰</h2>
        <div className="chips" role="group" aria-label="Pick from">
          {FILTERS.map(([f, label]) => (
            <button key={f} className={`chip${filters.has(f) ? " active" : ""}`} aria-pressed={filters.has(f)} onClick={() => toggle(f)} disabled={spinning}>
              {label}
            </button>
          ))}
        </div>
        <p className="muted small">{games === null ? "Loading games…" : `${pool.length} game${pool.length === 1 ? "" : "s"} in the draw`}</p>
        <div className="reel" aria-hidden={!pick}>
          <div className="reel-marker" aria-hidden="true" />
          <div className="reel-track" ref={track}>
            {(reel.length ? reel : pool.slice(0, 8)).map((g, i) => (
              <div key={`${g.id}-${i}`} className="reel-item">
                <Cover game={g} />
              </div>
            ))}
          </div>
        </div>
        {pick && (
          <div className="roulette-result" role="status">
            <strong>{pick.title}</strong>
            <span className="muted small">{[pick.releaseYear, pick.genres.slice(0, 2).join(", "), ...(pick.together ?? []).slice(0, 2).map(togetherLabel)].filter(Boolean).join(" · ")}</span>
            <div className="inline">
              {desktop && installed.has(pick.id) ? (
                <button className="primary play-big" onClick={() => void play(pick)} autoFocus>
                  ▶ Play
                </button>
              ) : (
                <Link to={`/games/${pick.id}`} className="button primary" onClick={onClose} autoFocus>
                  Open game
                </Link>
              )}
              <button className="secondary" onClick={spin}>
                Spin again
              </button>
            </div>
          </div>
        )}
        {error && <p className="error small">{error}</p>}
        <div className="inline celebration-actions">
          {!pick && (
            <button className="primary" disabled={!pool.length || spinning} onClick={spin}>
              {spinning ? "Spinning…" : "Spin!"}
            </button>
          )}
          <button className="ghost" disabled={spinning} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Home: today's pick, the same all day, and the roulette for another. */
export function GameOfTheDay() {
  const { me } = useAuth();
  const { games, installed, played } = usePool();
  const [open, setOpen] = useState(false);
  // Something not played yet if there is one, preferring games on this PC.
  const candidates = useMemo(() => {
    const all = games ?? [];
    const fresh = all.filter((g) => !played.has(g.id));
    const here = fresh.filter((g) => installed.has(g.id));
    return here.length ? here : fresh.length ? fresh : all;
  }, [games, installed, played]);
  const game = dailyPick(candidates, String(me?.user?.id ?? "guest"));
  if (!game) return null;
  return (
    <section className="row game-of-the-day">
      <div className="gotd panel">
        <Link to={`/games/${game.id}`} className="gotd-cover" tabIndex={-1} aria-hidden="true">
          <Cover game={game} />
        </Link>
        <div className="gotd-body">
          <p className="eyebrow">Game of the day ✨</p>
          <h2>
            <Link to={`/games/${game.id}`}>{game.title}</Link>
          </h2>
          <p className="muted small">
            {[game.releaseYear, game.genres.slice(0, 2).join(", "), installed.has(game.id) ? (desktop ? "on this PC" : "installed") : null, played.has(game.id) ? null : "not played yet"].filter(Boolean).join(" · ")}
          </p>
          <div className="inline">
            <Link to={`/games/${game.id}`} className="button primary">
              Check it out
            </Link>
            <button className="secondary" onClick={() => setOpen(true)}>
              🎰 Spin for another
            </button>
          </div>
        </div>
      </div>
      {open && <GameRoulette onClose={() => setOpen(false)} />}
    </section>
  );
}
