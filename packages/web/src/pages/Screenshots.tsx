import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SCREENSHOT_REACTIONS, type Screenshot } from "@lootden/shared";
import { api, avatarUrl } from "../api";
import { useLive } from "../live";
import { useEscape } from "../escape";
import { desktop } from "../desktop";

const ago = (iso: string) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
};

/**
 * The family screenshot wall: pictures taken while playing (Ctrl+Shift+S in the app) or uploaded
 * from a phone, newest first, with emoji reactions.
 */
export function Screenshots() {
  const [shots, setShots] = useState<Screenshot[] | null>(null);
  const [more, setMore] = useState(true);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    api.screenshots({ limit: 30 }).then(
      (s) => {
        setShots(s);
        setMore(s.length === 30);
      },
      (e: Error) => setError(e.message),
    );
  useLive("screenshots", () => void load());
  useEffect(() => void load(), []);
  const update = (s: Screenshot) => setShots((list) => list?.map((x) => (x.id === s.id ? s : x)) ?? null);
  const shown = open === null ? null : (shots?.find((s) => s.id === open) ?? null);

  return (
    <div className="screenshot-wall">
      <header className="page-head">
        <h1>📸 Family wall</h1>
        <p className="muted">
          {desktop ? "Press Ctrl+Shift+S while you play to share what's on screen." : "In the LootDen app, press Ctrl+Shift+S while you play to share what's on screen."} Or upload a picture
          from this device.
        </p>
      </header>
      <Uploader onDone={() => void load()} />
      {error && <p className="error">{error}</p>}
      {shots && !shots.length && <p className="muted">No screenshots yet. Be the first!</p>}
      <div className="shot-grid">
        {shots?.map((s) => (
          <ShotCard key={s.id} shot={s} onOpen={() => setOpen(s.id)} onChange={update} />
        ))}
      </div>
      {more && shots && shots.length > 0 && (
        <p>
          <button
            className="button"
            onClick={() =>
              void api.screenshots({ before: shots.at(-1)!.id, limit: 30 }).then((s) => {
                setShots([...shots, ...s]);
                setMore(s.length === 30);
              })
            }
          >
            Show older
          </button>
        </p>
      )}
      {shown && (
        <Lightbox
          shot={shown}
          onClose={() => setOpen(null)}
          onChange={update}
          onDelete={() => {
            if (!confirm("Delete this screenshot?")) return;
            void api.deleteScreenshot(shown.id).then(() => {
              setOpen(null);
              void load();
            });
          }}
        />
      )}
    </div>
  );
}

function Reactions({ shot, onChange }: { shot: Screenshot; onChange: (s: Screenshot) => void }) {
  return (
    <div className="shot-reactions">
      {SCREENSHOT_REACTIONS.map((e) => {
        const r = shot.reactions.find((x) => x.emoji === e);
        return (
          <button key={e} className={`reaction${r?.mine ? " mine" : ""}`} aria-pressed={!!r?.mine} aria-label={`React ${e}`} onClick={() => void api.reactToScreenshot(shot.id, e).then(onChange)}>
            {e}
            {r ? <span>{r.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function ShotCard({ shot, onOpen, onChange }: { shot: Screenshot; onOpen: () => void; onChange: (s: Screenshot) => void }) {
  return (
    <figure className="shot-card panel">
      <button className="shot-open" onClick={onOpen} aria-label={`Open ${shot.by.name}'s screenshot`}>
        <img src={shot.imageUrl} alt={shot.caption ?? `${shot.by.name}'s screenshot${shot.game ? ` from ${shot.game.title}` : ""}`} loading="lazy" />
      </button>
      <figcaption>
        <span className="shot-who">
          <img src={avatarUrl(shot.by.avatar)} alt="" width={24} height={24} className="avatar" />
          <strong>{shot.by.name}</strong>
          <span className="muted small">{ago(shot.createdAt)}</span>
        </span>
        {shot.game && <span className="small">{shot.game.id ? <Link to={`/games/${shot.game.id}`}>{shot.game.title}</Link> : shot.game.title}</span>}
        {shot.caption && <span className="small">“{shot.caption}”</span>}
        <Reactions shot={shot} onChange={onChange} />
      </figcaption>
    </figure>
  );
}

function Lightbox({ shot, onClose, onChange, onDelete }: { shot: Screenshot; onClose: () => void; onChange: (s: Screenshot) => void; onDelete: () => void }) {
  useEscape(onClose);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Screenshot" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lightbox-body">
        <img src={shot.imageUrl} alt={shot.caption ?? ""} className="lightbox-image" />
        <div className="shot-lightbox-bar">
          <span>
            <strong>{shot.by.name}</strong>
            {shot.game ? ` · ${shot.game.title}` : ""}
            {shot.caption ? ` · “${shot.caption}”` : ""}
          </span>
          <Reactions shot={shot} onChange={onChange} />
          <a className="button small" href={shot.imageUrl} download>
            Download
          </a>
          {shot.canDelete && (
            <button className="button small danger" onClick={onDelete}>
              Delete
            </button>
          )}
          <button className="button small" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Uploader({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="inline-form shot-upload"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        setBusy(true);
        try {
          await api.uploadScreenshot(file, { title, caption });
          setMsg({ text: "Shared! 📸" });
          setFile(null);
          setTitle("");
          setCaption("");
          (e.target as HTMLFormElement).reset();
          onDone();
        } catch (err) {
          setMsg({ text: (err as Error).message, error: true });
        } finally {
          setBusy(false);
        }
      }}
    >
      <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Picture" />
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Game (optional)" maxLength={200} aria-label="Game" />
      <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Say something (optional)" maxLength={140} aria-label="Caption" />
      <button className="button primary" disabled={!file || busy}>
        Share
      </button>
      {msg && (
        <span className={msg.error ? "error small" : "notice small"} role="status">
          {msg.text}
        </span>
      )}
    </form>
  );
}

/** Home: the newest screenshots, when there are any. */
export function HomeScreenshots() {
  const [shots, setShots] = useState<Screenshot[]>([]);
  const load = () => api.screenshots({ limit: 8 }).then(setShots, () => {});
  useLive("screenshots", () => void load());
  useEffect(() => void load(), []);
  if (!shots.length) return null;
  return (
    <section className="row">
      <div className="row-head">
        <h2>📸 From the family wall</h2>
        <Link to="/screenshots" className="muted small">
          See them all
        </Link>
      </div>
      <div className="shot-strip">
        {shots.map((s) => (
          <Link key={s.id} to="/screenshots" className="shot-mini" title={`${s.by.name}${s.game ? ` · ${s.game.title}` : ""}`}>
            <img src={s.imageUrl} alt="" loading="lazy" />
            <span className="small">
              {s.by.name}
              {s.reactions.length ? ` · ${s.reactions.map((r) => r.emoji).join("")}` : ""}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
