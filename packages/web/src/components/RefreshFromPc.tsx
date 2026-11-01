import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { versionLabel as v, type RefreshCandidate, type RefreshJob } from "@lootden/shared";
import { api, formatBytes } from "../api";
import { useLive } from "../live";

/**
 * Admin: games a household PC has a newer copy of than the library (updated by its launcher,
 * or with the server's updates applied). Refresh asks that PC to zip its copy and upload it as
 * the library copy; the old copy and the updates it replaces move to .replaced.
 */
export function RefreshFromPc() {
  const [data, setData] = useState<{ candidates: RefreshCandidate[]; jobs: RefreshJob[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = () => api.libraryRefresh().then(setData, () => {});
  useEffect(() => void load(), []);
  useLive("library", () => void load());

  if (!data || (!data.candidates.length && !data.jobs.length)) return null;
  const jobFor = (gameId: string) => data.jobs.find((j) => j.gameId === gameId && (j.state === "waiting" || j.state === "uploading"));

  const start = async (c: RefreshCandidate, device: string) => {
    const cleared = [...c.updates, ...c.oldCopies];
    const ok = window.confirm(
      `Ask ${device} to upload its copy of ${c.title} as the library copy?\n\n` +
        `The library copy${c.libraryVersion ? ` (${v(c.libraryVersion)})` : ""}${cleared.length ? ` and ${cleared.length === 1 ? cleared[0]!.title : `${cleared.length} updates and old copies`}` : ""} ` +
        "move to .replaced in the games folder once the upload is in. DLC stays.",
    );
    if (!ok) return;
    setBusy(c.gameId);
    setError("");
    try {
      await api.refreshFromPc(c.gameId, device);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const recent = data.jobs.filter((j) => j.state === "done" || j.state === "failed").slice(0, 5);
  return (
    <article className="panel pkg-group refresh-panel">
      <h2>Newer copies on your PCs</h2>
      <p className="muted small">
        These PCs have a newer version than the library. Refresh asks the PC to zip its copy and upload it as the library copy; the old copy and the updates it makes unnecessary move to{" "}
        <code>.replaced</code> in the games folder.
      </p>
      {error && <p className="error small">{error}</p>}
      <ul className="pkg-list">
        {data.candidates.map((c) => {
          const job = jobFor(c.gameId);
          const best = c.pcs[0]!;
          return (
            <li key={c.gameId}>
              <div className="pkg-title">
                <Link to={`/games/${c.gameId}`}>{c.title}</Link>
                <span className="muted small">
                  Library {c.libraryVersion ? v(c.libraryVersion) : "copy"}
                  {c.updates.length ? ` + ${c.updates.length} update${c.updates.length === 1 ? "" : "s"}` : ""} · {formatBytes(c.sizeBytes + [...c.updates, ...c.oldCopies].reduce((n, u) => n + u.sizeBytes, 0))}
                </span>
                <span className="small">
                  {best.device} has {v(best.version)}
                  {best.fromExe ? " (updated outside LootDen)" : ""}
                  {best.online ? "" : " · offline"}
                </span>
              </div>
              <div className="pkg-actions">
                {job ? (
                  <span className="muted small">{job.state === "waiting" ? `Waiting for ${job.device}…` : `${job.device} is uploading…`}</span>
                ) : (
                  c.pcs.slice(0, 3).map((p) => (
                    <button key={p.device} className="small" disabled={busy === c.gameId} onClick={() => void start(c, p.device)} title={p.online ? "" : "Starts when that PC comes on (within a day)"}>
                      Refresh from {p.device}
                    </button>
                  ))
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {recent.length > 0 && (
        <ul className="pkg-list">
          {recent.map((j) => (
            <li key={j.ticket}>
              <div className="pkg-title">
                {j.state === "done" && j.newGameId ? <Link to={`/games/${j.newGameId}`}>{j.title}</Link> : <span>{j.title}</span>}
                <span className={j.state === "failed" ? "error small" : "muted small"}>
                  {j.state === "done" ? `Refreshed from ${j.device} to ${v(j.version)}` : `Couldn't refresh from ${j.device}`}
                  {j.message ? `: ${j.message}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
