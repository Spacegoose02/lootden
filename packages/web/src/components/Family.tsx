import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RecapPlayer, WeeklyRecap } from "@lootden/shared";
import { api, avatarUrl, formatPlaytime, type PlayerCard } from "../api";
import { useAuth } from "../auth";
import { HoloCard } from "./Progress";
import { useEscape } from "../escape";
import { FamilyAchievementBoard } from "./Achievements";

const day = (d: string, opts: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
const range = (r: WeeklyRecap) => `${day(r.from, { day: "numeric", month: "short" })} to ${day(r.to, { day: "numeric", month: "short" })}`;
const MEDALS = ["🥇", "🥈", "🥉"];

/** Draws the week as a picture to share in the family chat. */
async function recapImage(r: WeeklyRecap): Promise<Blob> {
  const css = getComputedStyle(document.documentElement);
  const color = (v: string, fallback: string) => css.getPropertyValue(v).trim() || fallback;
  const accent = color("--accent", "#ff4fd8");
  const accent2 = color("--accent-2", "#2ef2ff");
  const W = 1200;
  const H = 630;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#0b0620");
  bg.addColorStop(1, "#1d0b3a");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // A laser grid floor, for the retro-futuristic look.
  g.strokeStyle = accent;
  g.globalAlpha = 0.18;
  for (let y = 420; y < H; y += 26) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }
  for (let x = -600; x < W + 600; x += 80) {
    g.beginPath();
    g.moveTo(W / 2, 400);
    g.lineTo(x, H);
    g.stroke();
  }
  g.globalAlpha = 1;
  const font = (size: number, weight = 700) => `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
  g.fillStyle = accent2;
  g.font = font(22, 600);
  g.fillText(`LOOTDEN · ${range(r).toUpperCase()}`, 60, 70);
  g.fillStyle = "#ffffff";
  g.shadowColor = accent;
  g.shadowBlur = 24;
  g.font = font(56, 800);
  g.fillText("This week in the Den", 60, 135);
  g.shadowBlur = 0;
  g.font = font(24, 500);
  g.fillStyle = "#d9d0ff";
  g.fillText([`${formatPlaytime(r.totalSeconds)} played together`, r.topGame ? `Top game: ${r.topGame.title}` : null].filter(Boolean).join("   ·   "), 60, 180);
  const load = (src: string) =>
    new Promise<HTMLImageElement | null>((ok) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => ok(null);
      img.src = src;
    });
  const players = r.players.filter((p) => p.seconds > 0).slice(0, 5);
  const avatars = await Promise.all(players.map((p) => load(avatarUrl(p.avatar))));
  players.forEach((p, i) => {
    const y = 225 + i * 78;
    g.fillStyle = i === 0 ? "rgba(255,216,77,0.16)" : "rgba(255,255,255,0.06)";
    g.beginPath();
    g.roundRect(60, y, W - 120, 66, 16);
    g.fill();
    g.font = font(30);
    g.fillStyle = "#ffffff";
    g.fillText(MEDALS[i] ?? `${i + 1}`, 80, y + 44);
    const img = avatars[i];
    if (img) g.drawImage(img, 130, y + 7, 52, 52);
    g.font = font(28);
    g.fillText(p.name, 200, y + 43);
    g.font = font(22, 500);
    g.fillStyle = "#cfc6ff";
    g.fillText([`LV ${p.level}`, p.topGame ? p.topGame.title : null].filter(Boolean).join(" · "), 470, y + 42);
    g.font = font(28);
    g.fillStyle = accent2;
    g.textAlign = "right";
    g.fillText(formatPlaytime(p.seconds), W - 84, y + 43);
    g.textAlign = "left";
  });
  if (!players.length) {
    g.font = font(30, 600);
    g.fillStyle = "#ffffff";
    g.fillText("No games played yet this week. Time to fix that!", 60, 300);
  }
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Couldn't draw the picture"))), "image/png"));
}

function PlayerRow({ p, rank, best, onOpen }: { p: RecapPlayer; rank: number; best: number; onOpen: () => void }) {
  return (
    <li className={`leader${rank === 0 && p.seconds > 0 ? " leader-top" : ""}`}>
      <span className="leader-rank">{p.seconds > 0 ? (MEDALS[rank] ?? rank + 1) : "·"}</span>
      <button className="leader-who" onClick={onOpen} title="Show their card">
        <img src={avatarUrl(p.avatar)} alt="" width={44} height={44} className="avatar" />
        <span>
          <strong>{p.name}</strong>
          <small className="muted">
            LV {p.level} {p.rank}
          </small>
        </span>
      </button>
      <span className="leader-bar" aria-hidden="true">
        <span style={{ width: `${best ? (p.seconds / best) * 100 : 0}%` }} />
      </span>
      <span className="leader-stats small">
        <strong>{formatPlaytime(p.seconds)}</strong>
        <span className="muted">
          {[
            p.games ? `${p.games} game${p.games === 1 ? "" : "s"}` : null,
            p.finished ? `${p.finished} finished` : null,
            p.badges ? `${p.badges} badge${p.badges === 1 ? "" : "s"}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "Nothing yet"}
        </span>
        {p.topGame && (p.topGame.id ? <Link to={`/games/${p.topGame.id}`}>{p.topGame.title}</Link> : <span className="muted">{p.topGame.title}</span>)}
      </span>
    </li>
  );
}

/** The household's leaderboard and weekly recap (Library, Family). */
export function FamilyRecap() {
  const { me } = useAuth();
  const [weeksAgo, setWeeksAgo] = useState(0);
  const [recap, setRecap] = useState<WeeklyRecap | null>(null);
  const [card, setCard] = useState<PlayerCard | null>(null);
  useEscape(() => setCard(null), !!card);
  const [error, setError] = useState("");
  useEffect(() => {
    setRecap(null);
    api.recap(weeksAgo).then(setRecap, (e: Error) => setError(e.message));
  }, [weeksAgo]);
  const share = async () => {
    try {
      const blob = await recapImage(recap!);
      const file = new File([blob], `lootden-week-${recap!.from}.png`, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) return void (await navigator.share({ files: [file], title: "This week in the Den" }).catch(() => {}));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const best = Math.max(0, ...(recap?.players.map((p) => p.seconds) ?? []));
  return (
    <div className="family-recap">
      <section className="panel recap-hero">
        <div>
          <p className="eyebrow">{recap ? range(recap) : "…"}</p>
          <h2>{weeksAgo === 0 ? "This week in the Den" : weeksAgo === 1 ? "Last week in the Den" : `${weeksAgo} weeks ago`}</h2>
          {recap && (
            <p className="recap-facts">
              <span>
                <strong>{formatPlaytime(recap.totalSeconds)}</strong> played
              </span>
              {recap.topGame && (
                <span>
                  Top game: <strong>{recap.topGame.id ? <Link to={`/games/${recap.topGame.id}`}>{recap.topGame.title}</Link> : recap.topGame.title}</strong>
                  {recap.topGame.players > 1 ? ` (${recap.topGame.players} players)` : ""}
                </span>
              )}
              {recap.busiestDay && (
                <span>
                  Busiest day: <strong>{day(recap.busiestDay.date, { weekday: "long" })}</strong>
                </span>
              )}
            </p>
          )}
        </div>
        <div className="inline">
          <button className="ghost" onClick={() => setWeeksAgo(weeksAgo + 1)} aria-label="Week before">
            ◀
          </button>
          <button className="ghost" disabled={weeksAgo === 0} onClick={() => setWeeksAgo(weeksAgo - 1)} aria-label="Week after">
            ▶
          </button>
          <button className="secondary" disabled={!recap} onClick={() => void share()}>
            📸 Share the week
          </button>
        </div>
      </section>
      {error && <p className="error">{error}</p>}
      {!recap ? (
        <p className="muted">Loading…</p>
      ) : (
        <ol className="leaderboard panel" data-nav-zone>
          {recap.players.map((p, i) => (
            <PlayerRow key={p.userId} p={p} rank={i} best={best} onOpen={() => void api.playerCard(p.userId).then(setCard, () => {})} />
          ))}
        </ol>
      )}
      <p className="muted small">Play time counts games started from the LootDen app. {me?.user?.kidMode ? "" : "Kids see the leaderboard too, without the names of grown-up games."}</p>
      <FamilyAchievementBoard />
      {card && (
        <div className="celebration" role="dialog" aria-modal="true" aria-label={`${card.displayName}'s card`} onClick={(e) => e.target === e.currentTarget && setCard(null)}>
          <div className="card-popup">
            <HoloCard name={card.displayName} avatar={card.avatar} level={card.level} badges={card.achievements} kid={card.kid} />
            <button className="primary" onClick={() => setCard(null)} autoFocus>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Home: the week so far in one strip, linking to the full recap. */
export function WeekStrip() {
  const [recap, setRecap] = useState<WeeklyRecap | null>(null);
  useEffect(() => void api.recap(0).then(setRecap, () => {}), []);
  const players = recap?.players.filter((p) => p.seconds > 0) ?? [];
  if (!recap || !players.length) return null;
  return (
    <section className="row week-strip">
      <div className="row-head">
        <h2>This week in the Den</h2>
        <span className="muted small row-sub">{formatPlaytime(recap.totalSeconds)} played</span>
        <Link to="/library?tab=family" className="muted small">
          Leaderboard
        </Link>
      </div>
      <div className="week-strip-track">
        {players.slice(0, 6).map((p, i) => (
          <Link key={p.userId} to="/library?tab=family" className="week-chip panel">
            <span className="week-medal">{MEDALS[i] ?? `#${i + 1}`}</span>
            <img src={avatarUrl(p.avatar)} alt="" width={40} height={40} className="avatar" />
            <span>
              <strong>{p.name}</strong>
              <small className="muted">{[formatPlaytime(p.seconds), p.topGame?.title].filter(Boolean).join(" · ")}</small>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
