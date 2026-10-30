import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { platformFor, type GameSummary, type LocalStoreGame, type StoreGame, type UserGameState } from "@lootden/shared";
import { api, formatBytes, formatPlaytime } from "../api";
import { bridgeError, desktop, type InstalledGame } from "../desktop";
import { Cover } from "./Cover";
import { useViewPrefs } from "./LibraryLayout";
import { launchStoreGame, storeGameLink, storeKey, useStoreGames } from "./StoreGameCard";

/** One installed game: the server's entry joined with this PC's copy and this person's play history. */
interface Entry {
  game: GameSummary;
  /** The copy on this PC (desktop app only). */
  local: InstalledGame | null;
  /** Devices this person has it installed on, from the server. */
  devices: string[];
  installedAt: string | null;
  lastPlayedAt: string | null;
  playtimeSeconds: number;
  /** The server no longer has this game (or can't be reached); it can still be played from this PC. */
  gone: boolean;
}

/** One row of Installed: a LootDen game, or a game another launcher (Steam, Epic...) has on this PC. */
type Item = { key: string; title: string; launcher: string; lastPlayedAt: string | null; installedAt: string | null; playtimeSeconds: number; sizeBytes: number } & (
  | { kind: "lootden"; entry: Entry }
  | { kind: "store"; game: StoreGame; local: LocalStoreGame }
);

const LOOTDEN = "lootden";

/** The launcher's name on a pill, coloured by launcher (see .launcher-pill in styles.css). */
export function LauncherPill({ id, name, className = "" }: { id: string; name: string; className?: string }) {
  return <span className={`launcher-pill launcher-${id.replace(/[^a-z0-9-]/gi, "")} ${className}`.trim()}>{name}</span>;
}

const SORTS = [
  ["played", "Recently played"],
  ["installed", "Recently installed"],
  ["title", "Title"],
  ["playtime", "Most played"],
  ["size", "Size"],
] as const;
type Sort = (typeof SORTS)[number][0];

/** Enough of a summary to show a game the server doesn't list any more. */
export function stub(local: InstalledGame): GameSummary {
  return {
    id: local.gameId,
    title: local.title,
    source: local.dir,
    layout: "folder",
    platform: local.platform ?? "pc",
    sizeBytes: 0,
    fileCount: 0,
    packed: false,
    needsSetup: local.needsSetup ?? null,
    modifiedAt: local.installedAt,
    addedAt: local.installedAt,
    coverUrl: null,
    genres: [],
    releaseYear: null,
    rating: null,
    controllerSupport: null,
    kidSafe: null,
    kind: "game",
    version: local.version ?? null,
    fromVersion: null,
    baseGameId: null,
    kindReason: null,
    latestVersion: null,
  };
}

/**
 * The games ready to play: on this PC inside the desktop app, or on any of this person's
 * devices in a browser. In the app that's every launcher's games, LootDen's and the ones
 * Steam, Epic, GOG and the rest have installed, with a filter to show one launcher.
 * Play and Open folder work straight from here.
 */
export function InstalledGames() {
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [local, setLocal] = useState<InstalledGame[] | null>(null);
  const [states, setStates] = useState<UserGameState[]>([]);
  const [error, setError] = useState("");
  /** The server's list couldn't be loaded; the app still shows and plays what's on this PC. */
  const [unreachable, setUnreachable] = useState(false);
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("");
  const [sort, setSort] = useState<Sort>("played");
  const [launcher, setLauncher] = useState("");
  const stores = useStoreGames(!!desktop?.storeGames);
  const [scope, setScope] = useState<"pc" | "all">(desktop ? "pc" : "all");
  const [prefs, setPrefs] = useViewPrefs("installed");
  const [busy, setBusy] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  const refreshLocal = () => {
    if (desktop) void desktop.installed().then(setLocal, () => setLocal([]));
  };
  useEffect(() => {
    api.games().then(setGames, (e: Error) => {
      if (!desktop) return setError(e.message);
      setGames([]);
      setUnreachable(true);
    });
    api.myGames().then(setStates, () => setStates([]));
    refreshLocal();
  }, []);
  useEffect(
    () =>
      desktop?.onProgress((p) => {
        if (p.type === "playing") setPlaying(p.gameId);
        else if (p.type === "stopped" || p.type === "error") {
          setPlaying((x) => (x === p.gameId ? null : x));
          if (p.type === "stopped") api.myGames().then(setStates, () => {});
        }
      }),
    [],
  );

  const entries = useMemo(() => {
    if (!games) return null;
    const byId = new Map(games.map((g) => [g.id, g]));
    const mine = new Map<string, UserGameState[]>();
    for (const s of states) mine.set(s.gameId, [...(mine.get(s.gameId) ?? []), s]);
    const latest = (xs: Array<string | null | undefined>) => xs.filter((x): x is string => !!x).sort().pop() ?? null;
    const out = new Map<string, Entry>();
    const add = (id: string, l: InstalledGame | null) => {
      const s = mine.get(id) ?? [];
      const installedOn = s.filter((x) => x.installedAt && !x.uninstalledAt);
      const game = byId.get(id) ?? (l ? stub(l) : null);
      if (!game) return;
      out.set(id, {
        game,
        local: l,
        devices: installedOn.map((x) => x.device),
        installedAt: l?.installedAt ?? latest(installedOn.map((x) => x.installedAt)),
        lastPlayedAt: latest(s.map((x) => x.lastPlayedAt)),
        playtimeSeconds: s.reduce((t, x) => t + x.playtimeSeconds, 0),
        gone: !unreachable && !byId.has(id),
      });
    };
    for (const l of local ?? []) add(l.gameId, l);
    if (scope === "all") for (const s of states) if (s.installedAt && !s.uninstalledAt && !out.has(s.gameId)) add(s.gameId, null);
    return [...out.values()];
  }, [games, local, states, scope, unreachable]);

  const items = useMemo((): Item[] | null => {
    if (!entries) return null;
    const out: Item[] = entries.map((entry) => ({
      kind: "lootden",
      key: entry.game.id,
      title: entry.game.title,
      launcher: LOOTDEN,
      lastPlayedAt: entry.lastPlayedAt,
      installedAt: entry.installedAt,
      playtimeSeconds: entry.playtimeSeconds,
      sizeBytes: entry.game.sizeBytes,
      entry,
    }));
    // Store games only count on this PC: the app's scan of its launchers is the only way to know.
    if (scope === "pc")
      for (const g of stores.games ?? []) {
        const l = stores.installed.get(storeKey(g));
        if (!l) continue;
        out.push({ kind: "store", key: storeKey(g), title: g.title, launcher: g.addon, lastPlayedAt: g.lastPlayedAt, installedAt: null, playtimeSeconds: g.playtimeSeconds ?? 0, sizeBytes: 0, game: g, local: l });
      }
    return out;
  }, [entries, stores.games, stores.installed, scope]);

  if (error) return <p className="error">{error}</p>;
  if (!items || (desktop && local === null)) return <p className="muted">Loading…</p>;

  const launcherNames = new Map<string, string>([[LOOTDEN, "LootDen"]]);
  for (const i of items) if (i.kind === "store") launcherNames.set(i.launcher, i.game.store);
  const launchers = [...launcherNames.keys()].filter((id) => items.some((i) => i.launcher === id));
  const count = (id: string) => items.filter((i) => i.launcher === id).length;
  const platforms = [...new Set(items.map((i) => (i.kind === "lootden" ? i.entry.game.platform : "pc")))].sort();
  const q = search.trim().toLowerCase();
  const time = (s: string | null) => (s ? Date.parse(s) : 0);
  const shown = items
    .filter(
      (i) =>
        (!q || i.title.toLowerCase().includes(q)) &&
        (!platform || (i.kind === "lootden" ? i.entry.game.platform : "pc") === platform) &&
        (!launcher || i.launcher === launcher),
    )
    .sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "size") return b.sizeBytes - a.sizeBytes;
      if (sort === "playtime") return b.playtimeSeconds - a.playtimeSeconds || a.title.localeCompare(b.title);
      if (sort === "installed") return time(b.installedAt) - time(a.installedAt);
      // Never-played games come after played ones, newest installs first.
      return time(b.lastPlayedAt) - time(a.lastPlayedAt) || time(b.installedAt) - time(a.installedAt) || a.title.localeCompare(b.title);
    });

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setError("");
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      setError(bridgeError(e));
    } finally {
      setBusy(null);
    }
  };

  const actions = (e: Entry) => {
    const l = e.local;
    if (!l || !desktop) {
      return (
        <span className="muted small">
          {e.devices.length ? `On ${e.devices.join(", ")}` : "Installed"}
          {desktop ? "" : " · play it from the LootDen app"}
        </span>
      );
    }
    const bridge = desktop;
    if (l.needsSetup && !l.installedDir && (l.platform ?? "pc") === "pc") {
      return (
        <Link className="button small" to={`/games/${l.gameId}`}>
          Run installer
        </Link>
      );
    }
    const emu = e.game.platform !== "pc";
    return (
      <>
        <button className="primary small" disabled={busy === l.gameId || playing === l.gameId} onClick={() => run(l.gameId, () => bridge.play(l.gameId))}>
          {playing === l.gameId ? "Playing…" : emu ? `▶ Play ${platformFor(e.game.platform).short}` : "▶ Play"}
        </button>
        <button className="small secondary" onClick={() => run(l.gameId, () => bridge.openFolder(l.gameId))} title={l.installedDir ?? l.dir}>
          Open folder
        </button>
        <Link className="button small ghost" to={`/games/${l.gameId}?releases=1`} title="Look up the latest releases of this game">
          Releases
        </Link>
      </>
    );
  };
  const storeActions = (g: StoreGame, l: LocalStoreGame) => (
    <>
      {l.launchUrl || g.launchUrl ? (
        <button className="primary small" onClick={() => launchStoreGame(g, l).catch((e) => setError(bridgeError(e)))} title={`Starts it through ${g.store}`}>
          ▶ Play
        </button>
      ) : (
        <span className="muted small">Start it from {g.store}</span>
      )}
      {g.libraryGameId && (
        <Link className="button small ghost" to={`/games/${g.libraryGameId}`} title="This game is on your LootDen server too">
          In LootDen
        </Link>
      )}
    </>
  );
  const facts = (i: Item) =>
    [
      i.lastPlayedAt ? `Played ${new Date(i.lastPlayedAt).toLocaleDateString()}` : i.kind === "lootden" ? "Not played yet" : "",
      i.playtimeSeconds ? formatPlaytime(i.playtimeSeconds) : "",
      i.kind === "lootden" && i.entry.local?.version ? `v${i.entry.local.version}` : "",
    ]
      .filter(Boolean)
      .join(" · ") || (i.kind === "store" ? `Plays through ${i.game.store}` : "");
  const link = (i: Item) => (i.kind === "lootden" ? `/games/${i.entry.game.id}` : storeGameLink(i.game));
  const cover = (i: Item) =>
    i.kind === "lootden" ? <Cover game={i.entry.game} /> : <Cover game={{ id: i.key, title: i.title, coverUrl: i.game.coverUrl ?? i.game.artUrl ?? null, backgroundUrl: i.game.coverUrl ? i.game.artUrl : null }} />;
  const platformOf = (i: Item) => (i.kind === "lootden" ? i.entry.game.platform : "pc");

  return (
    <>
      <div className="filters panel">
        <input type="search" placeholder="Search installed games" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
        {launchers.length > 1 && (
          <div className="segmented launcher-filter" role="radiogroup" aria-label="Launcher">
            <button role="radio" aria-checked={!launcher} className={!launcher ? "active" : ""} onClick={() => setLauncher("")}>
              All launchers <span className="chip-count">{items.length}</span>
            </button>
            {launchers.map((id) => (
              <button key={id} role="radio" aria-checked={launcher === id} className={launcher === id ? "active" : ""} onClick={() => setLauncher(id)}>
                <span className={`launcher-dot launcher-${id.replace(/[^a-z0-9-]/gi, "")}`} aria-hidden="true" />
                {launcherNames.get(id)} <span className="chip-count">{count(id)}</span>
              </button>
            ))}
          </div>
        )}
        {platforms.length > 1 && (
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="System">
            <option value="">All systems</option>
            {platforms.map((p) => (
              <option key={p} value={p}>
                {platformFor(p).name}
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
        {desktop && (
          <div className="segmented" role="radiogroup" aria-label="Where">
            <button role="radio" aria-checked={scope === "pc"} className={scope === "pc" ? "active" : ""} onClick={() => setScope("pc")}>
              This PC
            </button>
            <button role="radio" aria-checked={scope === "all"} className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>
              All my devices
            </button>
          </div>
        )}
        <div className="segmented" role="radiogroup" aria-label="Layout">
          {(
            [
              ["grid", "▦ Tiles"],
              ["list", "☰ List"],
            ] as const
          ).map(([m, label]) => (
            <button key={m} role="radio" aria-checked={prefs.mode === m} className={prefs.mode === m ? "active" : ""} onClick={() => setPrefs({ mode: m })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {!desktop && (
        <p className="muted small">
          Games installed through the LootDen app on any of your devices. Open LootDen on that PC to play them, or use the app on this one to play from here.
        </p>
      )}
      {!items.length ? (
        <div className="panel">
          <p>Nothing installed {desktop && scope === "pc" ? "on this PC" : ""} yet.</p>
          <p className="muted small">
            Install a game from its page in the <Link to="/library?tab=all">library</Link> and it shows up here, ready to play.
            {desktop?.storeGames ? " Games Steam, Epic, GOG and your other launchers have installed show up here too." : ""}
          </p>
        </div>
      ) : !shown.length ? (
        <p className="muted">No installed games match.</p>
      ) : (
        <>
          {unreachable && <p className="muted small">Can't reach the server right now, so this shows only the games on this PC. They still play.</p>}
          <p className="muted count">{shown.length} installed</p>
          {prefs.mode === "list" ? (
            <ul className="game-list installed-list">
              {shown.map((i) => (
                <li key={i.key}>
                  <Link to={link(i)} className="game-list-cover" tabIndex={-1} aria-hidden="true">
                    {cover(i)}
                  </Link>
                  <div className="game-list-main">
                    <Link to={link(i)} className="game-list-title">
                      {i.title}
                    </Link>
                    <span className="muted small">{facts(i)}</span>
                  </div>
                  <LauncherPill id={i.launcher} name={launcherNames.get(i.launcher) ?? i.launcher} />
                  {platformOf(i) !== "pc" && <span className="badge badge-platform">{platformFor(platformOf(i)).short}</span>}
                  <span className="muted small num">{i.sizeBytes ? formatBytes(i.sizeBytes) : ""}</span>
                  <span className="game-list-aside">{i.kind === "lootden" ? actions(i.entry) : storeActions(i.game, i.local)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="play-grid" data-nav-zone>
              {shown.map((i) => (
                <article key={i.key} className="play-card">
                  <Link to={link(i)} className="play-card-cover" aria-label={i.title}>
                    {cover(i)}
                    {platformOf(i) !== "pc" && <span className="badge badge-platform play-card-platform">{platformFor(platformOf(i)).short}</span>}
                    <LauncherPill id={i.launcher} name={launcherNames.get(i.launcher) ?? i.launcher} className="play-card-launcher" />
                  </Link>
                  <div className="play-card-body">
                    <Link to={link(i)} className="card-title">
                      {i.title}
                    </Link>
                    <div className="card-meta">{facts(i)}</div>
                    {i.kind === "lootden" && i.entry.gone && <div className="muted small">Removed from the server · still plays here</div>}
                    <div className="play-card-actions">{i.kind === "lootden" ? actions(i.entry) : storeActions(i.game, i.local)}</div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
