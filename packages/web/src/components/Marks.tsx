import { useEffect, useState } from "react";
import { NO_MARKS, type GameMarks, type MarksPatch } from "@lootden/shared";
import { api, BACKLOG, BACKLOG_LABELS, type BacklogStatus, type Shelf } from "../api";

// ---- Everyone's marks, loaded once and shared by every page ------------------------------

let cache: Map<string, GameMarks> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function load(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = api.marks().then(
    (m) => {
      cache = new Map(Object.entries(m));
      notify();
    },
    () => {
      cache ??= new Map();
      notify();
    },
  );
  return loading;
}

/** This person's favourites, hidden games, tags and fields, by game key (a library id or store:<addon>:<id>). */
export function useMarks() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    if (!cache) void load();
    return () => void listeners.delete(l);
  }, []);
  const get = (key: string): GameMarks => cache?.get(key) ?? NO_MARKS;
  const set = async (key: string, patch: MarksPatch) => {
    const next = await api.setMarks(key, patch);
    cache ??= new Map();
    cache.set(key, next);
    notify();
    return next;
  };
  const bulk = async (keys: string[], edit: Parameters<typeof api.bulkEdit>[1]) => {
    const r = await api.bulkEdit(keys, edit);
    await load(true);
    return r;
  };
  return { ready: !!cache, get, set, bulk, all: cache ?? new Map<string, GameMarks>(), reload: () => load(true) };
}

/** Every tag this person has used, most used first. */
export function useTagList(): string[] {
  const { all } = useMarks();
  const counts = new Map<string, number>();
  for (const m of all.values()) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

/** ♥ Favourite and Hide buttons for a game page. */
export function MarkButtons({ gameKey }: { gameKey: string }) {
  const marks = useMarks();
  const m = marks.get(gameKey);
  if (!marks.ready) return null;
  return (
    <>
      <button className={m.favourite ? "secondary active" : "ghost"} aria-pressed={m.favourite} onClick={() => void marks.set(gameKey, { favourite: !m.favourite })}>
        {m.favourite ? "♥ Favourite" : "♡ Favourite"}
      </button>
      <button className="ghost" aria-pressed={m.hidden} onClick={() => void marks.set(gameKey, { hidden: !m.hidden })} title="Hidden games stay out of the library and shelves until you show hidden games">
        {m.hidden ? "Unhide" : "Hide"}
      </button>
    </>
  );
}

/** Tags and custom fields on a game page. */
export function TagsPanel({ gameKey }: { gameKey: string }) {
  const marks = useMarks();
  const known = useTagList();
  const [tag, setTag] = useState("");
  const [field, setField] = useState({ name: "", value: "" });
  const [error, setError] = useState("");
  const m = marks.get(gameKey);
  if (!marks.ready) return null;
  const run = (p: MarksPatch) => marks.set(gameKey, p).then(() => setError(""), (e: Error) => setError(e.message));
  const fields = Object.entries(m.fields);
  return (
    <section className="panel tags-panel">
      <h2>My tags and fields</h2>
      <div className="tag-chips">
        {m.tags.map((t) => (
          <span key={t} className="tag-chip">
            {t}
            <button className="ghost small" aria-label={`Remove tag ${t}`} onClick={() => void run({ removeTags: [t] })}>
              ✕
            </button>
          </span>
        ))}
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (tag.trim()) void run({ addTags: [tag] }).then(() => setTag(""));
          }}
        >
          <input list={`tags-${gameKey}`} value={tag} placeholder="Add a tag" aria-label="Add a tag" onChange={(e) => setTag(e.target.value)} />
          <datalist id={`tags-${gameKey}`}>
            {known.filter((t) => !m.tags.includes(t)).map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <button className="small" disabled={!tag.trim()}>
            Add
          </button>
        </form>
      </div>
      {fields.length > 0 && (
        <dl className="custom-fields">
          {fields.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>
                {v}{" "}
                <button className="ghost small" aria-label={`Remove ${k}`} onClick={() => void run({ fields: { [k]: "" } })}>
                  ✕
                </button>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <form
        className="inline wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (field.name.trim() && field.value.trim()) void run({ fields: { [field.name]: field.value } }).then(() => setField({ name: "", value: "" }));
        }}
      >
        <input value={field.name} placeholder="Field, like Mods installed" aria-label="Field name" onChange={(e) => setField({ ...field, name: e.target.value })} />
        <input value={field.value} placeholder="Value" aria-label="Field value" onChange={(e) => setField({ ...field, value: e.target.value })} />
        <button className="small" disabled={!field.name.trim() || !field.value.trim()}>
          Set field
        </button>
      </form>
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** The bar shown while games are selected in the library: the same change to all of them. */
export function BulkBar({ keys, onDone, onClear }: { keys: string[]; onDone: () => void; onClear: () => void }) {
  const marks = useMarks();
  const tagList = useTagList();
  const [tag, setTag] = useState("");
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    api.shelves().then((s) => setShelves(s.filter((x) => x.mine && !x.rules)), () => {});
  }, []);
  const run = async (edit: Parameters<typeof api.bulkEdit>[1], what: string) => {
    setBusy(true);
    setNote("");
    try {
      await marks.bulk(keys, edit);
      setNote(`${what}: ${keys.length} game${keys.length === 1 ? "" : "s"}.`);
      onDone();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bulk-bar panel" role="toolbar" aria-label="Change the selected games">
      <strong>{keys.length} selected</strong>
      <button className="small" disabled={busy || !keys.length} onClick={() => void run({ patch: { favourite: true } }, "Favourited")}>
        ♥ Favourite
      </button>
      <button className="small" disabled={busy || !keys.length} onClick={() => void run({ patch: { favourite: false } }, "Unfavourited")}>
        ♡ Unfavourite
      </button>
      <button className="small" disabled={busy || !keys.length} onClick={() => void run({ patch: { hidden: true } }, "Hidden")}>
        Hide
      </button>
      <button className="small" disabled={busy || !keys.length} onClick={() => void run({ patch: { hidden: false } }, "Shown")}>
        Unhide
      </button>
      <span className="inline">
        <input list="bulk-tags" value={tag} placeholder="Tag" aria-label="Tag" onChange={(e) => setTag(e.target.value)} />
        <datalist id="bulk-tags">
          {tagList.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <button className="small" disabled={busy || !keys.length || !tag.trim()} onClick={() => void run({ patch: { addTags: [tag] } }, `Tagged ${tag}`)}>
          + Tag
        </button>
        <button className="small" disabled={busy || !keys.length || !tag.trim()} onClick={() => void run({ patch: { removeTags: [tag] } }, `Untagged ${tag}`)}>
          − Tag
        </button>
      </span>
      <select value="" disabled={busy || !keys.length} aria-label="Set status" onChange={(e) => e.target.value && void run({ status: e.target.value === "none" ? null : (e.target.value as BacklogStatus) }, "Status set")}>
        <option value="">Set status…</option>
        {BACKLOG.map((b) => (
          <option key={b} value={b}>
            {BACKLOG_LABELS[b]}
          </option>
        ))}
        <option value="none">No status</option>
      </select>
      {shelves.length > 0 && (
        <select value="" disabled={busy || !keys.length} aria-label="Add to shelf" onChange={(e) => e.target.value && void run({ shelfId: Number(e.target.value) }, "Added to the shelf")}>
          <option value="">Add to shelf…</option>
          {shelves.map((s) => (
            <option key={s.id} value={s.id}>
              {s.emoji} {s.name}
            </option>
          ))}
        </select>
      )}
      <button className="ghost small" onClick={onClear}>
        Done
      </button>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}
