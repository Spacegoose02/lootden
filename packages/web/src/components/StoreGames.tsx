import { useState } from "react";
import { Link } from "react-router-dom";
import { duplicateKey, type LocalStoreGame, type StoreGame } from "@lootden/shared";
import { StoreGameCard, storeKey } from "./StoreGameCard";

/**
 * All games: store games under the LootDen ones (or alone, when one store is picked), so one
 * library and one search cover everything.
 */
export function StoreSection({
  games,
  installed,
  scanned,
  search,
  store,
  all,
  onlyInstalled,
  limit,
  keep,
  libraryIds,
}: {
  games: StoreGame[];
  installed: Map<string, LocalStoreGame>;
  scanned?: boolean;
  search: string;
  /** One store's games alone. */
  store: string;
  /** Every store's games alone, without the LootDen ones above them. */
  all?: boolean;
  /** Only the ones installed on this PC. */
  onlyInstalled?: boolean;
  limit?: number;
  /** Favourites, hidden games and tags: which games pass. */
  keep?: (g: StoreGame) => boolean;
  /** The LootDen games shown above: the same game on a store merges into them instead of showing twice. */
  libraryIds?: Set<string>;
}) {
  const [error, setError] = useState("");
  const q = search.trim().toLowerCase();
  const alone = all || !!store;
  const filtered = games
    .filter((g) => (!q || g.title.toLowerCase().includes(q)) && (!store || g.addon === store) && (!onlyInstalled || installed.has(storeKey(g))) && (!keep || keep(g)))
    // Already shown as a LootDen game above (its page has "Also on" with Play there).
    .filter((g) => !(libraryIds && g.libraryGameId && libraryIds.has(g.libraryGameId)));
  // The same game on several stores is one card; the installed copy (or the first store) leads.
  const groups = new Map<string, StoreGame[]>();
  for (const g of filtered) {
    const k = store ? storeKey(g) : duplicateKey(g);
    groups.set(k, [...(groups.get(k) ?? []), g]);
  }
  const lead = (list: StoreGame[]) => [...list].sort((a, b) => Number(installed.has(storeKey(b))) - Number(installed.has(storeKey(a))) || (b.playtimeSeconds ?? 0) - (a.playtimeSeconds ?? 0))[0]!;
  const others = new Map<string, StoreGame[]>();
  const matches = [...groups.values()]
    .map((list) => {
      const first = lead(list);
      others.set(storeKey(first), list.filter((x) => x !== first));
      return first;
    })
    .sort((a, b) => a.title.localeCompare(b.title));
  if (!matches.length) return alone ? <p className="muted">{store ? "No games from that store match." : "No games from your other stores match."}</p> : null;
  const shown = limit ? matches.slice(0, limit) : matches;
  return (
    <section className="store-matches">
      {!alone && <h2 className="collection-title">On your other stores</h2>}
      {alone && <p className="muted count">{matches.length} games</p>}
      {error && <p className="error">{error}</p>}
      <div className="grid store-grid" data-nav-zone>
        {shown.map((g) => (
          <StoreGameCard key={storeKey(g)} game={g} local={installed.get(storeKey(g))} scanned={scanned} onError={setError} alsoOn={others.get(storeKey(g))?.map((x) => x.store)} />
        ))}
      </div>
      {shown.length < matches.length && (
        <p>
          <Link to="/library?tab=all&source=stores" className="button ghost">
            See all {matches.length} from your other stores
          </Link>
        </p>
      )}
    </section>
  );
}
