import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { GameListing } from "@lootden/shared";
import { api, type ListingResult } from "../api";
import { useAuth } from "../auth";
import { discoverPath } from "../components/Listing";
import { RequestButton } from "./Requests";

const RANGES = [30, 90, 180] as const;
const PAST = [0, 30, 90] as const;

/** Upcoming releases grouped by month, then by day. */
export function Calendar() {
  const { me } = useAuth();
  const canRequest = me?.role !== "admin";
  const [days, setDays] = useState<number>(90);
  const [platform, setPlatform] = useState<"pc" | "all">("pc");
  const [past, setPast] = useState<number>(0);
  const [data, setData] = useState<(ListingResult & { error?: string }) | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [reload, setReload] = useState(0);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    setError("");
    api.calendar(days, platform, past).then(setData, (e: Error) => setError(e.message));
  }, [days, platform, past, reload]);

  const remove = async (id: string) => {
    try {
      await api.deleteCalendarEntry(id);
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const months = useMemo(() => {
    const out = new Map<string, { dated: Map<string, GameListing[]>; vague: GameListing[] }>();
    const later: GameListing[] = [];
    for (const item of data?.items ?? []) {
      if (!item.releaseDate) {
        later.push(item);
        continue;
      }
      const month = item.releaseDate.slice(0, 7);
      if (!out.has(month)) out.set(month, { dated: new Map(), vague: [] });
      const m = out.get(month)!;
      m.dated.set(item.releaseDate, [...(m.dated.get(item.releaseDate) ?? []), item]);
    }
    return { months: [...out.entries()], later };
  }, [data]);

  return (
    <div className="calendar">
      <div className="inline" style={{ justifyContent: "space-between" }}>
        <h1>Release calendar</h1>
        <div className="inline">
          <div className="segmented" role="tablist" aria-label="Platforms">
            {(["pc", "all"] as const).map((p) => (
              <button key={p} role="tab" aria-selected={platform === p} className={platform === p ? "active" : ""} onClick={() => setPlatform(p)}>
                {p === "pc" ? "PC" : "All platforms"}
              </button>
            ))}
          </div>
          <div className="segmented" role="tablist" aria-label="Past">
            {PAST.map((d) => (
              <button key={d} role="tab" aria-selected={past === d} className={past === d ? "active" : ""} onClick={() => setPast(d)}>
                {d === 0 ? "From today" : d === 30 ? "Last month too" : "Last 3 months too"}
              </button>
            ))}
          </div>
          <div className="segmented" role="tablist" aria-label="Range">
            {RANGES.map((d) => (
              <button key={d} role="tab" aria-selected={days === d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>
                {d === 30 ? "Month" : d === 90 ? "3 months" : "6 months"}
              </button>
            ))}
          </div>
          {!me?.user?.kidMode && (
            <button className="primary" onClick={() => setAdding(!adding)} aria-expanded={adding}>
              Add a date
            </button>
          )}
        </div>
      </div>
      {adding && (
        <AddEntry
          onAdded={() => {
            setAdding(false);
            setReload((n) => n + 1);
          }}
        />
      )}
      {data?.error && <p className="error small">Couldn't load store releases right now: {data.error}</p>}
      {data && data.source && (
        <p className="muted small">
          From {data.source}, plus your wishlist and dates people added.
          {data.source === "Steam" &&
            (me?.role === "admin" ? (
              <>
                {" "}
                Steam only lists PC games and often has no exact date; add an IGDB or RAWG key in <Link to="/settings/services">Settings</Link> for a fuller calendar.
              </>
            ) : (
              " Steam only lists PC games."
            ))}
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && data.items.length === 0 && <p className="muted">Nothing announced for this range.</p>}
      {months.months.map(([month, m]) => (
        <section key={month} className="cal-month">
          <h2>{new Date(`${month}-15T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
          {[...m.dated.entries()].map(([date, items]) => (
            <div key={date} className={`cal-day${date < today ? " past" : date === today ? " today" : ""}`}>
              <div className="cal-date">
                <span className="cal-dow">{new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" })}</span>
                <span className="cal-num">{Number(date.slice(8))}</span>
              </div>
              <div className="cal-games">
                {items.map((i) => (
                  <CalendarGame key={`${i.provider}:${i.providerId}`} item={i} onDelete={remove} canRequest={canRequest} />
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
      {months.later.length > 0 && (
        <section className="cal-month">
          <h2>Date to be confirmed</h2>
          <div className="cal-games loose">
            {months.later.map((i) => (
              <CalendarGame key={`${i.provider}:${i.providerId}`} item={i} onDelete={remove} canRequest={canRequest} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** A date of your own: a launch party, a beta weekend, a sale ending. */
function AddEntry({ onAdded }: { onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.addCalendarEntry({ title, date, note, url });
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="panel cal-add" onSubmit={submit}>
      <div className="inline wrap">
        <input placeholder="What's happening (e.g. Elden Ring DLC launch party)" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 2, minWidth: 220 }} autoFocus />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
      </div>
      <div className="inline wrap">
        <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <input type="url" placeholder="Link (optional)" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <button className="primary" disabled={!title.trim() || !date}>
          Add
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

function CalendarGame({ item, onDelete, canRequest }: { item: GameListing; onDelete: (id: string) => void; canRequest: boolean }) {
  const image = item.coverUrl ?? item.imageUrl;
  if (item.provider === "custom") {
    return (
      <div className="cal-game custom">
        <span className="cal-cover blank cal-pin" aria-hidden="true">
          ★
        </span>
        <span>
          <strong>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.name}</a> : item.name}</strong>
          {item.note && <span className="muted small">{item.note}</span>}
          <span className="tag">Custom date</span>
        </span>
        {item.canDelete && (
          <button className="ghost small" title="Remove this date" onClick={() => onDelete(item.providerId)}>
            Remove
          </button>
        )}
      </div>
    );
  }
  const inner = (
    <>
      {image ? <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" className={item.coverUrl ? "cal-cover" : "cal-wide"} /> : <span className="cal-cover blank" />}
      <span>
        <strong>{item.name}</strong>
        <span className="muted small">{[item.dateText, item.platforms.slice(0, 4).join(", "), item.genres.slice(0, 2).join(", ")].filter(Boolean).join(" · ")}</span>
        {item.libraryId && <span className="tag in-library">In library</span>}
        {item.wishlisted && <span className="tag wished">On wishlist</span>}
      </span>
    </>
  );
  const steamApp = item.provider === "wishlist" ? item.url?.match(/\/app\/(\d+)/)?.[1] : null;
  const to = item.libraryId ? `/games/${item.libraryId}` : item.provider === "wishlist" ? (steamApp ? `/discover/steam/${steamApp}` : "/wishlist") : discoverPath(item);
  const link = (
    <Link to={to} className="cal-game">
      {inner}
    </Link>
  );
  // Upcoming games can be asked for too: approved, they're searched for until they're out.
  if (!canRequest || item.libraryId) return link;
  return (
    <div className="cal-game-line">
      {link}
      <RequestButton game={{ name: item.name, url: item.url, coverUrl: item.coverUrl ?? item.imageUrl, provider: item.provider, providerId: item.providerId }} small />
    </div>
  );
}
