import { useEffect, useState, type CSSProperties } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { browserRomFile, platformFor, type GameDetail as Game } from "@lootden/shared";
import { api, formatBytes, type ApiError, type Candidate } from "../api";
import { useAuth } from "../auth";
import { Badges } from "../components/Badges";
import { Cover } from "../components/Cover";
import { ArtworkEditor } from "../components/ArtworkEditor";
import { DesktopInstall } from "../components/DesktopInstall";
import { ReleaseLookup } from "../components/ReleaseLookup";
import { SavesPanel } from "../components/SavesPanel";
import { ShelfButton } from "../components/Shelves";
import { TOGETHER_TAGS } from "@lootden/shared";
import { UpdatesPanel } from "../components/UpdatesPanel";
import { PreparePanel } from "../components/PreparePanel";
import { JournalPanel, ModsPanel, WorkshopPanel, VersionBanner } from "../components/GameExtras";
import { bridgeError, desktop, type LocalGameCopy } from "../desktop";
import { LocalGame } from "../components/LocalGame";
import { launchStoreGame, storeKey, useStoreGames } from "../components/StoreGameCard";
import { KindBadge, UpdateActions, useInstalled, versionLabel } from "../components/UpdateActions";
import type { GameSummary } from "@lootden/shared";
import { useImageTint } from "../tint";
import { useHelperGame } from "../helperGame";

/** What a game card passes along, so the page can show the cover at once while the rest loads. */
type Preview = Pick<GameSummary, "id" | "title" | "coverUrl">;

export function GameDetail() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const [game, setGame] = useState<Game | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [params] = useSearchParams();
  const [installed, refreshInstalled] = useInstalled();
  const preview = (useLocation().state as { preview?: Preview } | null)?.preview;
  const shown = game ?? (preview?.id === id ? preview : null);
  // The page takes on the cover's colour: the glow behind it and the hero's tint (fx.css).
  const tint = useImageTint(shown?.coverUrl);
  const tintStyle = tint ? ({ "--tint": tint } as CSSProperties) : undefined;

  /** This PC's copy, when the server doesn't have the game any more (or can't be reached). */
  const [local, setLocal] = useState<{ copy: LocalGameCopy; removed: boolean } | null>(null);
  // Bandit, the AI helper, knows which game this is.
  useHelperGame(game && game.id === id ? { ref: { gameId: id }, title: game.title } : null);

  useEffect(() => {
    setGame(null);
    setError("");
    setLocal(null);
    api.game(id).then(setGame, async (e: ApiError) => {
      const copy = await desktop?.localGame?.(id).catch(() => null);
      if (copy) setLocal({ copy, removed: e.status === 404 });
      else setError(e.message);
    });
  }, [id]);

  if (local) return <LocalGame copy={local.copy} removed={local.removed} />;
  if (error) return <p className="error">{error}</p>;
  if (!game && shown)
    return (
      <article className="detail detail-loading" style={tintStyle}>
        <div className="detail-bg" style={shown.coverUrl ? { backgroundImage: `url(${shown.coverUrl})` } : undefined} />
        <div className="detail-head">
          <Cover game={shown} size="hero" />
          <div className="detail-info">
            <h1>{shown.title}</h1>
            <p className="muted">Loading…</p>
          </div>
        </div>
      </article>
    );
  if (!game) return <p className="muted">Loading…</p>;
  const m = game.metadata;
  const command = `lootden install ${game.id}`;
  const isAddon = game.kind !== "game";

  return (
    <article className="detail" style={tintStyle}>
      <div className={`detail-bg${game.backgroundUrl ? " wide" : ""}`} style={game.backgroundUrl || game.coverUrl ? { backgroundImage: `url(${game.backgroundUrl ?? game.coverUrl})` } : undefined} />
      <div className="detail-head">
        <Cover game={game} size="hero" />
        <div className="detail-info">
          <h1>{game.title}</h1>
          <p className="muted">
            {[game.releaseYear, game.genres.join(", "), formatBytes(game.sizeBytes)].filter(Boolean).join(" · ")}
          </p>
          {isAddon && (
            <p className="pkg-for">
              {game.kindReason ? <KindBadge game={game} /> : <span className="badge badge-muted">{game.kind === "dlc" ? "DLC" : "Update"}</span>}{" "}
              {game.baseGame ? (
                <>
                  for <Link to={`/games/${game.baseGame.id}`}>{game.baseGame.title}</Link>
                </>
              ) : (
                "Update only: its game isn't on the server"
              )}
              {versionLabel(game) && <span className="muted"> · {versionLabel(game)}</span>}
              {game.kindReason && <span className="muted small"> · {game.kindReason.note.replace(/^[^:]+:\s*/, "")}</span>}
            </p>
          )}
          {!isAddon && game.kindReason && (
            <p className="pkg-for">
              <KindBadge game={game} detail />
            </p>
          )}
          <Badges game={game} />
          {me?.user && !isAddon && <ShelfButton gameId={game.id} />}
          <AlsoOnStores gameId={game.id} />
          {game.platform === "pc" && !isAddon && <VersionBanner gameId={game.id} isAdmin={me?.role === "admin"} />}
          {m?.ageRatings.length ? (
            <p className="muted small">Age ratings: {m.ageRatings.map((r) => `${r.organization} ${r.rating}`).join(", ")}</p>
          ) : null}
          {m?.summary && <p className="summary">{m.summary}</p>}

          {browserRomFile(game.files, platformFor(game.platform)) && (
            <div className="inline">
              <Link className="button primary" to={`/play/${game.id}`}>
                ▶ Play in the browser
              </Link>
              <span className="muted small">Your save carries over to and from the desktop app.</span>
            </div>
          )}

          {isAddon ? (
            <div className="install panel">
              <UpdateActions update={game} baseTitle={game.baseGame?.title ?? null} installed={installed} onChange={refreshInstalled} />
            </div>
          ) : desktop ? (
            <DesktopInstall game={game} autoFocus={params.get("install") === "1"} />
          ) : (
          <div className="install panel">
            <a className="button primary" href={`lootden://install/${game.id}`}>
              Install on this PC
            </a>
            <p className="muted small">
              Opens the LootDen app. Or run{" "}
              <code
                role="button"
                tabIndex={0}
                onClick={() => {
                  void navigator.clipboard?.writeText(command);
                  setCopied(true);
                }}
              >
                {command}
              </code>
              {copied ? " (copied)" : ""} with the command-line client. Archives are unpacked and removed automatically.
            </p>
          </div>
          )}
          {!isAddon && <ReleaseLookup title={game.title} autoOpen={params.get("releases") === "1"} />}
        </div>
      </div>

      {me?.user && !isAddon && <JournalPanel gameId={game.id} />}

      {m?.screenshots.length ? (
        <section className="row">
          <h2>Screenshots</h2>
          <div className="row-track shots">
            {m.screenshots.map((s) => (
              <a key={s} href={s} target="_blank" rel="noreferrer">
                <img src={s} alt="" loading="lazy" />
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <h2>Files</h2>
        <table className="table">
          <tbody>
            {game.files.map((f) => (
              <tr key={f.index}>
                <td>
                  <a href={`/api/games/${game.id}/files/${f.index}`} download>
                    {f.path}
                  </a>
                </td>
                <td className="muted">{f.archive ? f.archive.toUpperCase() : ""}</td>
                <td className="num">{formatBytes(f.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {game.addons.length > 0 && (
        <section className="panel">
          <h2>Updates and DLC</h2>
          <ul className="pkg-list">
            {game.addons.map((u) => (
              <li key={u.id}>
                <div className="pkg-title">
                  <Link to={`/games/${u.id}`}>{u.title}</Link>
                  <KindBadge game={u} />
                  {versionLabel(u) && <span className="muted small">{versionLabel(u)}</span>}
                  <span className="muted small">{formatBytes(u.sizeBytes)}</span>
                </div>
                <UpdateActions update={u} baseTitle={game.title} installed={installed} onChange={refreshInstalled} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {!isAddon && <UpdatesPanel gameId={game.id} />}

      {game.platform === "pc" && !isAddon && <ModsPanel gameId={game.id} title={game.title} />}

      {game.platform === "pc" && !isAddon && !me?.user?.kidMode && <WorkshopPanel gameId={game.id} isAdmin={me?.role === "admin"} installedHere={!!installed?.some((g) => g.gameId === game.id)} />}

      {!isAddon && <PreparePanel game={game} />}

      {!isAddon && <SavesPanel game={game} onChange={setGame} />}

      {me?.role === "admin" && game.platform === "pc" && <PackageAdmin game={game} onChange={setGame} />}

      {me?.role === "admin" && <AdminTools game={game} onChange={setGame} />}
    </article>
  );
}

function AdminTools({ game, onChange }: { game: Game; onChange: (g: Game) => void }) {
  const [query, setQuery] = useState(game.title);
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState(game.overrides.title ?? "");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel admin-tools">
      <h2>Admin</h2>
      {error && <p className="error">{error}</p>}
      <p className="muted small">
        Folder: <code>{game.source}</code>
        {game.metadata ? ` · Metadata from ${game.metadata.provider}${game.metadata.locked ? " (matched by hand)" : ""}` : " · No metadata yet"}
      </p>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => setResults(await api.searchMetadata(game.id, query)));
        }}
      >
        <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search metadata" />
        <button disabled={busy}>Find metadata</button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          title={game.metadata?.locked ? "Fetch the hand-picked match's details again" : "Match it again with the current sources and their priority"}
          onClick={() => run(async () => onChange(await api.refreshGameMetadata(game.id)))}
        >
          ⟳ Refresh metadata
        </button>
        {game.metadata && (
          <button type="button" className="ghost" disabled={busy} onClick={() => run(async () => { await api.clearMetadata(game.id); onChange(await api.game(game.id)); })}>
            Clear match
          </button>
        )}
      </form>
      {results && (
        <div className="candidates">
          {results.length === 0 && <p className="muted">Nothing found.</p>}
          {results.slice(0, 12).map((c) => (
            <button
              key={`${c.provider}:${c.providerId}`}
              className="candidate"
              disabled={busy}
              onClick={() => run(async () => { onChange(await api.applyMetadata(game.id, c.provider, c.providerId)); setResults(null); })}
            >
              {c.coverUrl ? <img src={c.coverUrl} alt="" /> : <span className="cover-mini" />}
              <span>
                {c.name} {c.year ? `(${c.year})` : ""}
                <br />
                <small className="muted">
                  {c.provider} · {Math.round(c.score * 100)}% match
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="inline">
        <input placeholder="Title override" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title override" />
        <button disabled={busy} onClick={() => run(async () => onChange(await api.updateGame(game.id, { title: title || null })))}>
          {title ? "Set title" : "Reset title"}
        </button>
      </div>
      <div className="inline">
        <label>
          Kid-safe
          <select
            value={game.overrides.kidSafe === null ? "" : String(game.overrides.kidSafe)}
            onChange={(e) => run(async () => onChange(await api.updateGame(game.id, { kidSafe: e.target.value === "" ? null : e.target.value === "true" })))}
          >
            <option value="">Automatic ({game.metadata?.ageRatings.length ? (game.kidSafe ? "yes" : "no") : "unknown"})</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
        <label>
          Controller
          <select
            value={game.overrides.controllerSupport ?? ""}
            onChange={(e) => run(async () => onChange(await api.updateGame(game.id, { controllerSupport: e.target.value || null })))}
          >
            <option value="">Automatic ({game.metadata?.controllerSupport ?? "unknown"})</option>
            <option value="full">Full</option>
            <option value="partial">Partial</option>
            <option value="none">None</option>
          </select>
        </label>
      </div>
      <fieldset className="together-edit">
        <legend>
          Play together{" "}
          <small className="muted">
            {game.overrides.together === null ? "(automatic from metadata)" : "(set by hand) "}
            {game.overrides.together !== null && (
              <button type="button" className="ghost small" disabled={busy} onClick={() => run(async () => onChange(await api.setTogether(game.id, null)))}>
                Back to automatic
              </button>
            )}
          </small>
        </legend>
        {TOGETHER_TAGS.map(([tag, label]) => {
          const on = (game.together ?? []).includes(tag);
          return (
            <label key={tag} className="check">
              <input
                type="checkbox"
                checked={on}
                disabled={busy}
                onChange={() => run(async () => onChange(await api.setTogether(game.id, on ? (game.together ?? []).filter((t) => t !== tag) : [...(game.together ?? []), tag])))}
              />
              {label}
            </label>
          );
        })}
      </fieldset>
      <ArtworkEditor game={game} onChange={onChange} />
      <DeleteGame game={game} />
    </section>
  );
}

/** Admin: take the game out of the library, keeping its files in .deleted unless asked not to. */
function DeleteGame({ game }: { game: Game }) {
  const navigate = useNavigate();
  const [permanent, setPermanent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    const what = permanent
      ? `Delete ${game.title} and its files (${formatBytes(game.sizeBytes)}) for good? This can't be undone.`
      : `Remove ${game.title} from the library? Its files move to .deleted in the games folder, so you can put them back or delete them later.`;
    if (!confirm(what)) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteGame(game.id, permanent);
      navigate("/library", { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="delete-game">
      <h3>Delete game</h3>
      {error && <p className="error">{error}</p>}
      <div className="inline">
        <label className="check">
          <input type="checkbox" checked={permanent} onChange={(e) => setPermanent(e.target.checked)} />
          Also delete the files from the games folder
        </label>
        <button className="danger" disabled={busy} onClick={() => void remove()}>
          {permanent ? "Delete game and files" : "Delete game"}
        </button>
      </div>
      <p className="muted small">{permanent ? "Frees the space now and can't be undone." : <>The files go to <code>.deleted</code> in the games folder. Move them back to restore the game with its settings.</>}</p>
    </div>
  );
}

/** Admin: say what an entry is (game, update or DLC) and which game an update belongs to. */
function PackageAdmin({ game, onChange }: { game: Game; onChange: (g: Game) => void }) {
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState("");
  const isAddon = game.kind !== "game";
  useEffect(() => {
    if (isAddon) api.games({ platform: "pc" }).then(setGames, () => setGames([]));
  }, [isAddon]);
  const save = (patch: { kind?: string | null; baseGameId?: string | null }) => {
    setError("");
    api.setPackage(game.id, patch).then(onChange, (e: Error) => setError(e.message));
  };
  const auto = game.packageOverrides.kind === null;
  return (
    <section className="panel">
      <h2>Game, update or DLC</h2>
      <p className="muted small">
        {auto ? `Worked out from its ${game.kindReason ? { admin: "name", folder: "folder", name: "name", size: "size next to its game", content: "files" }[game.kindReason.by] : "name"}` : "Changed by an admin"}
        {game.kindReason && auto ? ` (${game.kindReason.note})` : ""}. Updates and DLC are kept out of the library, listed under Updates, and applied over the installed game.
      </p>
      <div className="inline">
        <label>
          This is{" "}
          <select value={game.packageOverrides.kind ?? ""} onChange={(e) => save({ kind: e.target.value || null })}>
            <option value="">Automatic ({game.kind === "dlc" ? "DLC" : game.kind})</option>
            <option value="game">A full game</option>
            <option value="update">An update</option>
            <option value="dlc">DLC</option>
          </select>
        </label>
        {isAddon && (
          <label>
            for{" "}
            <select value={game.packageOverrides.baseGameId ?? ""} onChange={(e) => save({ baseGameId: e.target.value || null })}>
              <option value="">Automatic{game.packageOverrides.baseGameId === null && game.baseGame ? ` (${game.baseGame.title})` : ""}</option>
              <option value="none">No game on the server</option>
              {(games ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** "You also have this on Steam": the same game on this person's other stores, with Play through that store. */
function AlsoOnStores({ gameId }: { gameId: string }) {
  const { games, installed, scanned } = useStoreGames();
  const [error, setError] = useState("");
  const same = (games ?? []).filter((g) => g.libraryGameId === gameId);
  if (!same.length) return null;
  return (
    <p className="also-on-stores small">
      <span className="muted">Also on </span>
      {same.map((g) => (
        <span key={storeKey(g)} className="also-on-store">
          <span className="badge">{g.store}</span>
          {(installed.get(storeKey(g))?.launchUrl ?? g.launchUrl) && (
            <button className="small ghost" onClick={() => launchStoreGame(g, installed.get(storeKey(g)), scanned).catch((e) => setError(bridgeError(e)))}>
              {scanned && !installed.has(storeKey(g)) ? "Install there" : "Play there"}
            </button>
          )}
        </span>
      ))}
      {error && <span className="error"> {error}</span>}
    </p>
  );
}
