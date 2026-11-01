import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { platformFor, type GameSummary, type UserGameState } from "@lootden/shared";
import { api } from "../api";
import { useLive } from "../live";
import { desktop } from "../desktop";
import { InstalledGames } from "../components/InstalledGames";
import { StoreSection } from "../components/StoreGames";
import { useStoreGames } from "../components/StoreGameCard";
import { GameCollection, useViewPrefs, ViewPicker } from "../components/LibraryLayout";
import { Backlog, Stats } from "../components/LibraryViews";
import { FamilyRecap } from "../components/Family";
import { ShelvesTab } from "../components/Shelves";
import { TOGETHER_TAGS } from "@lootden/shared";
import { BulkBar, useMarks, useTagList } from "../components/Marks";
import { Link } from "react-router-dom";

const SORTS = [
  ["title", "Title"],
  ["added", "Recently added"],
  ["release", "Release year"],
  ["rating", "Rating"],
  ["size", "Size"],
  ["played", "Recently played"],
] as const;

/** The app opens the Library on what's ready to play; a browser, which can't play, on everything. */
const DEFAULT_TAB = desktop ? "installed" : "all";

export function Library() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? DEFAULT_TAB;
  const go = (t: string) => setParams(t === DEFAULT_TAB ? {} : { tab: t }, { replace: true });
  // Other stores used to be its own tab; it's All games' library filter now, so old links still land there.
  useEffect(() => {
    if (tab === "stores") setParams({ tab: "all", source: "stores" }, { replace: true });
  }, [tab, setParams]);
  return (
    <>
      <div className="segmented library-tabs" role="tablist" aria-label="Library view" data-nav-zone>
        {(
          [
            ["installed", desktop ? "Installed" : "My installs"],
            ["all", "All games"],
            ["backlog", "Backlog"],
            ["shelves", "Shelves"],
            ["family", "Family"],
            ["stats", "Stats"],
          ] as const
        ).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => go(t)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "installed" ? <InstalledGames /> : tab === "backlog" ? <Backlog /> : tab === "shelves" ? <ShelvesTab /> : tab === "family" ? <FamilyRecap /> : tab === "stats" ? <Stats /> : <AllGames />}
    </>
  );
}

/** How a game sits on the server: still to set up, unpacked and ready, or in archives. */
function formatOf(g: GameSummary): "setup" | "folder" | "packed" {
  if (g.needsSetup) return "setup";
  return g.packed ? "packed" : "folder";
}

/**
 * The last lists shown, so coming back to the library (Back from a game) draws it at once and
 * lands on the same spot, then refreshes quietly.
 */
const shownBefore = { lists: new Map<string, GameSummary[]>(), installed: null as Set<string> | null, states: null as UserGameState[] | null };

function AllGames() {
  const [params, setParams] = useSearchParams();
  const search = params.get("search") ?? "";
  const genre = params.get("genre") ?? "";
  const controller = params.get("controller") ?? "";
  const kidSafe = params.get("kidSafe") === "true";
  const sort = params.get("sort") ?? "title";
  const system = params.get("system") ?? "pc";
  const listKey = JSON.stringify({ search, genre, controller, kidSafe, sort, system });
  const [games, setGames] = useState<GameSummary[] | null>(() => shownBefore.lists.get(listKey) ?? null);
  const [genres, setGenres] = useState<Array<{ name: string; count: number }>>([]);
  const [error, setError] = useState("");
  const onlyInstalled = params.get("installed") === "true";
  // Installers and disc images still to set up, games already unpacked into a folder, or archives.
  const format = params.get("format") ?? "";
  // Play together: any tag ("any") or one of them.
  const together = params.get("together") ?? "";
  // Which libraries: everything (LootDen, then the other stores), LootDen only, every other store, or one store.
  const source = params.get("source") ?? "";
  const store = useStoreGames();
  const storeNames = [...new Map((store.games ?? []).map((g) => [g.addon, g.store])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const storesOnly = !!source && source !== "lootden";
  const oneStore = storesOnly && source !== "stores" ? source : "";
  const [prefs, setPrefs] = useViewPrefs("library");
  const marks = useMarks();
  const tagList = useTagList();
  const tag = params.get("tag") ?? "";
  const favourites = params.get("fav") === "1";
  const showHidden = params.get("hidden") === "1";
  /** Bulk edit: picking games in a list instead of opening them. */
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [platforms, setPlatforms] = useState<Array<{ id: string; count: number }>>([]);
  // What's installed: this PC's copies in the app, else installs on any of this person's devices.
  const [installedIds, setInstalledIds] = useState<Set<string>>(() => shownBefore.installed ?? new Set());
  const [states, setStates] = useState<UserGameState[]>(() => shownBefore.states ?? []);
  useEffect(() => {
    shownBefore.installed = installedIds;
    shownBefore.states = states;
  }, [installedIds, states]);
  // Bumped when the server's library changes, so the list fetches again.
  const [revision, setRevision] = useState(0);
  useLive("library", () => setRevision((r) => r + 1));

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
          shownBefore.lists.set(listKey, g);
          // Only the newest few lists are kept.
          if (shownBefore.lists.size > 8) shownBefore.lists.delete(shownBefore.lists.keys().next().value!);
          setError("");
        }, (e: Error) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [search, genre, controller, kidSafe, sort, system, revision]);

  const shown = useMemo(() => {
    if (!games) return null;
    let out = onlyInstalled ? games.filter((g) => installedIds.has(g.id)) : games;
    if (format) out = out.filter((g) => formatOf(g) === format);
    if (together) out = out.filter((g) => (together === "any" ? !!g.together?.length : g.together?.includes(together as never)));
    if (!showHidden) out = out.filter((g) => !marks.get(g.id).hidden);
    if (favourites) out = out.filter((g) => marks.get(g.id).favourite);
    if (tag) out = out.filter((g) => marks.get(g.id).tags.some((t) => t.toLowerCase() === tag.toLowerCase()));
    if (sort === "played") {
      const last = new Map<string, string>();
      for (const s of states) if (s.lastPlayedAt && (last.get(s.gameId) ?? "") < s.lastPlayedAt) last.set(s.gameId, s.lastPlayedAt);
      out = [...out].sort((a, b) => (last.get(b.id) ?? "").localeCompare(last.get(a.id) ?? "") || a.title.localeCompare(b.title));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games, onlyInstalled, installedIds, sort, states, format, together, showHidden, favourites, tag, marks.all]);
  const shelf = system !== "all" && system !== "pc" ? platformFor(system).coverAspect : undefined;

  return (
    <>
      <div className="filters panel">
        <input type="search" placeholder="Search games" value={search} onChange={(e) => set("search", e.target.value)} aria-label="Search" />
        {storeNames.length > 0 && (
          <select value={source} onChange={(e) => set("source", e.target.value)} aria-label="Library">
            <option value="">All libraries</option>
            <option value="lootden">LootDen only</option>
            <option value="stores">Every other store</option>
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
        <select value={format} onChange={(e) => set("format", e.target.value)} aria-label="Format">
          <option value="">Any format</option>
          <option value="setup">Installers and disc images</option>
          <option value="folder">Ready game folders</option>
          <option value="packed">Archives</option>
        </select>
        <select value={together} onChange={(e) => set("together", e.target.value)} aria-label="Play together">
          <option value="">Any players</option>
          <option value="any">👥 Play together</option>
          {TOGETHER_TAGS.map(([id, label]) => (
            <option key={id} value={id}>
              👥 {label}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => set("sort", e.target.value)} aria-label="Sort">
          {SORTS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        {tagList.length > 0 && (
          <select value={tag} onChange={(e) => set("tag", e.target.value)} aria-label="Tag">
            <option value="">Any tag</option>
            {tagList.map((t) => (
              <option key={t} value={t}>
                🏷 {t}
              </option>
            ))}
          </select>
        )}
        <label className="check">
          <input type="checkbox" checked={kidSafe} onChange={(e) => set("kidSafe", e.target.checked ? "true" : "")} />
          Kid-safe only
        </label>
        <label className="check">
          <input type="checkbox" checked={favourites} onChange={(e) => set("fav", e.target.checked ? "1" : "")} />♥ Favourites
        </label>
        <label className="check">
          <input type="checkbox" checked={showHidden} onChange={(e) => set("hidden", e.target.checked ? "1" : "")} />
          Show hidden
        </label>
        <button className={selecting ? "secondary active" : "ghost"} aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setPicked(new Set()); }}>
          {selecting ? "Stop selecting" : "Select…"}
        </button>
        {(installedIds.size > 0 || store.installed.size > 0) && (
          <div className="segmented pill-toggle" role="radiogroup" aria-label="Show">
            <button role="radio" aria-checked={!onlyInstalled} className={onlyInstalled ? "" : "active"} onClick={() => set("installed", "")}>
              Everything
            </button>
            <button role="radio" aria-checked={onlyInstalled} className={onlyInstalled ? "active" : ""} onClick={() => set("installed", "true")}>
              <span className="installed-glyph" aria-hidden="true" /> {desktop ? "On this PC" : "Installed"}
            </button>
          </div>
        )}
        <ViewPicker prefs={prefs} onChange={setPrefs} />
      </div>
      {error && <p className="error">{error}</p>}
      {storesOnly ? null : shown === null ? <p className="muted">Loading…</p> : shown.length === 0 ? <p className="muted">No games match.</p> : (
        <>
          <p className="muted count">{shown.length} games</p>
          {selecting ? (
            <>
              <BulkBar keys={[...picked]} onDone={() => {}} onClear={() => { setSelecting(false); setPicked(new Set()); }} />
              <SelectList games={shown} picked={picked} onChange={setPicked} />
            </>
          ) : (
            <GameCollection games={shown} prefs={prefs} isInstalled={(g) => installedIds.has(g.id)} aspect={shelf} />
          )}
        </>
      )}
      {source !== "lootden" && store.games && !selecting && (
        <StoreSection
          games={store.games}
          installed={store.installed}
          scanned={store.scanned}
          search={search}
          store={oneStore}
          all={storesOnly}
          onlyInstalled={onlyInstalled}
          limit={storesOnly ? undefined : 48}
          keep={(g) => {
            const m = marks.get(`store:${g.addon}:${g.externalId}`);
            return (showHidden || !m.hidden) && (!favourites || m.favourite) && (!tag || m.tags.some((t) => t.toLowerCase() === tag.toLowerCase()));
          }}
          libraryIds={storesOnly || !shown ? undefined : new Set(shown.map((g) => g.id))}
        />
      )}
    </>
  );
}

/** Bulk edit: the shown games as a list with tick boxes. */
function SelectList({ games, picked, onChange }: { games: GameSummary[]; picked: Set<string>; onChange: (s: Set<string>) => void }) {
  const marks = useMarks();
  const all = games.length > 0 && games.every((g) => picked.has(g.id));
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <table className="table select-list">
      <thead>
        <tr>
          <th>
            <input type="checkbox" checked={all} aria-label="Select every game shown" onChange={() => onChange(all ? new Set() : new Set(games.map((g) => g.id)))} />
          </th>
          <th>Game</th>
          <th>Tags</th>
        </tr>
      </thead>
      <tbody>
        {games.map((g) => {
          const m = marks.get(g.id);
          return (
            <tr key={g.id} className={picked.has(g.id) ? "picked" : undefined} onClick={() => toggle(g.id)}>
              <td>
                <input type="checkbox" checked={picked.has(g.id)} aria-label={`Select ${g.title}`} onChange={() => toggle(g.id)} onClick={(e) => e.stopPropagation()} />
              </td>
              <td>
                {m.favourite ? "♥ " : ""}
                <Link to={`/games/${g.id}`} onClick={(e) => e.stopPropagation()}>
                  {g.title}
                </Link>
                {m.hidden ? <span className="muted small"> (hidden)</span> : null}
              </td>
              <td className="muted small">{m.tags.join(", ")}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
