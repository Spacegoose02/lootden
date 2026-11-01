import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { playedFor, type GameNight as GameNightType, type NowPlaying } from "@lootden/shared";
import { api, avatarUrl } from "../api";
import { useLive } from "../live";

const QUICK_MESSAGES = ["Dinner time!", "5 more minutes, then save your game", "Time for homework", "Come say goodnight"];

const minutesLeft = (s: number) => {
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
};

/**
 * "Playing now" on Home: who plays what, on which PC, for how long, with play time left.
 * Grown-ups (admins) can send a message to that PC, add time or close the game.
 */
export function NowPlayingStrip() {
  const [list, setList] = useState<NowPlaying[] | null>(null);
  const [, tick] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const load = () => api.nowPlaying().then(setList, () => setList([]));
  useLive("playing", () => void load());
  useEffect(() => {
    void load();
    // Minutes played and left move on their own; the list itself arrives by live events.
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    const refresh = setInterval(() => void load(), 120_000);
    return () => {
      clearInterval(t);
      clearInterval(refresh);
    };
  }, []);
  if (!list?.length) return null;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setNote({ text: done });
      setOpen(null);
      void load();
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    }
  };

  return (
    <section className="row now-playing" aria-label="Playing now">
      <div className="row-head">
        <h2>
          <span className="live-dot" aria-hidden="true" /> Playing now
        </h2>
        {note && (
          <span className={note.error ? "error small" : "muted small"} role="status">
            {note.text}
          </span>
        )}
      </div>
      <div className="now-playing-list">
        {list.map((p) => {
          const key = `${p.device}|${p.gameId}|${p.userId}`;
          // The server's time left was worked out when it answered; keep counting down.
          const left = p.remainingSeconds === null ? null : Math.max(0, p.remainingSeconds - (Date.now() - fetchedAt(list)) / 1000);
          const cover = p.coverUrl ? <img src={p.coverUrl} alt="" loading="lazy" className="now-playing-cover" /> : <span className="now-playing-cover blank" aria-hidden="true">🎮</span>;
          return (
            <article key={key} className="now-playing-card panel">
              {p.href ? (
                <Link to={p.href} tabIndex={-1}>
                  {cover}
                </Link>
              ) : (
                cover
              )}
              <div className="now-playing-body">
                <p className="now-playing-who">
                  <img src={avatarUrl(p.avatar)} alt="" width={28} height={28} className="avatar" />
                  <strong>{p.name}</strong>
                </p>
                <p className="now-playing-title">{p.href ? <Link to={p.href}>{p.title}</Link> : p.title}</p>
                <p className="muted small">
                  {[p.store, p.device, playedFor(p.startedAt)].filter(Boolean).join(" · ")}
                </p>
                {left !== null && <p className={`small ${left < 600 ? "warn-text" : "muted"}`}>{minutesLeft(left)}</p>}
                {p.canControl && (
                  <div className="now-playing-actions">
                    <button className="button small" onClick={() => setOpen(open === key ? null : key)} aria-expanded={open === key}>
                      Message
                    </button>
                    <button className="button small" onClick={() => void run(() => api.bonusNow(p.userId, 15), `Gave ${p.name} 15 more minutes`)}>
                      +15 min
                    </button>
                    {p.gameId && (
                      <button
                        className="button small danger"
                        onClick={() => {
                          if (confirm(`Close ${p.title} on ${p.device}? ${p.name} gets a minute's warning to save.`)) void run(() => api.closeOnPc(p.device, p.gameId), `Closing ${p.title} in a minute`);
                        }}
                      >
                        Close game
                      </button>
                    )}
                  </div>
                )}
                {open === key && <MessageForm onSend={(text) => run(() => api.messagePc(p.device, text), `Sent to ${p.device}`)} />}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** When the list arrived, for counting time left down between refreshes. */
const arrived = new WeakMap<object, number>();
function fetchedAt(list: object): number {
  if (!arrived.has(list)) arrived.set(list, Date.now());
  return arrived.get(list)!;
}

function MessageForm({ onSend }: { onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  return (
    <form
      className="now-playing-message"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void onSend(text.trim());
      }}
    >
      <div className="chips">
        {QUICK_MESSAGES.map((m) => (
          <button key={m} type="button" className="chip" onClick={() => void onSend(m)}>
            {m}
          </button>
        ))}
      </div>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Or type a message" maxLength={160} aria-label="Message" />
      <button className="button small primary" type="submit" disabled={!text.trim()}>
        Send
      </button>
    </form>
  );
}

/** Home: the next game night, as a one-line banner. */
export function NextGameNight() {
  const [next, setNext] = useState<GameNightType | null>(null);
  useEffect(() => void api.gameNights().then((d) => setNext(d.upcoming[0] ?? null), () => {}), []);
  if (!next) return null;
  const day = new Date(`${next.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  return (
    <Link to="/game-night" className="next-game-night panel">
      <span aria-hidden="true">🎲</span>
      <span>
        <strong>{next.title}</strong> · {day} at {next.time}
        {next.game ? ` · ${next.game.title}` : ""}
      </span>
      <span className="game-night-players">
        {next.players.map((p) => (
          <img key={p.id} src={avatarUrl(p.avatar)} alt={p.name} title={p.name} width={24} height={24} className="avatar" />
        ))}
      </span>
    </Link>
  );
}
