import { useEffect, useState } from "react";
import type { User } from "@lootden/shared";
import { api } from "../api";

/** A game's page: "earn this in Den Duty first", or how long a reward keeps it unlocked. */
export function EarnLockBanner({ gameId }: { gameId: string }) {
  const [lock, setLock] = useState<{ reason: string | null; unlockedUntil: string | null } | null>(null);
  useEffect(() => void api.gameLock(gameId).then(setLock, () => setLock(null)), [gameId]);
  if (!lock) return null;
  if (lock.reason) return <p className="notice earn-lock">🔒 {lock.reason}</p>;
  if (lock.unlockedUntil)
    return <p className="notice earn-lock">🔓 Unlocked with a Den Duty reward until {new Date(lock.unlockedUntil).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</p>;
  return null;
}

/** Admin tab: kids who have to earn this game with a Den Duty shop reward before they can play it. */
export function EarnersAdmin({ gameId }: { gameId: string }) {
  const [kids, setKids] = useState<User[]>([]);
  const [ids, setIds] = useState<number[] | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    void api.users().then((u) => setKids(u.filter((x) => x.kidMode)), () => {});
    void api.gameEarners(gameId).then((r) => setIds(r.userIds), () => setIds(null));
  }, [gameId]);
  if (!kids.length || !ids) return null;
  const toggle = async (id: number, on: boolean) => {
    const next = on ? [...ids, id] : ids.filter((x) => x !== id);
    try {
      setIds((await api.setGameEarners(gameId, next)).userIds);
      setMsg({ text: "Saved" });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  };
  return (
    <section className="panel">
      <h3>🔒 Earn it in Den Duty</h3>
      <p className="muted small">
        Kids ticked here can only play this game after buying it as a reward in Den Duty's shop (make a shop item that unlocks it, for a few hours or a weekend). Needs the Den Duty link in
        Settings, Family.
      </p>
      <div className="inline wrap">
        {kids.map((k) => (
          <label key={k.id} className="check">
            <input type="checkbox" checked={ids.includes(k.id)} onChange={(e) => void toggle(k.id, e.target.checked)} />
            <span>{k.displayName}</span>
          </label>
        ))}
      </div>
      {msg && <p className={msg.error ? "error small" : "notice small"}>{msg.text}</p>}
    </section>
  );
}
