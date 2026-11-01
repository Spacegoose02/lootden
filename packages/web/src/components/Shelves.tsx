import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { SmartRules } from "@lootden/shared";
import { api, BACKLOG, BACKLOG_LABELS, type Shelf, type ShelfInput } from "../api";
import { useTagList } from "./Marks";
import { useAuth } from "../auth";
import { GameCard } from "./GameCard";

const EMOJI = ["🎃", "🎄", "👾", "🕹️", "🏆", "🛋️", "🌈", "🦝", "🚀", "🧸", "⚔️", "🌙"];

function ShelfForm({ shelf, admin, onDone, onCancel }: { shelf?: Shelf; admin: boolean; onDone: (input: ShelfInput) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(shelf?.name ?? "");
  const [emoji, setEmoji] = useState(shelf?.emoji ?? "🦝");
  const [description, setDescription] = useState(shelf?.description ?? "");
  const [household, setHousehold] = useState(shelf?.household ?? false);
  const [onHome, setOnHome] = useState(shelf?.onHome ?? true);
  const [smart, setSmart] = useState(!!shelf?.rules);
  const [rules, setRules] = useState<SmartRules>(shelf?.rules ?? {});
  const [error, setError] = useState("");
  return (
    <form
      className="panel shelf-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (smart && !Object.keys(rules).some((k) => k !== "sort" && k !== "limit")) return setError("Pick at least one rule, or untick Smart shelf");
        void onDone({ name, emoji, description, household, onHome, rules: smart ? rules : null }).catch((err: Error) => setError(err.message));
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
      <label className="check">
        <input type="checkbox" checked={smart} onChange={(e) => setSmart(e.target.checked)} />
        Smart shelf: fills itself with the games that match
      </label>
      {smart && <RulesEditor rules={rules} onChange={setRules} />}
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
                    {[s.rules ? "✨ Smart" : null, s.household ? "Household" : "Yours", s.onHome ? "on Home" : null, `${s.games.length} game${s.games.length === 1 ? "" : "s"}`, s.description].filter(Boolean).join(" · ")}
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
    api.shelves().then((s) => setShelves(s.filter((x) => !x.rules && (x.household ? admin : x.mine))), () => {});
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

/** A smart shelf's rules: every rule set has to match. */
function RulesEditor({ rules, onChange }: { rules: SmartRules; onChange: (r: SmartRules) => void }) {
  const tags = useTagList();
  const [genres, setGenres] = useState<string[]>([]);
  useEffect(() => {
    api.genres().then((g) => setGenres(g.map((x) => x.name)), () => {});
  }, []);
  const set = (patch: Partial<SmartRules>) => {
    const next = { ...rules, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "" || (Array.isArray(next[k]) && !(next[k] as unknown[]).length)) delete next[k];
    onChange(next as SmartRules);
  };
  const tri = (v: boolean | undefined) => (v === undefined ? "" : v ? "yes" : "no");
  const fromTri = (v: string) => (v === "" ? undefined : v === "yes");
  return (
    <div className="rules-editor">
      <label className="field">
        <span className="field-label">Genre</span>
        <select value={rules.genres?.[0] ?? ""} onChange={(e) => set({ genres: e.target.value ? [e.target.value] : undefined })}>
          <option value="">Any</option>
          {genres.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Tag</span>
        <select value={rules.tags?.[0] ?? ""} onChange={(e) => set({ tags: e.target.value ? [e.target.value] : undefined })}>
          <option value="">Any</option>
          {tags.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Status</span>
        <select value={rules.statuses?.[0] ?? ""} onChange={(e) => set({ statuses: e.target.value ? [e.target.value] : undefined })}>
          <option value="">Any</option>
          {BACKLOG.map((b) => (
            <option key={b} value={b}>
              {BACKLOG_LABELS[b]}
            </option>
          ))}
          <option value="none">No status yet</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Played</span>
        <select value={tri(rules.played)} onChange={(e) => set({ played: fromTri(e.target.value) })}>
          <option value="">Either</option>
          <option value="no">Never played</option>
          <option value="yes">Played</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Installed</span>
        <select value={tri(rules.installed)} onChange={(e) => set({ installed: fromTri(e.target.value) })}>
          <option value="">Either</option>
          <option value="yes">Installed somewhere</option>
          <option value="no">Not installed</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Favourites</span>
        <select value={tri(rules.favourite)} onChange={(e) => set({ favourite: fromTri(e.target.value) })}>
          <option value="">Either</option>
          <option value="yes">Only favourites</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Players</span>
        <select value={tri(rules.together)} onChange={(e) => set({ together: fromTri(e.target.value) })}>
          <option value="">Any</option>
          <option value="yes">👥 Play together</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Controller</span>
        <select value={rules.controller ?? ""} onChange={(e) => set({ controller: (e.target.value || undefined) as SmartRules["controller"] })}>
          <option value="">Any input</option>
          <option value="any">Full or partial</option>
          <option value="full">Full</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Rating at least</span>
        <input type="number" min={0} max={100} value={rules.minRating ?? ""} onChange={(e) => set({ minRating: e.target.value ? Number(e.target.value) : undefined })} />
      </label>
      <label className="field">
        <span className="field-label">Released from</span>
        <input type="number" min={1970} max={2100} placeholder="Year" value={rules.fromYear ?? ""} onChange={(e) => set({ fromYear: e.target.value ? Number(e.target.value) : undefined })} />
      </label>
      <label className="field">
        <span className="field-label">Released up to</span>
        <input type="number" min={1970} max={2100} placeholder="Year" value={rules.toYear ?? ""} onChange={(e) => set({ toYear: e.target.value ? Number(e.target.value) : undefined })} />
      </label>
      <label className="field">
        <span className="field-label">Added in the last</span>
        <select value={rules.addedDays ?? ""} onChange={(e) => set({ addedDays: e.target.value ? Number(e.target.value) : undefined })}>
          <option value="">Any time</option>
          <option value={7}>Week</option>
          <option value={30}>Month</option>
          <option value={90}>3 months</option>
          <option value={365}>Year</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={!!rules.kidSafe} onChange={(e) => set({ kidSafe: e.target.checked || undefined })} /> Kid-safe only
      </label>
      <label className="field">
        <span className="field-label">Order</span>
        <select value={rules.sort ?? "title"} onChange={(e) => set({ sort: e.target.value as SmartRules["sort"] })}>
          <option value="title">Title</option>
          <option value="added">Newest added</option>
          <option value="rating">Best rated</option>
          <option value="release">Newest release</option>
          <option value="random">Shuffled daily</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">At most</span>
        <input type="number" min={1} max={500} placeholder="All" value={rules.limit ?? ""} onChange={(e) => set({ limit: e.target.value ? Number(e.target.value) : undefined })} />
      </label>
    </div>
  );
}
