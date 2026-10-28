import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type GameRequest } from "../api";
import { useAuth } from "../auth";

const STATUS: Record<GameRequest["status"], string> = {
  pending: "Waiting for an admin",
  searching: "Approved · looking for it",
  downloading: "Downloading",
  ready: "Ready to play",
  declined: "Declined",
};

/**
 * Asking for a game: anyone (kid profiles too) asks, and follows it from waiting to ready.
 * Admins see everyone's and approve (onto the wanted list, searched until it's in the library) or decline.
 */
export function Requests() {
  const { me } = useAuth();
  const admin = me?.role === "admin";
  const [list, setList] = useState<GameRequest[] | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState<number | null>(null);
  const [reason, setReason] = useState("");

  const load = () => api.requests().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = list?.filter((r) => r.status === "pending") ?? [];
  const rest = list?.filter((r) => r.status !== "pending") ?? [];
  const row = (r: GameRequest) => (
    <li key={r.id} className={`request request-${r.status}`}>
      <div className="request-art">{r.image ? <img src={r.image} alt="" loading="lazy" /> : <span>{r.title.slice(0, 1)}</span>}</div>
      <div className="request-main">
        <strong>{r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.title}</a> : r.title}</strong>
        <span className="muted small">
          {admin ? `${r.requestedBy.name} · ` : ""}
          {new Date(r.createdAt).toLocaleDateString()}
          {r.note ? ` · “${r.note}”` : ""}
        </span>
        {r.status === "declined" && r.reason && <span className="muted small">Why: {r.reason}</span>}
        {declining === r.id && (
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.declineRequest(r.id, reason)).then(() => (setDeclining(null), setReason("")));
            }}
          >
            <input autoFocus placeholder="Why not? (optional, they'll see it)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
            <button className="secondary small" disabled={busy}>
              Decline
            </button>
            <button type="button" className="ghost small" onClick={() => setDeclining(null)}>
              Cancel
            </button>
          </form>
        )}
      </div>
      <span className={`request-status status-${r.status}`}>{STATUS[r.status]}</span>
      <span className="request-actions">
        {r.libraryId && (
          <Link className="button primary small" to={`/games/${r.libraryId}`}>
            Open
          </Link>
        )}
        {admin && r.status === "pending" && (
          <>
            <button className="primary small" disabled={busy} onClick={() => run(() => api.approveRequest(r.id))}>
              Approve
            </button>
            <button className="ghost small" disabled={busy} onClick={() => setDeclining(r.id)}>
              Decline
            </button>
          </>
        )}
        {(r.status === "pending" || (admin && r.status === "declined")) && (
          <button className="ghost small" disabled={busy} onClick={() => run(() => api.withdrawRequest(r.id))} title={admin && r.status === "declined" ? "Remove it from the list" : "Withdraw the request"}>
            {r.status === "pending" && !admin ? "Withdraw" : "Remove"}
          </button>
        )}
      </span>
    </li>
  );

  return (
    <div className="requests">
      <h1>Requests</h1>
      <form
        className="panel request-form"
        data-nav-zone
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.requestGame({ title, note: note || null })).then(() => (setTitle(""), setNote("")));
        }}
      >
        <h2>Ask for a game</h2>
        <p className="muted small">{admin ? "Requests from everyone land here for you to approve. Approving puts the game on the wanted list, where it's searched until it's in the library." : "An admin approves it, then LootDen looks for it. It shows here as ready once it's in the library."}</p>
        <div className="inline wrap">
          <input placeholder="Game name" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Game name" style={{ flex: 2 }} />
          <input placeholder="A note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" style={{ flex: 3 }} />
          <button className="primary" disabled={busy || !title.trim()}>
            Request it
          </button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      {list === null ? (
        <p className="muted">Loading…</p>
      ) : !list.length ? (
        <p className="muted">No requests yet.</p>
      ) : (
        <>
          {open.length > 0 && (
            <section>
              <h2 className="collection-title">
                {admin ? "Waiting for you" : "Waiting"} <span className="muted small">{open.length}</span>
              </h2>
              <ul className="request-list" data-nav-zone>
                {open.map(row)}
              </ul>
            </section>
          )}
          {rest.length > 0 && (
            <section>
              <h2 className="collection-title">Approved and earlier</h2>
              <ul className="request-list" data-nav-zone>
                {rest.map(row)}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** "Request it" for a game that isn't in the library, from its Discover page. */
export function RequestButton({ game }: { game: { name: string; url: string | null; coverUrl: string | null; provider: string; providerId: string } }) {
  const [state, setState] = useState<GameRequest | null>(null);
  const [error, setError] = useState("");
  if (state)
    return (
      <Link className="button secondary" to="/requests" title={STATUS[state.status]}>
        ✓ Requested
      </Link>
    );
  return (
    <>
      <button
        className="secondary"
        onClick={() =>
          api
            .requestGame({ title: game.name, url: game.url, image: game.coverUrl, steamAppId: game.provider === "steam" && /^\d+$/.test(game.providerId) ? Number(game.providerId) : null })
            .then(setState, (e: Error) => setError(e.message))
        }
      >
        Request it
      </button>
      {error && <span className="error small">{error}</span>}
    </>
  );
}
