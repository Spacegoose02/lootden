import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { RequestButton } from "./Requests";
import { api, formatBytes, type WishItem, type WishlistState } from "../api";
import { useAuth } from "../auth";
import { FindDownloads } from "../components/FindDownloads";
import { PriceSettingsPanel, WishPriceLine } from "../components/Integrations";
import type { WishPrices } from "../api";

type Filter = "all" | "wanted" | "missing" | "owned" | "upcoming";

const when = (w: WishItem) => {
  if (w.releaseDate) {
    const d = new Date(`${w.releaseDate}T12:00:00`);
    const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return d.getTime() > Date.now() ? `Out ${label}` : `Released ${label}`;
  }
  return w.dateText ?? null;
};

/**
 * Games the household wants: the Steam wishlist, list feeds and anything added by hand, one entry
 * per game. Everyone but admins can request a game from here; kid profiles see it but don't change it.
 */
export function Wishlist() {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const kid = !!me?.user?.kidMode;
  const [data, setData] = useState<WishlistState | null>(null);
  // Covers whose address didn't load: they show the letter instead of a broken image.
  const [brokenArt, setBrokenArt] = useState<Set<string>>(() => new Set());
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [title, setTitle] = useState("");
  const [finding, setFinding] = useState<WishItem | null>(null);
  const [prices, setPrices] = useState<WishPrices | null>(null);

  useEffect(() => {
    api.wishlist().then(setData, (e: Error) => setMsg({ text: e.message, error: true }));
    api.wishPrices().then(setPrices, () => setPrices(null));
  }, []);

  const run = async (fn: () => Promise<WishlistState>, done?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      setData(await fn());
      if (done) setMsg({ text: done });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const items = useMemo(() => {
    const all = data?.items ?? [];
    const today = new Date().toISOString().slice(0, 10);
    if (filter === "missing") return all.filter((i) => !i.libraryId);
    if (filter === "wanted") return all.filter((i) => i.monitored && !i.libraryId).sort((a, b) => Number(!!b.found) - Number(!!a.found));
    if (filter === "owned") return all.filter((i) => i.libraryId);
    if (filter === "upcoming") return all.filter((i) => (i.releaseDate ? i.releaseDate > today : !!i.dateText)).sort((a, b) => (a.releaseDate ?? "9999").localeCompare(b.releaseDate ?? "9999"));
    return all;
  }, [data, filter]);

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    void run(() => api.addWish(title.trim()), `Added ${title.trim()}`).then(() => setTitle(""));
  };

  const noSources = !!data && !data.steam?.steamId && data.feeds.length === 0;

  return (
    <div className="wishlist">
      <div className="inline" style={{ justifyContent: "space-between" }}>
        <h1>Wishlist</h1>
        <span className="inline">
          {isAdmin && (
            <Link className="button" to="/settings/steam">
              Steam ID &amp; feeds
            </Link>
          )}
          {!kid && (
            <button className="primary" disabled={busy || noSources} onClick={() => void run(() => api.syncWishlist(), "Synced")}>
              {busy ? "Working…" : "Sync now"}
            </button>
          )}
        </span>
      </div>

      {data && isAdmin && noSources && (
        <p className="notice">
          Add your Steam ID in <Link to="/settings/steam">Settings, Steam &amp; wishlist</Link> to bring in your Steam wishlist, or add list feeds there.
        </p>
      )}
      {data && !isAdmin && !kid && noSources && <p className="muted">An admin can link a Steam wishlist or add list feeds here. You can add games by hand below.</p>}
      {!isAdmin && <p className="muted small">See something you'd like to play? Request it, and an admin can add it to the library.</p>}

      {!kid && (
        <form className="panel inline" onSubmit={add}>
          <input placeholder="Add a game by name" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
          <button disabled={busy || !title.trim()}>Add</button>
        </form>
      )}
      {msg && <p className={msg.error ? "error" : "notice"}>{msg.text}</p>}
      {prices?.settings && <PriceSettingsPanel data={prices} onChange={setPrices} />}

      {data && (
        <div className="segmented" role="tablist" aria-label="Show">
          {(
            [
              ["all", `All ${data.items.length}`],
              ...(isAdmin ? ([["wanted", `Wanted ${data.items.filter((i) => i.monitored && !i.libraryId).length}`]] as const) : []),
              ["missing", "Not in library"],
              ["owned", "In library"],
              ["upcoming", "Coming out"],
            ] as const
          ).map(([f, label]) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
      )}

      {finding && <FindDownloads game={{ name: finding.title }} onClose={() => setFinding(null)} />}

      {!data && !msg && <p className="muted">Loading…</p>}
      {data && items.length === 0 && <p className="muted">{data.items.length ? "Nothing here with this filter." : "Your wishlist is empty."}</p>}
      <div className="wish-grid">
        {items.map((w) => (
          <div key={w.id} className="wish-card">
            <Link to={w.libraryId ? `/games/${w.libraryId}` : w.steamAppId ? `/discover/steam/${w.steamAppId}` : `/discover?q=${encodeURIComponent(w.title)}`} className="wish-art">
              {w.image && !brokenArt.has(w.image) ? (
                <img src={w.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBrokenArt((b) => new Set(b).add(w.image!))} />
              ) : (
                <span className="wish-blank">{w.title.slice(0, 1)}</span>
              )}
              {w.libraryId && <span className="tag in-library">In library</span>}
            </Link>
            <div className="wish-body">
              <strong>{w.title}</strong>
              {when(w) && <small className="muted">{when(w)}</small>}
              <span className="inline wrap">
                {w.sources.map((s) => (
                  <span key={s.kind === "feed" ? `feed${s.id}` : s.kind} className={`badge small source-${s.kind}`}>
                    {s.name}
                  </span>
                ))}
              </span>
              {prices && !w.libraryId && <WishPriceLine wishId={w.id} data={prices} canEdit={!kid} onChange={setPrices} />}
              {isAdmin && !w.libraryId && <WantedLine w={w} busy={busy} run={run} />}
              <span className="inline wrap wish-actions">
                {w.url && (
                  <a className="button small" href={w.url} target="_blank" rel="noreferrer">
                    {w.steamAppId ? "Steam page" : "Open link"}
                  </a>
                )}
                {isAdmin && !w.libraryId && (
                  <button className="small" onClick={() => setFinding(w)}>
                    All results
                  </button>
                )}
                {!isAdmin && !w.libraryId && <RequestButton game={{ name: w.title, url: w.url, coverUrl: w.image, steamAppId: w.steamAppId }} small />}
                {!kid && (
                  <button className="ghost small" disabled={busy} title="Removed games stay off when syncing" onClick={() => void run(() => api.removeWish(w.id))}>
                    Remove
                  </button>
                )}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const since = (iso: string) => {
  const h = (Date.now() - Date.parse(iso)) / 3600_000;
  return h < 1 ? "just now" : h < 24 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`;
};

/** Admin: whether the game is watched, what the last search found, and Search / Grab. */
function WantedLine({ w, busy, run }: { w: WishItem; busy: boolean; run: (fn: () => Promise<WishlistState>, done?: string) => Promise<void> }) {
  return (
    <div className={`wanted-line${w.monitored ? "" : " off"}`}>
      <label className="check small" title="Watched games are searched automatically when auto-search is on">
        <input type="checkbox" checked={w.monitored} disabled={busy} onChange={(e) => void run(() => api.setMonitored(w.id, e.target.checked))} />
        Watch
      </label>
      {w.downloadId ? (
        <small className="good">Downloading</small>
      ) : w.found ? (
        <span className="found" title={w.found.title}>
          <small>
            <strong>Found:</strong> {w.found.title}
          </small>
          <small className="muted">
            {w.found.indexer} · {formatBytes(w.found.sizeBytes)}
            {w.found.protocol === "torrent" && w.found.seeders != null ? ` · ${w.found.seeders} seeds` : ""}
          </small>
        </span>
      ) : (
        <small className="muted">{w.searchedAt ? `Nothing allowed found ${since(w.searchedAt)}` : "Not searched yet"}</small>
      )}
      <span className="inline">
        <button className="small ghost" disabled={busy} onClick={() => void run(() => api.searchWanted(w.id), `Searched for ${w.title}`)}>
          Search now
        </button>
        {w.found && !w.downloadId && (
          <button className="small primary" disabled={busy} onClick={() => void run(() => api.grabWanted(w.id), `Sent ${w.found!.title} to the download client`)}>
            Grab
          </button>
        )}
      </span>
    </div>
  );
}
