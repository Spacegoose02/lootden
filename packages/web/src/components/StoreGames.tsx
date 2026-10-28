import { useState } from "react";
import { Link } from "react-router-dom";
import type { LocalStoreGame, StoreGame } from "@lootden/shared";
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
}) {
  const [error, setError] = useState("");
  const q = search.trim().toLowerCase();
  const alone = all || !!store;
  const matches = games
    .filter((g) => (!q || g.title.toLowerCase().includes(q)) && (!store || g.addon === store) && (!onlyInstalled || installed.has(storeKey(g))))
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
          <StoreGameCard key={storeKey(g)} game={g} local={installed.get(storeKey(g))} scanned={scanned} onError={setError} />
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
