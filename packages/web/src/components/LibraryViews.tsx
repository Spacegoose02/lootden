import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { GameSummary } from "@lootden/shared";
import { api, BACKLOG, BACKLOG_LABELS, formatBytes, formatPlaytime, type BacklogData, type BacklogStatus, type LibraryStatsDetail } from "../api";
import { useAuth } from "../auth";
import { Cover } from "./Cover";
import { GameGrid } from "./GameCard";
import { useStoreGames } from "./StoreGameCard";

/** The profile's games by status, and "Pick something for me". */
export function Backlog() {
  const { me } = useAuth();
  const [data, setData] = useState<BacklogData | null>(null);
  const [status, setStatus] = useState<BacklogStatus>("backlog");
  const [error, setError] = useState("");
  useEffect(() => {
    if (me?.user) api.backlog().then(setData, (e: Error) => setError(e.message));
  }, [me]);
  if (!me?.user) return <p className="muted">The backlog belongs to a profile; sign in with a personal account.</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const games = data.items.filter((i) => i.status === status).map((i) => i.game);
  return (
    <div className="backlog">
      <Roulette />
      <div className="segmented wrap" role="tablist" aria-label="Status">
        {BACKLOG.map((s) => (
          <button key={s} role="tab" aria-selected={status === s} className={status === s ? "active" : ""} onClick={() => setStatus(s)}>
            {BACKLOG_LABELS[s]} <span className="muted">{data.counts[s] ?? 0}</span>
          </button>
        ))}
      </div>
      {games.length ? (
        <GameGrid games={games} />
      ) : (
        <p className="muted">
          Nothing marked {BACKLOG_LABELS[status]} yet. Open a game and pick a status under My journal.
          {status === "backlog" && data.unsorted > 0 ? ` ${data.unsorted} PC games haven't been played or sorted; the picker uses those until you add some.` : ""}
        </p>
      )}
    </div>
  );
}

function Roulette() {
  const [pick, setPick] = useState<{ game: GameSummary; from: string; poolSize: number } | null>(null);
  const [controller, setController] = useState(false);
  const [error, setError] = useState("");
  const [spinning, setSpinning] = useState(false);
  const spin = async () => {
    setSpinning(true);
    setError("");
    try {
      const [r] = await Promise.all([api.roulette("backlog", controller), new Promise((ok) => setTimeout(ok, 450))]);
      setPick(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSpinning(false);
    }
  };
  return (
    <section className="panel roulette">
      <div>
        <h2>Can't decide?</h2>
        <p className="muted small">A random game from your backlog, or from games nobody here has played yet when the backlog is empty.</p>
        <span className="inline wrap">
          <button className="primary" disabled={spinning} onClick={() => void spin()}>
            {spinning ? "Picking…" : pick ? "Spin again" : "Pick something for me"}
          </button>
          <label className="check small">
            <input type="checkbox" checked={controller} onChange={(e) => setController(e.target.checked)} />
            Controller games only
          </label>
        </span>
        {error && <p className="error small">{error}</p>}
      </div>
      {pick && (
        <Link to={`/games/${pick.game.id}`} className={`roulette-pick${spinning ? " spinning" : ""}`}>
          <Cover game={pick.game} />
          <span>
            <strong>{pick.game.title}</strong>
            <small className="muted">
              1 of {pick.poolSize} {pick.from === "unplayed" ? "unplayed games" : "in your backlog"}
            </small>
          </span>
        </Link>
      )}
    </section>
  );
}

/** Horizontal bars, each scaled to the largest value. */
function Bars({ rows, format = String }: { rows: Array<{ label: string; value: number; to?: string }>; format?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="bar-label" title={r.label}>
            {r.to ? <Link to={r.to}>{r.label}</Link> : r.label}
          </span>
          <span className="bar-track">
            <span className="bar" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="bar-value">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Vertical columns for a time series. */
function Columns({ rows }: { rows: Array<{ label: string; value: number; title: string }> }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="columns" role="img" aria-label={rows.map((r) => `${r.title}: ${r.value}`).join(", ")}>
      {rows.map((r) => (
        <div key={r.title} className="column" title={`${r.title}: ${r.value}`}>
          <span className="column-value">{r.value || ""}</span>
          <span className="column-bar" style={{ height: `${(r.value / max) * 100}%` }} />
          <small>{r.label}</small>
        </div>
      ))}
    </div>
  );
}

export function Stats() {
  const [s, setS] = useState<LibraryStatsDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.libraryStats().then(setS, (e: Error) => setError(e.message));
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!s) return <p className="muted">Loading…</p>;
  const totalPlay = s.playtime.reduce((n, p) => n + p.seconds, 0);
  const tiles: Array<[string, string]> = [
    ["Games", s.gameCount.toLocaleString()],
    ["On disk", formatBytes(s.totalBytes)],
    ["Played", totalPlay ? formatPlaytime(totalPlay) : "–"],
    ["Average rating", s.averageRating != null ? `${s.averageRating}/100` : "–"],
    ["Controller ready", `${s.controller.full + s.controller.partial}`],
    ["Family friendly", `${s.kidSafe}`],
  ];
  return (
    <div className="stats">
      <div className="stat-tiles">
        {tiles.map(([label, value]) => (
          <div key={label} className="stat-tile">
            <small className="muted">{label}</small>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="stat-grid">
        <section className="panel">
          <h2>Added in the last year</h2>
          <Columns rows={s.addedByMonth.map((m) => ({ label: new Date(`${m.month}-15`).toLocaleDateString(undefined, { month: "short" }), value: m.count, title: m.month }))} />
        </section>
        <section className="panel">
          <h2>Platforms</h2>
          <Bars rows={s.platforms.map((p) => ({ label: p.name, value: p.count, to: p.id === "pc" ? "/library" : `/emulation/${p.id}` }))} />
        </section>
        <section className="panel">
          <h2>Genres</h2>
          {s.genres.length ? <Bars rows={s.genres.map((g) => ({ label: g.name, value: g.count, to: `/library?genre=${encodeURIComponent(g.name)}` }))} /> : <p className="muted small">No genres until metadata is matched.</p>}
        </section>
        <section className="panel">
          <h2>Release years</h2>
          {s.releaseYears.length ? <Columns rows={s.releaseYears.map((y) => ({ label: `${String(y.from).slice(2)}`, value: y.count, title: `${y.from}–${y.from + 4}` }))} /> : <p className="muted small">No release years yet.</p>}
        </section>
        <section className="panel">
          <h2>Most played</h2>
          {s.mostPlayed.length ? <Bars rows={s.mostPlayed.map((g) => ({ label: g.title, value: g.seconds, to: `/games/${g.id}` }))} format={formatPlaytime} /> : <p className="muted small">Play time comes from the desktop app.</p>}
        </section>
        <section className="panel">
          <h2>Biggest games</h2>
          <Bars rows={s.biggest.map((g) => ({ label: g.title, value: g.bytes, to: `/games/${g.id}` }))} format={formatBytes} />
        </section>
        <StoreStats />
        {s.playtime.length > 1 && (
          <section className="panel">
            <h2>Play time by profile</h2>
            <Bars rows={s.playtime.map((p) => ({ label: p.name, value: p.seconds }))} format={formatPlaytime} />
          </section>
        )}
        {s.backlog && (
          <section className="panel">
            <h2>My backlog</h2>
            <Bars rows={BACKLOG.map((b) => ({ label: BACKLOG_LABELS[b], value: s.backlog![b] ?? 0, to: "/library?tab=backlog" }))} />
          </section>
        )}
      </div>
    </div>
  );
}

/** Stats: the games on connected stores, and the play time they report, by store. */
function StoreStats() {
  const { games } = useStoreGames();
  if (!games?.length) return null;
  const by = new Map<string, { count: number; seconds: number }>();
  for (const g of games) {
    const b = by.get(g.store) ?? { count: 0, seconds: 0 };
    b.count++;
    b.seconds += g.playtimeSeconds ?? 0;
    by.set(g.store, b);
  }
  const rows = [...by.entries()].sort((a, b) => b[1].count - a[1].count);
  const played = rows.filter(([, b]) => b.seconds > 0);
  const top = games.filter((g) => g.playtimeSeconds).sort((a, b) => b.playtimeSeconds! - a.playtimeSeconds!).slice(0, 8);
  return (
    <>
      <section className="panel">
        <h2>Other stores</h2>
        <Bars rows={rows.map(([store, b]) => ({ label: store, value: b.count, to: "/library?tab=all&source=stores" }))} />
        {played.length > 0 && <p className="muted small">Play time there: {played.map(([store, b]) => `${store} ${formatPlaytime(b.seconds)}`).join(" · ")}</p>}
      </section>
      {top.length > 0 && (
        <section className="panel">
          <h2>Most played on other stores</h2>
          <Bars rows={top.map((g) => ({ label: `${g.title} (${g.store})`, value: g.playtimeSeconds! }))} format={formatPlaytime} />
        </section>
      )}
    </>
  );
}
