import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ACHIEVEMENT_SOURCES, achievementPercent, type AchievementSummary } from "@lootden/shared";
import { api, formatPlaytime, type AchievementsAnswer, type GameSessions } from "../api";

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * A game's real achievements (Steam, RetroAchievements or Xbox) for the person signed in:
 * progress, then every achievement, unlocked first. `journalId` offers "Completed 100%".
 */
export function GameAchievementsPanel({ gameId, store, journalId }: { gameId?: string; store?: { addon: string; id: string }; journalId?: string }) {
  const key = gameId ?? `${store?.addon}:${store?.id}`;
  const load = (refresh: boolean) => (gameId ? api.gameAchievements(gameId, refresh) : api.storeAchievements(store!.addon, store!.id, refresh));
  const [a, setA] = useState<AchievementsAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [marked, setMarked] = useState(false);
  const run = (refresh: boolean) => {
    setBusy(true);
    load(refresh)
      .then(setA, () => setA(null))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    setA(null);
    setShowAll(false);
    run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!a) return null;
  const g = a.achievements;
  if (!g && !a.error) {
    if (!a.wants) return null;
    return (
      <section className="panel achievements">
        <h2>Achievements</h2>
        <p className="muted small">
          Connect {ACHIEVEMENT_SOURCES[a.wants]} under <Link to="/profile#libraries">Profile, Game libraries</Link> to see your achievements for this game.
        </p>
      </section>
    );
  }
  if (!g || !g.total) {
    return a.error ? (
      <section className="panel achievements">
        <h2>Achievements</h2>
        <p className="error small">{a.error}</p>
      </section>
    ) : null;
  }
  const pct = achievementPercent(g);
  const shown = showAll ? g.items : g.items.slice(0, 24);
  const perfect = g.unlocked === g.total;
  return (
    <section className="panel achievements">
      <div className="achievements-head">
        <h2>Achievements</h2>
        <span className="muted small">
          {ACHIEVEMENT_SOURCES[g.source]} · updated {new Date(g.fetchedAt).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}
        </span>
        <button className="ghost small" disabled={busy} onClick={() => run(true)}>
          {busy ? "Checking…" : "Refresh"}
        </button>
        {g.url && (
          <a className="small muted" href={g.url} target="_blank" rel="noreferrer">
            On {ACHIEVEMENT_SOURCES[g.source]}
          </a>
        )}
      </div>
      <div className="achievement-progress" role="progressbar" aria-valuemin={0} aria-valuemax={g.total} aria-valuenow={g.unlocked} aria-label="Achievements unlocked">
        <span style={{ width: `${(g.unlocked / g.total) * 100}%` }} />
      </div>
      <p className="small">
        <strong>
          {g.unlocked} of {g.total}
        </strong>{" "}
        unlocked ({pct}%){perfect ? " 🏆 Perfect!" : ""}
        {perfect && journalId && !marked && (
          <>
            {" "}
            <button className="small" onClick={() => void api.saveJournal(journalId, { status: "completed" }).then(() => setMarked(true))}>
              Mark as Completed 100%
            </button>
          </>
        )}
        {marked && <span className="muted"> Marked Completed 100%.</span>}
      </p>
      {a.error && <p className="error small">Couldn't refresh: {a.error}</p>}
      <ul className="achievement-list">
        {shown.map((i) => (
          <li key={i.id} className={i.unlockedAt ? "unlocked" : "locked"} title={i.description}>
            {i.iconUrl ? <img src={i.iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="achievement-icon">🏅</span>}
            <span className="achievement-text">
              <strong>{i.name}</strong>
              <small className="muted">{i.description}</small>
              <small className="muted">
                {i.unlockedAt ? `Unlocked ${when(i.unlockedAt)}` : "Locked"}
                {i.rarity != null ? ` · ${i.rarity}% of players` : ""}
                {i.points ? ` · ${i.points} points` : ""}
              </small>
            </span>
          </li>
        ))}
      </ul>
      {g.items.length > shown.length && (
        <button className="ghost small" onClick={() => setShowAll(true)}>
          Show all {g.items.length}
        </button>
      )}
    </section>
  );
}

/** The person's achievements across games looked up so far, on the profile page. */
export function AchievementSummaryPanel() {
  const [s, setS] = useState<AchievementSummary | null>(null);
  useEffect(() => {
    api.myAchievements().then(setS, () => setS(null));
  }, []);
  if (!s) return null;
  if (!s.connected.length) {
    return (
      <section className="panel achievements">
        <h2>Game achievements</h2>
        <p className="muted small">Connect Steam, Xbox or RetroAchievements under Game libraries (below) and your achievements show on each game's page and here.</p>
      </section>
    );
  }
  return (
    <section className="panel achievements">
      <h2>Game achievements</h2>
      <div className="stat-tiles">
        <div className="stat-tile">
          <small className="muted">Unlocked</small>
          <strong>{s.unlocked.toLocaleString()}</strong>
        </div>
        <div className="stat-tile">
          <small className="muted">Perfect games</small>
          <strong>{s.perfectGames}</strong>
        </div>
        <div className="stat-tile">
          <small className="muted">Games tracked</small>
          <strong>{s.games.length}</strong>
        </div>
      </div>
      {s.recent.length > 0 && (
        <>
          <h3>Latest unlocks</h3>
          <ul className="achievement-list compact">
            {s.recent.map((r) => (
              <li key={`${r.title}-${r.name}-${r.unlockedAt}`} className="unlocked">
                {r.iconUrl ? <img src={r.iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="achievement-icon">🏅</span>}
                <span className="achievement-text">
                  <strong>{r.name}</strong>
                  <small className="muted">
                    {r.link ? <Link to={r.link}>{r.title}</Link> : r.title} · {when(r.unlockedAt)}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {s.games.length > 0 && (
        <>
          <h3>Progress</h3>
          <ul className="achievement-games">
            {s.games.slice(0, 20).map((g) => (
              <li key={`${g.source}-${g.sourceId}`}>
                <span>{g.link ? <Link to={g.link}>{g.title}</Link> : g.title}</span>
                <span className="achievement-progress small" aria-hidden="true">
                  <span style={{ width: `${(g.unlocked / g.total) * 100}%` }} />
                </span>
                <small className="muted">
                  {g.unlocked}/{g.total}
                  {g.unlocked === g.total ? " 🏆" : ""}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">Games show up here once their page has been opened. Open a game to check it again.</p>
    </section>
  );
}

/** Who has unlocked the most achievements in the family. */
export function FamilyAchievementBoard() {
  const [rows, setRows] = useState<Array<{ userId: number; name: string; unlocked: number; perfect: number }> | null>(null);
  useEffect(() => {
    api.familyAchievements().then(setRows, () => setRows(null));
  }, []);
  if (!rows?.length) return null;
  return (
    <section className="panel">
      <h2>Achievement hunters</h2>
      <ol className="leaderboard">
        {rows.map((r, i) => (
          <li key={r.userId}>
            <span>{["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`}</span> <strong>{r.name}</strong>{" "}
            <span className="muted small">
              {r.unlocked.toLocaleString()} unlocked{r.perfect ? ` · ${r.perfect} perfect` : ""}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** This person's sessions in one game: how often, how long, on which PC. */
export function GameSessionsPanel({ gameId }: { gameId: string }) {
  const [s, setS] = useState<GameSessions | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    api.gameSessions(gameId).then(setS, () => setS(null));
  }, [gameId]);
  if (!s?.count) return null;
  const list = all ? s.sessions : s.sessions.slice(0, 5);
  return (
    <section className="panel play-history">
      <h2>My play history</h2>
      <div className="stat-tiles">
        {(
          [
            ["Sessions", s.count.toLocaleString()],
            ["Total", formatPlaytime(s.totalSeconds)],
            ["Average", formatPlaytime(s.averageSeconds)],
            ["Longest", formatPlaytime(s.longestSeconds)],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="stat-tile">
            <small className="muted">{label}</small>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>PC</th>
            <th className="num">Played</th>
          </tr>
        </thead>
        <tbody>
          {list.map((x) => (
            <tr key={x.startedAt}>
              <td>{new Date(x.startedAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
              <td>{x.device ?? "—"}</td>
              <td className="num">{formatPlaytime(x.seconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.sessions.length > list.length && (
        <button className="ghost small" onClick={() => setAll(true)}>
          Show the last {s.sessions.length}
        </button>
      )}
      {s.firstPlayedAt && <p className="muted small">First played {when(s.firstPlayedAt)}.</p>}
    </section>
  );
}
