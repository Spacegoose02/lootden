import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Shelf, type ShelfInput } from "../api";
import { useAuth } from "../auth";
import { GameCard } from "./GameCard";

const EMOJI = ["🎃", "🎄", "👾", "🕹️", "🏆", "🛋️", "🌈", "🦝", "🚀", "🧸", "⚔️", "🌙"];

function ShelfForm({ shelf, admin, onDone, onCancel }: { shelf?: Shelf; admin: boolean; onDone: (input: ShelfInput) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(shelf?.name ?? "");
  const [emoji, setEmoji] = useState(shelf?.emoji ?? "🦝");
  const [description, setDescription] = useState(shelf?.description ?? "");
  const [household, setHousehold] = useState(shelf?.household ?? false);
  const [onHome, setOnHome] = useState(shelf?.onHome ?? true);
  const [error, setError] = useState("");
  return (
    <form
      className="panel shelf-form"
      onSubmit={(e) => {
        e.preventDefault();
        void onDone({ name, emoji, description, household, onHome }).catch((err: Error) => setError(err.message));
      }}
    >
      <div className="emoji-pick" role="radiogroup" aria-label="Icon">
        {EMOJI.map((x) => (
          <button type="button" key={x} role="radio" aria-checked={emoji === x} className={emoji === x ? "active" : ""} onClick={() => setEmoji(x)}>
            {x}
          </button>
        ))}
      </div>
      <div className="inline wrap">
        <input placeholder="Shelf name, like Halloween picks" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Name" autoFocus style={{ flex: 2 }} />
        <input placeholder="What's on it (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} aria-label="Description" style={{ flex: 3 }} />
      </div>
      <div className="inline wrap">
        <label className="check">
          <input type="checkbox" checked={onHome} onChange={(e) => setOnHome(e.target.checked)} />
          Show on Home
        </label>
        {admin && (
          <label className="check">
            <input type="checkbox" checked={household} onChange={(e) => setHousehold(e.target.checked)} />
            Household shelf (everyone sees it)
          </label>
        )}
        <button className="primary" disabled={!name.trim()}>
          {shelf ? "Save" : "Make shelf"}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

/** Library, Shelves: the household's shelves and your own, made and changed here. */
export function ShelvesTab() {
  const { me } = useAuth();
  const admin = me?.role === "admin";
  const [shelves, setShelves] = useState<Shelf[] | null>(null);
  const [making, setMaking] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState("");
  const load = () => api.shelves().then(setShelves, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="shelves">
      <div className="inline shelves-head">
        <p className="muted">Shelves are hand-picked rows of games. Add games from a game's page with <strong>Add to shelf</strong>.</p>
        {!making && (
          <button className="primary" onClick={() => setMaking(true)}>
            + New shelf
          </button>
        )}
      </div>
      {making && (
        <ShelfForm
          admin={admin}
          onCancel={() => setMaking(false)}
          onDone={async (input) => {
            await api.createShelf(input);
            setMaking(false);
            await load();
          }}
        />
      )}
      {error && <p className="error">{error}</p>}
      {shelves === null ? (
        <p className="muted">Loading…</p>
      ) : !shelves.length && !making ? (
        <div className="empty">
          <h2>No shelves yet 🦝</h2>
          <p className="muted">Make one for your favourites, a holiday, or games to play together.</p>
        </div>
      ) : (
        shelves.map((s) => {
          const canEdit = s.household ? admin : s.mine;
          return (
            <section key={s.id} className="row shelf">
              {editing === s.id ? (
                <ShelfForm
                  shelf={s}
                  admin={admin}
                  onCancel={() => setEditing(null)}
                  onDone={async (input) => {
                    await api.updateShelf(s.id, input);
                    setEditing(null);
                    await load();
                  }}
                />
              ) : (
                <div className="row-head">
                  <h2>
                    {s.emoji && <span aria-hidden="true">{s.emoji} </span>}
                    {s.name}
                  </h2>
                  <span className="muted small row-sub">
                    {[s.household ? "Household" : "Yours", s.onHome ? "on Home" : null, `${s.games.length} game${s.games.length === 1 ? "" : "s"}`, s.description].filter(Boolean).join(" · ")}
                  </span>
                  {canEdit && (
                    <span className="inline">
                      <button className="ghost small" onClick={() => setEditing(s.id)}>
                        Edit
                      </button>
                      <button className="ghost small" onClick={() => confirm(`Delete the ${s.name} shelf? The games stay in the library.`) && void run(() => api.deleteShelf(s.id))}>
                        Delete
                      </button>
                    </span>
                  )}
                </div>
              )}
              {s.games.length ? (
                <div className="row-track">
                  {s.games.map((g) => (
                    <div key={g.id} className="card-wrap shelf-item">
                      <GameCard game={g} />
                      {canEdit && (
                        <button className="ghost small shelf-remove" title={`Take ${g.title} off this shelf`} onClick={() => void run(() => api.unshelveGame(s.id, g.id))}>
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted small">
                  Empty. Open a game in the <Link to="/library?tab=all">library</Link> and choose Add to shelf.
                </p>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}

/** On a game's page: put it on (or take it off) any shelf you can change, or a new one. */
export function ShelfButton({ gameId }: { gameId: string }) {
  const { me } = useAuth();
  const admin = me?.role === "admin";
  const [open, setOpen] = useState(false);
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [on, setOn] = useState<Set<number>>(new Set());
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const load = () => {
    api.shelves().then((s) => setShelves(s.filter((x) => (x.household ? admin : x.mine))), () => {});
    api.gameShelves(gameId).then((ids) => setOn(new Set(ids)), () => {});
  };
  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, gameId]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const toggle = async (s: Shelf) => {
    setError("");
    try {
      if (on.has(s.id)) await api.unshelveGame(s.id, gameId);
      else await api.shelveGame(s.id, gameId);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="shelf-button" ref={box}>
      <button className="secondary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {on.size ? "📚 On a shelf" : "📚 Add to shelf"}
      </button>
      {open && (
        <div className="shelf-menu panel" role="menu">
          {shelves.map((s) => (
            <label key={s.id} className="check" role="menuitemcheckbox" aria-checked={on.has(s.id)}>
              <input type="checkbox" checked={on.has(s.id)} onChange={() => void toggle(s)} />
              {s.emoji ? `${s.emoji} ` : ""}
              {s.name}
              {s.household && <small className="muted"> household</small>}
            </label>
          ))}
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              void api
                .createShelf({ name, emoji: "🦝" })
                .then((s) => api.shelveGame(s.id, gameId))
                .then(() => (setName(""), load()), (err: Error) => setError(err.message));
            }}
          >
            <input placeholder="New shelf" value={name} onChange={(e) => setName(e.target.value)} aria-label="New shelf name" maxLength={60} />
            <button className="small" disabled={!name.trim()}>
              Add
            </button>
          </form>
          {error && <p className="error small">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** Home: shelves marked for Home, as rows. */
export function HomeShelves() {
  const [shelves, setShelves] = useState<Shelf[]>([]);
  useEffect(() => void api.shelves().then((s) => setShelves(s.filter((x) => x.onHome && x.games.length)), () => {}), []);
  return (
    <>
      {shelves.map((s) => (
        <section key={s.id} className="row shelf">
          <div className="row-head">
            <h2>
              {s.emoji && <span aria-hidden="true">{s.emoji} </span>}
              {s.name}
            </h2>
            {s.description && <span className="muted small row-sub">{s.description}</span>}
            <Link to="/library?tab=shelves" className="muted small">
              All shelves
            </Link>
          </div>
          <div className="row-track">
            {s.games.map((g) => (
              <GameCard key={g.id} game={g} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
