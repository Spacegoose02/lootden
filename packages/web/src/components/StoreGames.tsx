import { useState } from "react";
import { Link } from "react-router-dom";
import type { LocalStoreGame, StoreGame } from "@lootden/shared";
import { desktop } from "../desktop";
import { StoreGameCard, storeKey, useStoreGames } from "./StoreGameCard";

const SORTS = [
  ["title", "Title"],
  ["played", "Recently played"],
  ["playtime", "Most played"],
] as const;
type Sort = (typeof SORTS)[number][0];

/** Library, Other stores: games from the accounts connected under Profile, Game libraries, and store games on this PC. */
export function StoreGames() {
  const { games: all, installed, error: loadError } = useStoreGames();
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [store, setStore] = useState("");
  const [sort, setSort] = useState<Sort>("title");
  const [onlyInstalled, setOnlyInstalled] = useState(false);

  if (loadError && !all?.length) return <p className="error">{loadError}</p>;
  if (!all) return <p className="muted">Loading…</p>;
  if (!all.length)
    return (
      <div className="panel empty">
        <p>No games from other stores yet.</p>
        <p className="muted">
          Connect your store accounts under <Link to="/profile">Profile, Game libraries</Link> and the games you own there show up here.
        </p>
      </div>
    );

  const stores = [...new Map(all.map((g) => [g.addon, g.store])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const q = search.trim().toLowerCase();
  const time = (s: string | null) => (s ? Date.parse(s) : 0);
  const isInstalled = (g: StoreGame) => installed.has(storeKey(g));
  const shown = all
    .filter((g) => (!q || g.title.toLowerCase().includes(q)) && (!store || g.addon === store) && (!onlyInstalled || isInstalled(g)))
    .sort((a, b) =>
      sort === "played" ? time(b.lastPlayedAt) - time(a.lastPlayedAt) : sort === "playtime" ? (b.playtimeSeconds ?? 0) - (a.playtimeSeconds ?? 0) : a.title.localeCompare(b.title),
    );

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
      {error && <p className="error">{error}</p>}
      <p className="muted count">
        {shown.length} of {all.length} games
      </p>
      <div className="grid store-grid">
        {shown.map((g) => (
          <StoreGameCard key={storeKey(g)} game={g} local={installed.get(storeKey(g))} onError={setError} />
        ))}
      </div>
    </>
  );
}

/**
 * All games: store games under the LootDen ones (or alone, when one store is picked), so one
 * library and one search cover everything.
 */
export function StoreSection({ games, installed, search, store, limit }: { games: StoreGame[]; installed: Map<string, LocalStoreGame>; search: string; store: string; limit?: number }) {
  const [error, setError] = useState("");
  const q = search.trim().toLowerCase();
  const matches = games.filter((g) => (!q || g.title.toLowerCase().includes(q)) && (!store || g.addon === store));
  if (!matches.length) return store ? <p className="muted">No games from that store match.</p> : null;
  const shown = limit ? matches.slice(0, limit) : matches;
  return (
    <section className="store-matches">
      {!store && <h2 className="collection-title">On your other stores</h2>}
      {store && <p className="muted count">{matches.length} games</p>}
      {error && <p className="error">{error}</p>}
      <div className="grid store-grid">
        {shown.map((g) => (
          <StoreGameCard key={storeKey(g)} game={g} local={installed.get(storeKey(g))} onError={setError} />
        ))}
      </div>
      {shown.length < matches.length && (
        <p>
          <Link to="/library?tab=stores" className="button ghost">
            See all {matches.length} in Other stores
          </Link>
        </p>
      )}
    </section>
  );
}
