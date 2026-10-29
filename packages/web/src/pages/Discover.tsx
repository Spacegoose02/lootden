import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { GameListing } from "@lootden/shared";
import { api, type ListingResult } from "../api";
import { useAuth } from "../auth";
import { FindDownloads } from "../components/FindDownloads";
import { FreeGames } from "../components/FreeGames";
import { ListingCard } from "../components/Listing";
import { SourceReleases } from "../components/SourceReleases";
import { RequestButton } from "./Requests";

/** Find games that aren't in the library yet; admins send them straight to the downloaders, everyone else (kids too) requests them. */
export function Discover() {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const tab = params.get("tab") === "free" ? "free" : "search";
  const [query, setQuery] = useState(q);
  const [results, setResults] = useState<GameListing[] | null>(null);
  const [recent, setRecent] = useState<ListingResult | null>(null);
  const [error, setError] = useState("");
  const [finding, setFinding] = useState<GameListing | null>(null);

  useEffect(() => {
    api.discover().then((d) => setRecent(d.recent), (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    setResults(null);
    if (!q) return;
    api.discoverSearch(q).then(setResults, (e: Error) => setError(e.message));
  }, [q]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setParams(query.trim() ? { q: query.trim() } : {});
  };

  return (
    <div className="discover">
      <h1>Discover</h1>
      <nav className="tabs">
        <button className={tab === "search" ? "active" : ""} onClick={() => setParams({})}>
          Find games
        </button>
        <button className={tab === "free" ? "active" : ""} onClick={() => setParams({ tab: "free" })}>
          Free games
        </button>
      </nav>
      {tab === "free" ? <FreeGames isAdmin={isAdmin} /> : <>
      <form className="panel inline search-hero" onSubmit={submit}>
        <input type="search" placeholder="Search every game, not just your library" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1 }} autoFocus />
        <button className="primary" disabled={!query.trim()}>
          Search
        </button>
      </form>
      {error && <p className="error">{error}</p>}

      {q && (
        <section className="row">
          <h2>Results for “{q}”</h2>
          {!results ? (
            <p className="muted">Searching…</p>
          ) : results.length === 0 ? (
            <p className="muted">Nothing found.</p>
          ) : (
            <div className="listing-grid">
              {results.map((r) => (
                <ListingCard
                  key={`${r.provider}:${r.providerId}`}
                  item={r}
                  action={
                    r.libraryId ? (
                      <Link className="button small" to={`/games/${r.libraryId}`}>
                        Open
                      </Link>
                    ) : isAdmin ? (
                      <button className="small" onClick={() => setFinding(r)}>
                        Find downloads
                      </button>
                    ) : (
                      <RequestButton game={r} small />
                    )
                  }
                />
              ))}
            </div>
          )}
        </section>
      )}

      {finding && <FindDownloads game={finding} onClose={() => setFinding(null)} />}

      {recent && (
        <section className="row">
          <div className="row-head">
            <h2>Recently released</h2>
            <Link to="/calendar" className="muted small">
              Coming soon
            </Link>
          </div>
          {recent.items.length ? (
            <div className="listing-grid">
              {recent.items.map((r) => (
                <ListingCard key={`${r.provider}:${r.providerId}`} item={r} action={!isAdmin && !r.libraryId ? <RequestButton game={r} small /> : undefined} />
              ))}
            </div>
          ) : (
            <p className="muted">Nothing new right now.</p>
          )}
          <p className="muted small">
            From {recent.source}. Open a game for its trailer and details{isAdmin ? " and to find downloads" : ""}.
          </p>
        </section>
      )}
      <SourceReleases isAdmin={isAdmin} />
      </>}
    </div>
  );
}
