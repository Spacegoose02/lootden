import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { GameNight as Night, GameNightPick, User } from "@lootden/shared";
import { api, avatarUrl, type GameNightList } from "../api";
import { useAuth } from "../auth";

const when = (n: Pick<Night, "date" | "time">) =>
  `${new Date(`${n.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} at ${n.time}`;

const nextFriday = () => {
  const d = new Date();
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
};

/**
 * Family game night: pick who's playing, get games everyone can play together (installed for
 * most of them, kid-safe with kids along), and put a night on the calendar. Family goals reached
 * in Den Duty show up here as a reason to plan one.
 */
export function GameNight() {
  const { me } = useAuth();
  const [data, setData] = useState<GameNightList | null>(null);
  const [error, setError] = useState("");
  const load = () => api.gameNights().then(setData, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  return (
    <div className="game-night">
      <header className="page-head">
        <h1>🎲 Game night</h1>
        <p className="muted">Pick who's playing and LootDen finds games you can all play together.</p>
      </header>
      {data.upcoming.length > 0 && (
        <section className="row">
          <div className="row-head">
            <h2>Coming up</h2>
          </div>
          <div className="game-night-list">
            {data.upcoming.map((n) => (
              <NightCard key={n.id} night={n} canCancel={data.canPlan} onCancel={() => void api.cancelGameNight(n.id).then(load)} />
            ))}
          </div>
        </section>
      )}
      {data.canPlan ? <Planner data={data} meId={me?.user?.id ?? null} onPlanned={load} /> : !data.upcoming.length && <p className="muted">No game night planned yet. Ask a grown-up to plan one!</p>}
      {data.feed && (
        <p className="muted small">
          Calendar feed for Den Duty or any calendar app (Den Duty: Calendars, Subscribe):{" "}
          <code className="selectable">{`${location.origin}${data.feed}`}</code>{" "}
          <button className="button small ghost" onClick={() => void navigator.clipboard?.writeText(`${location.origin}${data.feed}`)}>
            Copy
          </button>{" "}
          <button
            className="button small ghost"
            onClick={() => {
              if (confirm("Make a new feed address? Calendars using the old one stop updating.")) void api.resetGameNightFeed().then(load);
            }}
          >
            New address
          </button>
        </p>
      )}
      {data.past.length > 0 && (
        <details>
          <summary>Recent game nights</summary>
          <div className="game-night-list">
            {data.past.map((n) => (
              <NightCard key={n.id} night={n} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function NightCard({ night, canCancel, onCancel }: { night: Night; canCancel?: boolean; onCancel?: () => void }) {
  return (
    <article className="panel game-night-card">
      {night.game?.coverUrl && <img src={night.game.coverUrl} alt="" className="now-playing-cover" />}
      <div>
        <h3>{night.title}</h3>
        <p>{when(night)}</p>
        {night.game && <p>{night.game.id ? <Link to={`/games/${night.game.id}`}>{night.game.title}</Link> : night.game.title}</p>}
        <p className="game-night-players">
          {night.players.map((p) => (
            <img key={p.id} src={avatarUrl(p.avatar)} alt={p.name} title={p.name} width={28} height={28} className="avatar" />
          ))}
        </p>
        {night.goal && (
          <p className="small">
            {night.goal.icon} Earned in Den Duty: {night.goal.title}
          </p>
        )}
        {night.note && <p className="muted small">{night.note}</p>}
        {canCancel && (
          <button
            className="button small ghost"
            onClick={() => {
              if (confirm(`Cancel ${night.title}?`)) onCancel?.();
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </article>
  );
}

function Planner({ data, meId, onPlanned }: { data: GameNightList; meId: number | null; onPlanned: () => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [players, setPlayers] = useState<number[]>(meId ? [meId] : []);
  const [picks, setPicks] = useState<GameNightPick[] | null>(null);
  const [game, setGame] = useState<GameNightPick | null>(null);
  const [date, setDate] = useState(nextFriday());
  const [time, setTime] = useState("19:00");
  const [note, setNote] = useState("");
  const [goalId, setGoalId] = useState<string | null>(data.goals[0]?.id ?? null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [spinning, setSpinning] = useState(false);
  useEffect(() => void api.users().then(setUsers, () => {}), []);
  useEffect(() => {
    setGame(null);
    if (!players.length) return setPicks(null);
    api.suggestGameNight(players).then(setPicks, (e: Error) => setMsg({ text: e.message, error: true }));
  }, [players.join(",")]);

  // A little drum roll, then a random pick from the top suggestions.
  const surprise = () => {
    if (!picks?.length) return;
    const top = picks.slice(0, 6);
    setSpinning(true);
    let i = 0;
    const t = setInterval(() => {
      setGame(top[i++ % top.length]!);
      if (i > 14) {
        clearInterval(t);
        setGame(top[Math.floor(Math.random() * top.length)]!);
        setSpinning(false);
      }
    }, 110);
  };

  const plan = async () => {
    try {
      await api.planGameNight({ date, time, players, gameId: game?.id ?? null, note, goalId });
      setMsg({ text: "Game night planned! 🎉" });
      setNote("");
      onPlanned();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  };

  return (
    <section className="panel game-night-planner">
      <h2>Plan a game night</h2>
      {data.goals.length > 0 && (
        <div className="notice">
          {data.goals.map((g) => (
            <label key={g.id} className="check">
              <input type="radio" name="goal" checked={goalId === g.id} onChange={() => setGoalId(g.id)} />
              {g.icon} The family reached <strong>{g.title}</strong> in Den Duty{g.reward ? ` (${g.reward})` : ""}. Celebrate with a game night!
            </label>
          ))}
          <label className="check">
            <input type="radio" name="goal" checked={goalId === null} onChange={() => setGoalId(null)} />
            Just because
          </label>
        </div>
      )}
      <h3>Who's playing?</h3>
      <div className="game-night-people">
        {users.map((u) => (
          <label key={u.id} className={`person-chip${players.includes(u.id) ? " on" : ""}`}>
            <input type="checkbox" checked={players.includes(u.id)} onChange={(e) => setPlayers(e.target.checked ? [...players, u.id] : players.filter((x) => x !== u.id))} />
            <img src={avatarUrl(u.avatar)} alt="" width={32} height={32} className="avatar" />
            {u.displayName}
          </label>
        ))}
      </div>
      {picks && (
        <>
          <div className="row-head">
            <h3>Games for {players.length === 1 ? "one" : `all ${players.length}`}</h3>
            <button className="button small" onClick={surprise} disabled={spinning || !picks.length}>
              🎰 Surprise us
            </button>
          </div>
          {!picks.length && <p className="muted">No games to play together for this group yet. Mark co-op games on their page (Play together).</p>}
          <div className="game-night-picks">
            {picks.map((g) => (
              <button key={g.id} className={`game-night-pick panel${game?.id === g.id ? " on" : ""}`} onClick={() => setGame(game?.id === g.id ? null : g)} aria-pressed={game?.id === g.id}>
                {g.coverUrl ? <img src={g.coverUrl} alt="" loading="lazy" /> : <span className="now-playing-cover blank">🎮</span>}
                <strong>{g.title}</strong>
                <small className="muted">{[...g.together, ...g.reasons].slice(0, 3).join(" · ")}</small>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="inline-form">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Day" />
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (snacks, who picks the pizza…)" maxLength={300} aria-label="Note" />
        <button className="button primary" disabled={!players.length} onClick={() => void plan()}>
          Plan it{game ? `: ${game.title}` : ""}
        </button>
      </div>
      {msg && (
        <p className={msg.error ? "error" : "notice"} role="status">
          {msg.text}
        </p>
      )}
    </section>
  );
}
