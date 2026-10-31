import { useEffect, useState, type CSSProperties } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, type Celebrations } from "../api";
import { useAuth } from "../auth";
import { desktop } from "../desktop";
import { useEscape } from "../escape";

const COLORS = ["var(--accent)", "var(--accent-2)", "#ffd84d", "#59ff8a", "#ff5470", "#a3a8ff"];

/** Confetti made of spans: no canvas, and nothing at all for people who asked for less motion (see fun.css). */
export function Confetti({ pieces = 80 }: { pieces?: number }) {
  const [bits] = useState(() =>
    Array.from({ length: pieces }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.9,
      duration: 2.2 + Math.random() * 1.8,
      drift: (Math.random() - 0.5) * 160,
      spin: (Math.random() - 0.5) * 1440,
      color: COLORS[i % COLORS.length],
      round: Math.random() < 0.3,
    })),
  );
  return (
    <div className="confetti" aria-hidden="true">
      {bits.map((b, i) => (
        <span
          key={i}
          className={b.round ? "round" : ""}
          style={
            {
              left: `${b.left}%`,
              background: b.color,
              animationDelay: `${b.delay}s`,
              animationDuration: `${b.duration}s`,
              "--drift": `${b.drift}px`,
              "--spin": `${b.spin}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

const empty = (c: Celebrations) => !c.wishes.length && !c.achievements.length && !c.bonus.length;

/**
 * Fun moments over every page: an unlock screen when a requested game arrives, new badges,
 * bonus time granted, and the app's play time heads-ups.
 */
export function FunLayer() {
  const { me } = useAuth();
  const location = useLocation();
  const [party, setParty] = useState<Celebrations | null>(null);
  const [toast, setToast] = useState<{ title: string; message: string } | null>(null);

  useEffect(() => {
    if (!me?.user) return;
    let live = true;
    const look = () =>
      void api.celebrations().then(
        (c) => live && !empty(c) && setParty((cur) => cur ?? c),
        () => {},
      );
    look();
    const t = setInterval(look, 120_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [me?.user]);

  useEffect(() => {
    if (!desktop) return;
    return desktop.onProgress((p) => {
      if (p.type === "limit") setToast({ title: p.title, message: p.message });
    });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 12_000);
    return () => clearTimeout(t);
  }, [toast]);

  const close = () => {
    if (party) void api.celebrated(party).catch(() => {});
    setParty(null);
  };
  useEscape(close, !!party);
  // Opening a game from the unlock screen counts as having seen it.
  useEffect(() => {
    if (party && location.pathname.startsWith("/games/")) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  return (
    <>
      {toast && (
        <div className="fun-toast" role="status">
          <strong>⏱️ {toast.title}</strong>
          <span>{toast.message}</span>
          <button className="ghost small" onClick={() => setToast(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      {party && (
        <div className="celebration" role="dialog" aria-modal="true" aria-label="Something new unlocked" onClick={(e) => e.target === e.currentTarget && close()}>
          <Confetti />
          <div className="celebration-card">
            {party.wishes.map((w) => (
              <div key={w.id} className="wish-granted">
                <p className="eyebrow">Wish granted!</p>
                <div className="wish-art">{w.image ? <img src={w.image} alt="" /> : <span aria-hidden="true">🎁</span>}</div>
                <h2>{w.title} is here!</h2>
                <Link className="button primary play-big" to={`/games/${w.gameId}`} onClick={close} autoFocus>
                  Let's play
                </Link>
              </div>
            ))}
            {party.bonus.length > 0 && (
              <div className="bonus-granted">
                <p className="eyebrow">Bonus time</p>
                <h2>+{party.bonus.reduce((n, b) => n + b.minutes, 0)} minutes today ⏱️</h2>
              </div>
            )}
            {party.achievements.length > 0 && (
              <div className="badges-unlocked">
                <p className="eyebrow">{party.achievements.length === 1 ? "Badge unlocked" : `${party.achievements.length} badges unlocked`}</p>
                <ul>
                  {party.achievements.slice(0, 8).map((a) => (
                    <li key={a.id} className={`tier-${a.tier}`}>
                      <span className="badge-icon" aria-hidden="true">
                        {a.icon}
                      </span>
                      <span>
                        <strong>{a.name}</strong>
                        <small className="muted">
                          {a.description} · +{a.xp} XP
                        </small>
                      </span>
                    </li>
                  ))}
                </ul>
                {party.achievements.length > 8 && <p className="muted small">and {party.achievements.length - 8} more on your profile</p>}
              </div>
            )}
            <div className="inline celebration-actions">
              {party.achievements.length > 0 && (
                <Link className="button secondary" to="/profile" onClick={close}>
                  See my badges
                </Link>
              )}
              <button className={party.wishes.length ? "ghost" : "primary"} onClick={close} autoFocus={!party.wishes.length}>
                Awesome!
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
