import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { LocalStoreGame, StoreGame } from "@lootden/shared";
import { api, formatPlaytime } from "../api";
import { bridgeError, desktop } from "../desktop";
import { Cover } from "./Cover";

const SORTS = [
  ["title", "Title"],
  ["played", "Recently played"],
  ["playtime", "Most played"],
] as const;
type Sort = (typeof SORTS)[number][0];

/** Library, Other stores: games from the accounts connected under Profile, Game libraries. */
export function StoreGames() {
  const [games, setGames] = useState<StoreGame[] | null>(null);
  const [local, setLocal] = useState<LocalStoreGame[]>([]);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [store, setStore] = useState("");
  const [sort, setSort] = useState<Sort>("title");
  const [onlyInstalled, setOnlyInstalled] = useState(false);

  useEffect(() => {
    api.storeGames().then(setGames, (e: Error) => setError(e.message));
    desktop?.storeGames?.().then(setLocal, () => setLocal([]));
  }, []);

  const installed = useMemo(() => new Set(local.map((l) => `${l.addon}:${l.externalId}`)), [local]);
  if (error) return <p className="error">{error}</p>;
  if (!games) return <p className="muted">Loading…</p>;
  if (!games.length)
    return (
      <div className="panel empty">
        <p>No games from other stores yet.</p>
        <p className="muted">
          Connect your store accounts under <Link to="/profile">Profile, Game libraries</Link> and the games you own there show up here.
        </p>
      </div>
    );

  const stores = [...new Map(games.map((g) => [g.addon, g.store])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const q = search.trim().toLowerCase();
  const time = (s: string | null) => (s ? Date.parse(s) : 0);
  const isInstalled = (g: StoreGame) => installed.has(`${g.addon}:${g.externalId}`);
  const shown = games
    .filter((g) => (!q || g.title.toLowerCase().includes(q)) && (!store || g.addon === store) && (!onlyInstalled || isInstalled(g)))
    .sort((a, b) =>
      sort === "played" ? time(b.lastPlayedAt) - time(a.lastPlayedAt) : sort === "playtime" ? (b.playtimeSeconds ?? 0) - (a.playtimeSeconds ?? 0) : a.title.localeCompare(b.title),
    );

  const play = async (g: StoreGame) => {
    setError("");
    try {
      if (desktop?.launchStore) await desktop.launchStore(g.launchUrl!);
      else window.location.href = g.launchUrl!;
    } catch (e) {
      setError(bridgeError(e));
    }
  };

  return (
    <>
      <div className="filters panel">
        <input type="search" placeholder="Search your other stores" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
        {stores.length > 1 && (
          <select value={store} onChange={(e) => setStore(e.target.value)} aria-label="Store">
            <option value="">All stores</option>
            {stores.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          {SORTS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        {desktop?.storeGames && (
          <label className="check">
            <input type="checkbox" checked={onlyInstalled} onChange={(e) => setOnlyInstalled(e.target.checked)} /> Installed on this PC
          </label>
        )}
      </div>
      <p className="muted count">
        {shown.length} of {games.length} games
      </p>
      <div className="grid store-grid">
        {shown.map((g) => (
          <div key={`${g.addon}:${g.externalId}`} className="card store-card">
            <Cover game={{ id: `${g.addon}:${g.externalId}`, title: g.title, coverUrl: g.coverUrl }} />
            {isInstalled(g) && <span className="installed-dot" title="Installed on this PC" />}
            <div className="card-body">
              <div className="card-title" title={g.title}>
                {g.title}
              </div>
              <div className="card-meta">
                <span className="badge">{g.store}</span>
                {g.playtimeSeconds ? ` ${formatPlaytime(g.playtimeSeconds)}` : ""}
              </div>
              <div className="store-actions">
                {g.launchUrl && (
                  <button className="small primary" onClick={() => play(g)} title={isInstalled(g) ? "Start it through the store's launcher" : "Opens the store's launcher to install or play it"}>
                    {isInstalled(g) ? "▶ Play" : "Play"}
                  </button>
                )}
                {g.libraryGameId && (
                  <Link className="button small secondary" to={`/games/${g.libraryGameId}`} title="This game is on your LootDen server too">
                    In LootDen
                  </Link>
                )}
                {g.storeUrl && (
                  <a className="button small ghost" href={g.storeUrl} target="_blank" rel="noreferrer">
                    Store
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
