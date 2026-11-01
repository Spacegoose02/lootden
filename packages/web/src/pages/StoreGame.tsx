import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ROBLOX_ADDON, truckGameForSteamApp, type GameListing, type LocalStoreGame, type StoreGame as StoreGameT, type StoreGameDetail } from "@lootden/shared";
import { api, formatPlaytime } from "../api";
import { bridgeError, desktop } from "../desktop";
import { ArtworkPicker } from "../components/ArtworkEditor";
import { WorkshopPanel } from "../components/GameExtras";
import { TruckModsPanel } from "../components/TruckMods";
import { TruckModListPanel } from "../components/TruckModList";
import { GameMedia } from "../components/GameMedia";
import { useAuth } from "../auth";
import { listingDate } from "../components/Listing";
import { launchStoreGame, storeInstallUrl } from "../components/StoreGameCard";
import { LaunchOptionsPanel, PlayWithButtons, useLaunchOptions } from "../components/LaunchOptions";
import { useHelperGame } from "../helperGame";

const SOURCES: Record<string, string> = { igdb: "IGDB", rawg: "RAWG", steam: "Steam" };

/** A game from another store: its details from IGDB, RAWG or Steam, Play through the store, and the person's own changes. */
export function StoreGame() {
  const { addon = "", id = "" } = useParams();
  const { me } = useAuth();
  const [params] = useSearchParams();
  // Games only found on this PC aren't on the server; their card sends the title along.
  const localTitle = params.get("title") ?? "";
  const [detail, setDetail] = useState<StoreGameDetail | null>(null);
  const [local, setLocal] = useState<LocalStoreGame | null>(null);
  /** This PC's launchers were looked at, so no local copy means it isn't installed here. */
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const launchOpts = useLaunchOptions(addon !== ROBLOX_ADDON ? `store:${addon}:${id}` : null);

  useEffect(() => {
    setDetail(null);
    setError("");
    api.storeGame(addon, id, localTitle).then(setDetail, (e: Error) => setError(e.message));
    setScanned(false);
    desktop?.storeGames?.().then((l) => {
      setLocal(l.find((g) => g.addon === addon && g.externalId === id) ?? null);
      setScanned(true);
    }, () => {});
  }, [addon, id, localTitle]);

  // Bandit, the AI helper, knows which game this is.
  const helperTitle = detail ? (detail.custom.title ?? detail.game?.title ?? local?.title ?? localTitle) : "";
  useHelperGame(helperTitle ? { ref: { store: { addon, id, title: helperTitle } }, title: helperTitle } : null);

  if (error) return <p className="error">{error}</p>;
  if (!detail) return <p className="muted">Loading…</p>;

  const info = detail.info;
  const game: StoreGameT = detail.game ?? {
    addon,
    store: local?.store ?? addon,
    externalId: id,
    title: detail.custom.title ?? local?.title ?? localTitle,
    coverUrl: null,
    storeUrl: null,
    launchUrl: local?.launchUrl ?? null,
    playtimeSeconds: null,
    lastPlayedAt: null,
    libraryGameId: null,
  };
  // Roblox games an admin picked play straight through the Roblox app: nothing to install from here.
  const roblox = addon === ROBLOX_ADDON;
  const ready = !!local || (roblox && scanned);
  const install = !ready && scanned;
  const launch = local?.launchUrl ?? (install ? storeInstallUrl(game) : game.launchUrl);
  const date = info && addon !== ROBLOX_ADDON ? listingDate(info) : null;

  return (
    <article className="detail store-game">
      {detail.backgroundUrl && <div className="detail-bg wide" style={{ backgroundImage: `url("${detail.backgroundUrl}")` }} />}
      <div className="detail-head" data-nav-zone>
        {detail.coverUrl ? <img className="cover cover-hero cover-natural" src={detail.coverUrl} alt="" /> : <div className="cover cover-hero cover-placeholder">{game.title}</div>}
        <div className="detail-info">
          <h1>{game.title}</h1>
          <p className="muted">{[date, info?.genres.join(", ")].filter(Boolean).join(" · ")}</p>
          <div className="inline wrap">
            <span className="badge">{game.store}</span>
            {local && <span className="badge badge-kid">Installed on this PC</span>}
            {roblox && info?.ageRatings[0] && <span className="badge">{info.ageRatings[0].rating}</span>}
            {game.playtimeSeconds ? <span className="badge">{formatPlaytime(game.playtimeSeconds)} played</span> : null}
            {info?.rating != null && <span className="badge">★ {info.rating}/100</span>}
          </div>
          {game.lastPlayedAt && <p className="muted small">Last played {new Date(game.lastPlayedAt).toLocaleDateString()}</p>}
          {info && info.developers.length > 0 && <p className="muted small">By {info.developers.join(", ")}</p>}
          {info?.summary && <p className="summary">{info.summary}</p>}
          {!info && <p className="muted">No details found for this title yet. Use Edit to pick the right game.</p>}
          <div className="inline wrap">
            {launch && (
              <button className="primary" onClick={() => launchStoreGame(game, local ?? undefined, install).catch((e) => setError(bridgeError(e)))}>
                {ready ? "▶ Play" : install ? `Install with ${game.store}` : `Open in ${game.store}`}
              </button>
            )}
            {ready && local && <PlayWithButtons profile={launchOpts.state?.profile ?? null} onPlay={(a) => void launchStoreGame(game, local, false, a).catch((e) => setError(bridgeError(e)))} />}
            {game.libraryGameId && (
              <Link className="button secondary" to={`/games/${game.libraryGameId}`}>
                In LootDen
              </Link>
            )}
            {game.storeUrl && (
              <a className="button" href={game.storeUrl} target="_blank" rel="noreferrer">
                {roblox ? "Roblox page" : "Store page"}
              </a>
            )}
            {info?.url && !roblox && (
              <a className="button ghost" href={info.url} target="_blank" rel="noreferrer">
                View on {SOURCES[info.provider] ?? "source"}
              </a>
            )}
            {!roblox && (
              <button className="ghost" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
                {editing ? "Done editing" : "Edit"}
              </button>
            )}
          </div>
          {roblox && <p className="muted small">Plays in the Roblox app{desktop ? "" : " (open LootDen's desktop app on a PC with Roblox installed)"}. It starts signed in to whichever Roblox account that PC uses.</p>}
        </div>
      </div>

      {local && launchOpts.state?.dir && <LaunchOptionsPanel launchKey={`store:${addon}:${id}`} title={game.title} state={launchOpts.state} onSaved={() => void launchOpts.reload()} />}

      {editing && <StoreGameEditor addon={addon} id={id} title={localTitle} detail={detail} onChange={setDetail} />}

      {info && <GameMedia game={info} />}
      {addon === "steam" && /^\d+$/.test(id) && !me?.user?.kidMode && <WorkshopPanel steamAppId={id} isAdmin={me?.role === "admin"} installedHere={!!local} />}
      {addon === "steam" && truckGameForSteamApp(id) && !me?.user?.kidMode && <TruckModsPanel game={truckGameForSteamApp(id)!} />}
      {addon === "steam" && truckGameForSteamApp(id) && !me?.user?.kidMode && <TruckModListPanel game={truckGameForSteamApp(id)!} />}
    </article>
  );
}

/** A person's own title, metadata match and artwork for one store game. Only they see the changes. */
function StoreGameEditor({ addon, id, title, detail, onChange }: { addon: string; id: string; title: string; detail: StoreGameDetail; onChange: (d: StoreGameDetail) => void }) {
  const shownTitle = detail.custom.title ?? detail.game?.title ?? title;
  const [name, setName] = useState(shownTitle);
  const [query, setQuery] = useState(shownTitle);
  const [matches, setMatches] = useState<GameListing[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  const update = (patch: Parameters<typeof api.updateStoreGame>[2]) => run(async () => onChange(await api.updateStoreGame(addon, id, patch, title)));

  return (
    <section className="panel store-edit" data-nav-zone>
      <h2>Edit</h2>
      <p className="muted small">Changes here are yours only, and show on every device you sign in on.</p>
      {error && <p className="error">{error}</p>}

      <h3>Title</h3>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void update({ title: name.trim() || null });
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Title" style={{ flex: 1 }} />
        <button disabled={busy || !name.trim() || name.trim() === shownTitle}>Save title</button>
        {detail.custom.title && (
          <button type="button" className="ghost" disabled={busy} onClick={() => (setName(detail.game?.title ?? title), update({ title: null }))}>
            Use the store's title
          </button>
        )}
      </form>

      <h3>Details</h3>
      <p className="muted small">
        {detail.info ? `Showing ${detail.info.name} from ${SOURCES[detail.info.provider] ?? detail.info.provider}${detail.custom.match ? " (picked by you)" : ""}.` : "Nothing matched this title."} Wrong game? Search and pick the right one.
      </p>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => setMatches(await api.storeGameMatches(addon, id, query, title)));
        }}
      >
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search for the game" style={{ flex: 1 }} />
        <button disabled={busy || !query.trim()}>Search</button>
        <button type="button" className="secondary" disabled={busy} title="Look the game and its details up again" onClick={() => run(async () => onChange(await api.refreshStoreGame(addon, id, title)))}>
          ⟳ Refresh details
        </button>
        {detail.custom.match && (
          <button type="button" className="ghost" disabled={busy} onClick={() => update({ match: null })}>
            Match automatically
          </button>
        )}
      </form>
      {matches && (
        <div className="match-list">
          {matches.length === 0 && <p className="muted small">Nothing found. Try a shorter name.</p>}
          {matches.map((m) => (
            <button key={`${m.provider}:${m.providerId}`} className="match-option" disabled={busy} onClick={() => update({ match: { provider: m.provider, providerId: m.providerId } }).then(() => setMatches(null))}>
              {m.coverUrl ? <img src={m.coverUrl} alt="" loading="lazy" /> : <span className="match-noimg" />}
              <span>
                <strong>{m.name}</strong>
                <small className="muted">
                  {[m.dateText, SOURCES[m.provider] ?? m.provider].filter(Boolean).join(" · ")}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}

      <ArtworkPicker
        resetLabel="Use the found image"
        target={{
          current: { cover: detail.coverUrl, background: detail.backgroundUrl },
          custom: { cover: !!detail.custom.cover, background: !!detail.custom.background },
          options: (kind, q) => api.storeArtworkOptions(addon, id, kind, q, title),
          setUrl: async (kind, url) => onChange(await api.setStoreArtworkUrl(addon, id, kind, url, title)),
          upload: async (kind, file) => onChange(await api.uploadStoreArtwork(addon, id, kind, file, title)),
          reset: async (kind) => onChange(await api.resetStoreArtwork(addon, id, kind, title)),
        }}
      />
    </section>
  );
}
