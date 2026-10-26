import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { platformFor, type GameSummary, type UserGameState } from "@lootden/shared";
import { api } from "../api";
import { desktop } from "../desktop";
import { InstalledGames } from "../components/InstalledGames";
import { StoreGames, StoreSection } from "../components/StoreGames";
import { useStoreGames } from "../components/StoreGameCard";
import { GameCollection, useViewPrefs, ViewPicker } from "../components/LibraryLayout";
import { Backlog, Stats } from "../components/LibraryViews";

const SORTS = [
  ["title", "Title"],
  ["added", "Recently added"],
  ["release", "Release year"],
  ["rating", "Rating"],
  ["size", "Size"],
  ["played", "Recently played"],
] as const;

export function Library() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "all";
  const go = (t: string) => setParams(t === "all" ? {} : { tab: t }, { replace: true });
  return (
    <>
      <div className="segmented library-tabs" role="tablist" aria-label="Library view" data-nav-zone>
        {(
          [
            ["all", "All games"],
            ["installed", desktop ? "Installed" : "My installs"],
            ["stores", "Other stores"],
            ["backlog", "Backlog"],
            ["stats", "Stats"],
          ] as const
        ).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => go(t)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "installed" ? <InstalledGames /> : tab === "stores" ? <StoreGames /> : tab === "backlog" ? <Backlog /> : tab === "stats" ? <Stats /> : <AllGames />}
    </>
  );
}

function AllGames() {
  const [params, setParams] = useSearchParams();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [genres, setGenres] = useState<Array<{ name: string; count: number }>>([]);
  const [error, setError] = useState("");
  const search = params.get("search") ?? "";
  const genre = params.get("genre") ?? "";
  const controller = params.get("controller") ?? "";
  const kidSafe = params.get("kidSafe") === "true";
  const sort = params.get("sort") ?? "title";
  const system = params.get("system") ?? "pc";
  const onlyInstalled = params.get("installed") === "true";
  // Which libraries: everything (LootDen, then the other stores), LootDen only, or one store.
  const source = params.get("source") ?? "";
  const store = useStoreGames();
  const storeNames = [...new Map((store.games ?? []).map((g) => [g.addon, g.store])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const oneStore = source && source !== "lootden" ? source : "";
  const [prefs, setPrefs] = useViewPrefs("library");
  const [platforms, setPlatforms] = useState<Array<{ id: string; count: number }>>([]);
  // What's installed: this PC's copies in the app, else installs on any of this person's devices.
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [states, setStates] = useState<UserGameState[]>([]);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    api.genres(system === "all" ? undefined : system).then(setGenres, () => {});
  }, [system]);
  useEffect(() => {
    api.platforms().then(setPlatforms, () => {});
    api.myGames().then(
      (s) => {
        setStates(s);
        if (!desktop) setInstalledIds(new Set(s.filter((x) => x.installedAt && !x.uninstalledAt).map((x) => x.gameId)));
      },
      () => {},
    );
    if (desktop) void desktop.installed().then((l) => setInstalledIds(new Set(l.map((g) => g.gameId))), () => {});
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      const desc = sort === "added" || sort === "rating" || sort === "release" || sort === "size";
      api
        .games({ search, genre, controller, kidSafe, platform: system === "all" ? undefined : system, sort: sort === "played" ? "title" : sort, order: desc ? "desc" : "asc" })
        .then((g) => {
          setGames(g);
          setError("");
        }, (e: Error) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [search, genre, controller, kidSafe, sort, system]);

  const shown = useMemo(() => {
    if (!games) return null;
    let out = onlyInstalled ? games.filter((g) => installedIds.has(g.id)) : games;
    if (sort === "played") {
      const last = new Map<string, string>();
      for (const s of states) if (s.lastPlayedAt && (last.get(s.gameId) ?? "") < s.lastPlayedAt) last.set(s.gameId, s.lastPlayedAt);
      out = [...out].sort((a, b) => (last.get(b.id) ?? "").localeCompare(last.get(a.id) ?? "") || a.title.localeCompare(b.title));
    }
    return out;
  }, [games, onlyInstalled, installedIds, sort, states]);
  const shelf = system !== "all" && system !== "pc" ? platformFor(system).coverAspect : undefined;

  return (
    <>
      <div className="filters panel">
        <input type="search" placeholder="Search games" value={search} onChange={(e) => set("search", e.target.value)} aria-label="Search" />
        {storeNames.length > 0 && (
          <select value={source} onChange={(e) => set("source", e.target.value)} aria-label="Library">
            <option value="">All libraries</option>
            <option value="lootden">LootDen only</option>
            {storeNames.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        {platforms.length > 1 && (
          <select value={system} onChange={(e) => set("system", e.target.value === "pc" ? "" : e.target.value)} aria-label="System">
            <option value="pc">PC</option>
            <option value="all">All systems</option>
            {platforms
              .filter((p) => p.id !== "pc")
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {platformFor(p.id).name} ({p.count})
                </option>
              ))}
          </select>
        )}
        <select value={genre} onChange={(e) => set("genre", e.target.value)} aria-label="Genre">
          <option value="">All genres</option>
          {genres.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name} ({g.count})
            </option>
          ))}
        </select>
        <select value={controller} onChange={(e) => set("controller", e.target.value)} aria-label="Controller support">
          <option value="">Any input</option>
          <option value="any">Full or partial controller support</option>
          <option value="full">Full controller support</option>
          <option value="partial">Partial controller support</option>
        </select>
        <select value={sort} onChange={(e) => set("sort", e.target.value)} aria-label="Sort">
          {SORTS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={kidSafe} onChange={(e) => set("kidSafe", e.target.checked ? "true" : "")} />
          Kid-safe only
        </label>
        {installedIds.size > 0 && (
          <label className="check">
            <input type="checkbox" checked={onlyInstalled} onChange={(e) => set("installed", e.target.checked ? "true" : "")} />
            {desktop ? "On this PC" : "Installed"}
          </label>
        )}
        <ViewPicker prefs={prefs} onChange={setPrefs} />
      </div>
      {error && <p className="error">{error}</p>}
      {oneStore ? null : shown === null ? <p className="muted">Loading…</p> : shown.length === 0 ? <p className="muted">No games match.</p> : (
        <>
          <p className="muted count">{shown.length} games</p>
          <GameCollection games={shown} prefs={prefs} isInstalled={(g) => installedIds.has(g.id)} aspect={shelf} />
        </>
      )}
      {source !== "lootden" && store.games && <StoreSection games={store.games} installed={store.installed} scanned={store.scanned} search={search} store={oneStore} limit={oneStore ? undefined : 48} />}
    </>
  );
}
