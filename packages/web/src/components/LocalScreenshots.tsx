import { useEffect, useState } from "react";
import { bridgeError, desktop, type LocalShot } from "../desktop";

/**
 * The game's screenshots already on this PC (Steam's and Xbox Game Bar's), each one a click
 * away from the family wall. Only in the desktop app.
 */
export function LocalScreenshots({ title, steamAppId, gameId }: { title: string; steamAppId?: string | null; gameId?: string | null }) {
  const [shots, setShots] = useState<LocalShot[] | null>(null);
  const [shared, setShared] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  useEffect(() => {
    setShots(null);
    if (!desktop?.localScreenshots || !title) return;
    desktop.localScreenshots({ title, steamAppId: steamAppId ?? null }).then(setShots, () => setShots([]));
  }, [title, steamAppId]);
  if (!shots?.length || !desktop?.shareLocalScreenshot) return null;
  const share = async (s: LocalShot) => {
    setError("");
    setBusy(s.token);
    try {
      await desktop!.shareLocalScreenshot!(s.token, gameId ?? null, title);
      setShared((x) => new Set(x).add(s.token));
    } catch (e) {
      setError(bridgeError(e));
    } finally {
      setBusy(null);
    }
  };
  const list = all ? shots : shots.slice(0, 12);
  return (
    <section className="row local-shots">
      <h2>
        Your screenshots on this PC <small className="muted">{shots.length}</small>
      </h2>
      <p className="muted small">From Steam and the Xbox Game Bar. Share the good ones to the family wall.</p>
      <div className="local-shot-grid">
        {list.map((s) => (
          <figure key={s.token} className="local-shot">
            <button className="local-shot-open" onClick={() => void desktop!.openLocalScreenshot?.(s.token)} title={`Open ${s.name}`}>
              {s.thumb ? <img src={s.thumb} alt={`Screenshot from ${new Date(s.takenAt).toLocaleDateString()}`} /> : <span className="muted small">{s.name}</span>}
            </button>
            <figcaption>
              <small className="muted">
                {new Date(s.takenAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} · {s.from === "steam" ? "Steam" : "Game Bar"}
              </small>
              <button className="small" disabled={busy === s.token || shared.has(s.token)} onClick={() => void share(s)}>
                {shared.has(s.token) ? "Shared ✓" : busy === s.token ? "Sharing…" : "📸 Share"}
              </button>
            </figcaption>
          </figure>
        ))}
      </div>
      {shots.length > list.length && (
        <button className="ghost small" onClick={() => setAll(true)}>
          Show all {shots.length}
        </button>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
