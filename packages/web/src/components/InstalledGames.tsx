import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { platformFor, type GameSummary, type UserGameState } from "@lootden/shared";
import { api, formatBytes, formatPlaytime } from "../api";
import { bridgeError, desktop, type InstalledGame } from "../desktop";
import { Cover } from "./Cover";
import { useViewPrefs } from "./LibraryLayout";

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
  };
}

/**
 * The games ready to play: on this PC inside the desktop app, or on any of this person's
 * devices in a browser. Play and Open folder work straight from here.
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

  if (error) return <p className="error">{error}</p>;
  if (!entries || (desktop && local === null)) return <p className="muted">Loading…</p>;

  const platforms = [...new Set(entries.map((e) => e.game.platform))].sort();
  const q = search.trim().toLowerCase();
  const time = (s: string | null) => (s ? Date.parse(s) : 0);
  const shown = entries
    .filter((e) => (!q || e.game.title.toLowerCase().includes(q)) && (!platform || e.game.platform === platform))
    .sort((a, b) => {
      if (sort === "title") return a.game.title.localeCompare(b.game.title);
      if (sort === "size") return b.game.sizeBytes - a.game.sizeBytes;
      if (sort === "playtime") return b.playtimeSeconds - a.playtimeSeconds || a.game.title.localeCompare(b.game.title);
      if (sort === "installed") return time(b.installedAt) - time(a.installedAt);
      // Never-played games come after played ones, newest installs first.
      return time(b.lastPlayedAt) - time(a.lastPlayedAt) || time(b.installedAt) - time(a.installedAt);
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
  const facts = (e: Entry) =>
    [
      e.lastPlayedAt ? `Played ${new Date(e.lastPlayedAt).toLocaleDateString()}` : "Not played yet",
      e.playtimeSeconds ? formatPlaytime(e.playtimeSeconds) : "",
      e.local?.version ? `v${e.local.version}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <>
      <div className="filters panel">
        <input type="search" placeholder="Search installed games" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
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
      {!entries.length ? (
        <div className="panel">
          <p>Nothing installed {desktop && scope === "pc" ? "on this PC" : ""} yet.</p>
          <p className="muted small">
            Install a game from its page in the <Link to="/library">library</Link> and it shows up here, ready to play.
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
              {shown.map((e) => (
                <li key={e.game.id}>
                  <Link to={`/games/${e.game.id}`} className="game-list-cover" tabIndex={-1} aria-hidden="true">
                    <Cover game={e.game} />
                  </Link>
                  <div className="game-list-main">
                    <Link to={`/games/${e.game.id}`} className="game-list-title">
                      {e.game.title}
                    </Link>
                    <span className="muted small">{facts(e)}</span>
                  </div>
                  {e.game.platform !== "pc" && <span className="badge badge-platform">{platformFor(e.game.platform).short}</span>}
                  <span className="muted small num">{e.game.sizeBytes ? formatBytes(e.game.sizeBytes) : ""}</span>
                  <span className="game-list-aside">{actions(e)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="play-grid">
              {shown.map((e) => (
                <article key={e.game.id} className="play-card">
                  <Link to={`/games/${e.game.id}`} className="play-card-cover" aria-label={e.game.title}>
                    <Cover game={e.game} />
                    {e.game.platform !== "pc" && <span className="badge badge-platform play-card-platform">{platformFor(e.game.platform).short}</span>}
                  </Link>
                  <div className="play-card-body">
                    <Link to={`/games/${e.game.id}`} className="card-title">
                      {e.game.title}
                    </Link>
                    <div className="card-meta">{facts(e)}</div>
                    {e.gone && <div className="muted small">No longer on the server</div>}
                    <div className="play-card-actions">{actions(e)}</div>
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
