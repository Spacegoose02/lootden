import { useEffect, useState } from "react";
import type { WorkshopItem, WorkshopSettings } from "@lootden/shared";
import { api, BACKLOG, BACKLOG_LABELS, formatBytes, type BacklogStatus, type Journal, type NexusMod, type TimeToBeat, type VersionCheck } from "../api";
import { bridgeError, desktop, type InstalledWorkshopItem } from "../desktop";

const SOURCE: Record<string, string> = { gog: "GOG", steam: "Steam", itch: "itch.io" };

/** "Update available" when this copy is behind the store; admins can check on demand. */
export function VersionBanner({ gameId, isAdmin }: { gameId: string; isAdmin: boolean }) {
  const [v, setV] = useState<VersionCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setV(null);
    api.version(gameId).then(setV, () => {});
  }, [gameId]);
  const check = async () => {
    setBusy(true);
    setError("");
    try {
      setV(await api.checkVersion(gameId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!v && !isAdmin) return null;
  return (
    <div className={`version-line${v?.behind ? " behind" : ""}`}>
      {v?.behind ? (
        <span>
          <strong>Update available</strong>
          {v.latest ? ` · ${v.latest.match(/^\d/) ? "v" : ""}${v.latest}` : ""} on {SOURCE[v.source ?? ""] ?? "the store"}
          {v.current ? ` (this copy is v${v.current})` : ""}
          {v.url && (
            <>
              {" · "}
              <a href={v.url} target="_blank" rel="noreferrer">
                What changed
              </a>
            </>
          )}
        </span>
      ) : v ? (
        <small className="muted">
          {v.current ? `v${v.current} · ` : ""}
          {v.detail} · checked {new Date(v.checkedAt).toLocaleDateString()}
        </small>
      ) : (
        <small className="muted">Not checked for updates yet</small>
      )}
      {isAdmin && (
        <button className="ghost small" disabled={busy} onClick={() => void check()}>
          {busy ? "Checking…" : "Check for updates"}
        </button>
      )}
      {error && <small className="error">{error}</small>}
    </div>
  );
}

const hrs = (h: number | null) => (h == null ? "–" : `${h} h`);

/** The player's own backlog status, rating, notes and dated journal, plus Time to Beat. */
export function JournalPanel({ gameId }: { gameId: string }) {
  const [j, setJ] = useState<Journal | null>(null);
  const [ttb, setTtb] = useState<TimeToBeat | null | undefined>(undefined);
  const [notes, setNotes] = useState("");
  const [entry, setEntry] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    api.journal(gameId).then((x) => {
      setJ(x);
      setNotes(x.notes);
    }, () => setJ(null));
    api.timeToBeat(gameId).then(setTtb, () => setTtb(null));
  }, [gameId]);
  if (!j) return null;
  const save = async (fn: () => Promise<Journal>) => {
    setError("");
    try {
      const x = await fn();
      setJ(x);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="panel journal">
      <div className="journal-head">
        <h2>My journal</h2>
        {ttb && (ttb.main || ttb.normally || ttb.completely) ? (
          <div className="ttb" title={ttb.source === "hltb" ? `From ${ttb.count.toLocaleString()} HowLongToBeat players` : `From ${ttb.count} IGDB players`}>
            <span>
              <small className="muted">Main story</small>
              <strong>{hrs(ttb.main)}</strong>
            </span>
            <span>
              <small className="muted">Main + extras</small>
              <strong>{hrs(ttb.normally)}</strong>
            </span>
            <span>
              <small className="muted">Completionist</small>
              <strong>{hrs(ttb.completely)}</strong>
            </span>
            {ttb.source === "hltb" && ttb.url && (
              <a className="small muted" href={ttb.url} target="_blank" rel="noreferrer">
                HowLongToBeat
              </a>
            )}
          </div>
        ) : null}
      </div>
      <div className="segmented wrap" role="radiogroup" aria-label="Status">
        {BACKLOG.map((s) => (
          <button key={s} role="radio" aria-checked={j.status === s} className={j.status === s ? "active" : ""} onClick={() => void save(() => api.saveJournal(gameId, { status: j.status === s ? null : (s as BacklogStatus) }))}>
            {BACKLOG_LABELS[s]}
          </button>
        ))}
      </div>
      <div className="stars" role="radiogroup" aria-label="My rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} role="radio" aria-checked={j.rating === n} aria-label={`${n} star${n > 1 ? "s" : ""}`} className={j.rating && n <= j.rating ? "on" : ""} onClick={() => void save(() => api.saveJournal(gameId, { rating: j.rating === n ? null : n }))}>
            ★
          </button>
        ))}
      </div>
      <label className="field wide">
        <span className="field-label">Notes</span>
        <textarea rows={3} value={notes} placeholder="Where you are, what to try next, codes…" onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== j.notes && void save(() => api.saveJournal(gameId, { notes }))} />
      </label>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (!entry.trim()) return;
          void save(() => api.addJournalEntry(gameId, entry)).then(() => setEntry(""));
        }}
      >
        <input placeholder="Add a dated entry: what happened this session" value={entry} onChange={(e) => setEntry(e.target.value)} style={{ flex: 1 }} />
        <button disabled={!entry.trim()}>Add</button>
      </form>
      {error && <p className="error small">{error}</p>}
      {j.entries.length > 0 && (
        <ul className="journal-entries">
          {j.entries.map((e) => (
            <li key={e.id}>
              <small className="muted">{new Date(e.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</small>
              <p>{e.text}</p>
              <button className="ghost small" aria-label="Delete entry" onClick={() => void api.deleteJournalEntry(e.id).then(() => api.journal(gameId).then(setJ))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Trending NexusMods mods for this game, once a NexusMods key is saved in Settings. */
export function ModsPanel({ gameId, title }: { gameId: string; title: string }) {
  const [data, setData] = useState<{ configured: boolean; domain: string | null; mods: NexusMod[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setData(null);
    setError("");
    api.mods(gameId).then(setData, (e: Error) => setError(e.message));
  }, [gameId]);
  // With a key saved the section always shows, so a title NexusMods doesn't know (or a rejected key) says so instead of vanishing.
  if (!error && !data?.configured) return null;
  const search = `https://www.nexusmods.com/games?keyword=${encodeURIComponent(title)}`;
  return (
    <section className="row mods">
      <div className="inline" style={{ justifyContent: "space-between" }}>
        <h2>Trending mods</h2>
        <a className="small" href={data?.domain ? `https://www.nexusmods.com/${data.domain}/mods/trending` : search} target="_blank" rel="noreferrer">
          {data?.domain ? "More on NexusMods" : "Search NexusMods"}
        </a>
      </div>
      {error ? (
        <p className="muted small">Couldn't load mods: {error}</p>
      ) : !data!.domain ? (
        <p className="muted small">NexusMods has no game matching this title, or it isn't a game NexusMods hosts mods for.</p>
      ) : !data!.mods.length ? (
        <p className="muted small">No trending mods for this game right now.</p>
      ) : (
        <div className="row-track mod-track">
          {data!.mods.map((m) => (
            <a key={m.id} className="mod-card" href={m.url} target="_blank" rel="noreferrer">
              {m.picture ? <img src={m.picture} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="mod-blank" />}
              <strong>{m.name}</strong>
              <small className="muted">
                by {m.author} · {m.endorsements.toLocaleString()} endorsements
              </small>
              <small>{m.summary}</small>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

/** Opens a steam:// link: through the desktop app, or the browser's own handler. */
const openSteam = (url: string) => (desktop?.launchStore ? desktop.launchStore(url) : Promise.resolve(void (window.location.href = url)));

/**
 * Steam Workshop items for a PC game with a Steam app id: popular items and search (with a
 * Steam Web API key), or items from pasted links, installed into the game's mods folder by the app.
 * For a game bought on Steam (steamAppId), Steam downloads the items itself: Subscribe opens
 * the item in Steam instead.
 */
export function WorkshopPanel({ gameId = "", steamAppId, isAdmin, installedHere }: { gameId?: string; steamAppId?: string; isAdmin: boolean; installedHere: boolean }) {
  const onSteam = !!steamAppId;
  const [w, setW] = useState<WorkshopSettings | null>(null);
  const [items, setItems] = useState<WorkshopItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [links, setLinks] = useState("");
  const [mine, setMine] = useState<InstalledWorkshopItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ appId: "", modsPath: "" });
  const canInstall = !onSteam && !!desktop?.installWorkshopItem && installedHere && !!w?.modsPath;

  const loadMine = () => {
    if (!onSteam && desktop?.workshopItems && installedHere) void desktop.workshopItems(gameId).then(setMine, () => setMine([]));
  };
  const load = async (query: string, p: number) => {
    setError("");
    try {
      const r = onSteam ? await api.steamWorkshopItems(steamAppId!, query, p) : await api.workshopItems(gameId, query, p);
      setItems(p === 1 ? r.items : [...(items ?? []), ...r.items]);
      setTotal(r.total);
      setPage(p);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    setW(null);
    setItems(null);
    setMine([]);
    (onSteam ? api.steamWorkshop(steamAppId!) : api.workshop(gameId)).then((x) => {
      setW(x);
      setDraft({ appId: x.appId ?? "", modsPath: x.modsPath });
    }, () => setW(null));
  }, [gameId, steamAppId]);
  useEffect(() => {
    if (w?.appId && w.canBrowse) void load("", 1);
    if (w?.modsPath) loadMine();
  }, [w?.appId, w?.canBrowse, w?.modsPath]);
  useEffect(() => desktop?.onProgress((p) => p.type === "workshop" && p.gameId === gameId && setLine(p.line)), [gameId]);

  if (!w || (!w.appId && !isAdmin)) return null;
  const has = new Set(mine.map((m) => m.id));

  const install = async (item: WorkshopItem) => {
    setBusy(item.id);
    setLine("Getting SteamCMD ready…");
    setError("");
    try {
      await desktop!.installWorkshopItem!(gameId, item.id, item.title);
      loadMine();
    } catch (e) {
      setError(bridgeError(e));
    } finally {
      setBusy(null);
      setLine("");
    }
  };
  const remove = async (id: string) => {
    setError("");
    try {
      await desktop!.removeWorkshopItem!(gameId, id);
      loadMine();
    } catch (e) {
      setError(bridgeError(e));
    }
  };
  const save = async () => {
    setError("");
    try {
      setW(await api.saveWorkshop(gameId, { appId: draft.appId.trim() || null, modsPath: draft.modsPath }));
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="row workshop">
      <div className="inline" style={{ justifyContent: "space-between" }}>
        <h2>Steam Workshop</h2>
        <span className="inline">
          {w.appId && (
            <a className="small" href={`https://steamcommunity.com/app/${w.appId}/workshop/`} target="_blank" rel="noreferrer">
              Open on Steam
            </a>
          )}
          {onSteam && (
            <button className="ghost small" onClick={() => void openSteam(`steam://url/SteamWorkshopPage/${w.appId}`).catch((e) => setError(bridgeError(e)))}>
              Open in Steam
            </button>
          )}
          {isAdmin && !onSteam && (
            <button className="ghost small" onClick={() => setEditing(!editing)}>
              {editing ? "Cancel" : "Set up"}
            </button>
          )}
        </span>
      </div>

      {editing && (
        <form
          className="inline wrap workshop-setup"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="field">
            <span className="field-label">Steam app id</span>
            <input inputMode="numeric" placeholder="620" value={draft.appId} onChange={(e) => setDraft({ ...draft, appId: e.target.value })} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span className="field-label">Mods folder, inside the game's folder</span>
            <input placeholder="Mods" value={draft.modsPath} onChange={(e) => setDraft({ ...draft, modsPath: e.target.value })} />
          </label>
          <button>Save</button>
        </form>
      )}

      {!w.appId ? (
        <p className="muted small">Add this game's Steam app id to browse its Workshop.</p>
      ) : (
        <>
          {mine.length > 0 && <h3 className="small muted">In this game on this PC</h3>}
          {mine.length > 0 && (
            <ul className="pkg-list workshop-mine">
              {mine.map((m) => (
                <li key={m.id}>
                  <div className="pkg-title">
                    <strong>{m.title}</strong>
                    <span className="muted small">added {new Date(m.installedAt).toLocaleDateString()}</span>
                  </div>
                  <button className="ghost small" onClick={() => void remove(m.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="inline wrap">
            {w.canBrowse && (
              <form
                className="inline"
                style={{ flex: 2 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void load(q.trim(), 1);
                }}
              >
                <input type="search" placeholder="Search the Workshop" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
                <button className="ghost">Search</button>
              </form>
            )}
            <form
              className="inline"
              style={{ flex: 2 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (!links.trim()) return;
                setError("");
                (onSteam ? api.steamWorkshopLinks(steamAppId!, links) : api.workshopLinks(gameId, links)).then((r) => (setItems(r.items), setTotal(r.total), setPage(1)), (err: Error) => setError(err.message));
              }}
            >
              <input placeholder="Paste Workshop links or ids" value={links} onChange={(e) => setLinks(e.target.value)} style={{ flex: 1 }} />
              <button className="ghost" disabled={!links.trim()}>
                Look up
              </button>
            </form>
          </div>
          {!w.canBrowse && <p className="muted small">Paste links to items, or save a Steam Web API key under Integrations to browse and search here.</p>}
          {onSteam ? (
            <p className="muted small">Subscribe to an item and Steam downloads it into the game, and keeps it up to date.</p>
          ) : (
            <>
              {desktop && !installedHere && <p className="muted small">Install the game on this PC to add Workshop items to it.</p>}
              {desktop && installedHere && !w.modsPath && <p className="muted small">{isAdmin ? "Set" : "An admin needs to set"} the game's mods folder before items can be added.</p>}
              {!desktop && <p className="muted small">The LootDen app adds Workshop items to games installed on your PC.</p>}
            </>
          )}
          {line && <p className="muted small workshop-line">{line}</p>}
          {error && <p className="error small">{error}</p>}
          {items && !items.length && <p className="muted small">Nothing found.</p>}
          {items && items.length > 0 && (
            <div className="row-track mod-track">
              {items.map((m) => (
                <div key={m.id} className="mod-card workshop-card">
                  {m.previewUrl ? <img src={m.previewUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="mod-blank" />}
                  <strong>{m.title}</strong>
                  <small className="muted">
                    {m.sizeBytes ? `${formatBytes(m.sizeBytes)} · ` : ""}
                    {m.subscriptions.toLocaleString()} subscribers
                  </small>
                  <span className="inline">
                    {canInstall &&
                      (has.has(m.id) ? (
                        <button className="ghost small" disabled={!!busy} onClick={() => void install(m)}>
                          {busy === m.id ? "Updating…" : "Update"}
                        </button>
                      ) : (
                        <button className="small" disabled={!!busy} onClick={() => void install(m)}>
                          {busy === m.id ? "Adding…" : "Add to game"}
                        </button>
                      ))}
                    {onSteam && (
                      <button className="small" onClick={() => void openSteam(`steam://url/CommunityFilePage/${m.id}`).catch((e) => setError(bridgeError(e)))}>
                        Subscribe in Steam
                      </button>
                    )}
                    <a className="small" href={m.url} target="_blank" rel="noreferrer">
                      Steam page
                    </a>
                  </span>
                  <small>{m.summary}</small>
                </div>
              ))}
            </div>
          )}
          {items && items.length < total && (
            <button className="ghost small" onClick={() => void load(q.trim(), page + 1)}>
              Show more
            </button>
          )}
        </>
      )}
    </section>
  );
}
