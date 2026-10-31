import { useEffect, useRef, useState, type PointerEvent } from "react";
import { lockedPart, parseRaccoonSeed, RACCOON_PARTS, raccoonSeed, type AchievementView, type Level, type RaccoonPart, type RaccoonParts } from "@lootden/shared";
import { api, avatarUrl, formatPlaytime, type Progress } from "../api";

/** The XP bar from this level to the next. */
export function XpBar({ level }: { level: Level }) {
  const span = level.next - level.floor;
  const pct = span > 0 ? ((level.xp - level.floor) / span) * 100 : 100;
  return (
    <div className="xp-bar" role="progressbar" aria-valuemin={level.floor} aria-valuemax={level.next} aria-valuenow={level.xp} aria-label={`Level ${level.level}`}>
      <div style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      <span>
        {level.xp - level.floor} / {span} XP to level {level.level + 1}
      </span>
    </div>
  );
}

/**
 * A holographic trading card for a profile: raccoon, level and rank, XP, and the best badges.
 * It tilts toward the pointer, like a foil card catching the light.
 */
export function HoloCard({ name, avatar, level, badges, kid, stats }: { name: string; avatar: string; level: Level; badges: AchievementView[]; kid?: boolean; stats?: Progress["stats"] }) {
  const card = useRef<HTMLDivElement>(null);
  const tilt = (e: PointerEvent<HTMLDivElement>) => {
    const el = card.current;
    if (!el || e.pointerType === "touch") return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.setProperty("--rx", `${(0.5 - y) * 14}deg`);
    el.style.setProperty("--ry", `${(x - 0.5) * 18}deg`);
    el.style.setProperty("--gx", `${x * 100}%`);
    el.style.setProperty("--gy", `${y * 100}%`);
  };
  const reset = () => {
    for (const p of ["--rx", "--ry", "--gx", "--gy"]) card.current?.style.removeProperty(p);
  };
  const tierOrder = { legendary: 0, gold: 1, silver: 2, bronze: 3 };
  const best = badges
    .filter((b) => b.unlockedAt)
    .sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || (b.unlockedAt ?? "").localeCompare(a.unlockedAt ?? ""))
    .slice(0, 6);
  return (
    <div className="holo-card" ref={card} onPointerMove={tilt} onPointerLeave={reset}>
      <div className="holo-shine" aria-hidden="true" />
      <div className="holo-top">
        <span className="holo-level">LV {level.level}</span>
        <span className="holo-rank">{level.rank}</span>
      </div>
      <img src={avatarUrl(avatar)} alt="" width={128} height={128} className="holo-avatar" />
      <h2 className="holo-name">
        {name} {kid && <span className="badge badge-kid">Kid</span>}
      </h2>
      <XpBar level={level} />
      {stats && (
        <dl className="holo-stats">
          <div>
            <dt>Played</dt>
            <dd>{formatPlaytime(stats.playSeconds)}</dd>
          </div>
          <div>
            <dt>Games</dt>
            <dd>{stats.gamesPlayed}</dd>
          </div>
          <div>
            <dt>Finished</dt>
            <dd>{stats.finished}</dd>
          </div>
          <div>
            <dt>Best streak</dt>
            <dd>{stats.bestStreak}d</dd>
          </div>
        </dl>
      )}
      <ul className="holo-badges" aria-label="Best badges">
        {best.map((b) => (
          <li key={b.id} className={`tier-${b.tier}`} title={`${b.name}: ${b.description}`}>
            {b.icon}
          </li>
        ))}
        {!best.length && <li className="muted small holo-empty">Badges show up here</li>}
      </ul>
    </div>
  );
}

/** Every badge: unlocked ones lit, the rest with how far along they are. */
export function AchievementsGrid({ achievements }: { achievements: AchievementView[] }) {
  const got = achievements.filter((a) => a.unlockedAt).length;
  return (
    <section className="panel">
      <h2>
        Badges <span className="muted small">{got} of {achievements.length}</span>
      </h2>
      <ul className="badge-grid">
        {achievements.map((a) => (
          <li key={a.id} className={`badge-tile tier-${a.tier}${a.unlockedAt ? " unlocked" : ""}`} title={a.unlockedAt ? `Unlocked ${new Date(a.unlockedAt).toLocaleDateString()}` : undefined}>
            <span className="badge-icon" aria-hidden="true">
              {a.icon}
            </span>
            <strong>{a.name}</strong>
            <span className="muted small">{a.description}</span>
            {a.unlockedAt ? (
              <span className="badge-xp">+{a.xp} XP</span>
            ) : (
              <span className="badge-progress" aria-label={`${a.progress} of ${a.goal}`}>
                <span style={{ width: `${(a.progress / a.goal) * 100}%` }} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const PART_LABELS: Array<[RaccoonPart, string]> = [
  ["accessory", "Gear"],
  ["fur", "Fur"],
  ["palette", "Background"],
  ["eyes", "Eyes"],
  ["mouth", "Mouth"],
];

/** Build-a-raccoon: pick each part; parts past the starter set unlock as the level goes up. */
export function RaccoonBuilder({ current, level, onSave }: { current: string; level: number; onSave: (seed: string) => Promise<void> }) {
  const [parts, setParts] = useState<RaccoonParts>(() => parseRaccoonSeed(current) ?? { fur: 0, palette: 0, eyes: 0, mouth: 0, accessory: 2 });
  const [tab, setTab] = useState<RaccoonPart>("accessory");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const p = parseRaccoonSeed(current);
    if (p) setParts(p);
  }, [current]);
  const seed = raccoonSeed(parts);
  const locked = lockedPart(parts, level);
  return (
    <div className="raccoon-builder">
      <img src={avatarUrl(seed)} alt="Your raccoon" width={128} height={128} className="avatar raccoon-preview" />
      <div className="raccoon-builder-main">
        <div className="segmented" role="tablist" aria-label="Part">
          {PART_LABELS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="raccoon-parts" role="listbox" aria-label={PART_LABELS.find(([k]) => k === tab)![1]}>
          {RACCOON_PARTS[tab].map((item, i) =>
            // The starter set has two "None" gear slots (for random raccoons); show one.
            tab === "accessory" && i === 1 ? null : (
              <button
                key={i}
                role="option"
                aria-selected={parts[tab] === i}
                className={`raccoon-part${parts[tab] === i ? " active" : ""}${item.level && item.level > level ? " locked" : ""}`}
                onClick={() => setParts({ ...parts, [tab]: i })}
                title={item.level && item.level > level ? `Unlocks at level ${item.level}` : item.name}
              >
                <img src={avatarUrl(raccoonSeed({ ...parts, [tab]: i }))} alt="" width={44} height={44} loading="lazy" />
                <span>{item.name}</span>
                {item.level && item.level > level ? <small className="raccoon-lock">🔒 LV {item.level}</small> : null}
              </button>
            ),
          )}
        </div>
        <div className="inline">
          <button
            className="primary"
            disabled={busy || !!locked || seed === current}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(seed);
              } finally {
                setBusy(false);
              }
            }}
          >
            {locked ? `${locked.name} unlocks at level ${locked.level}` : seed === current ? "This is you" : "Wear this raccoon"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** This person's level and badges, loaded once per page. */
export function useProgress(): [Progress | null, () => void] {
  const [p, setP] = useState<Progress | null>(null);
  const load = () => void api.progress().then(setP, () => {});
  useEffect(load, []);
  return [p, load];
}
