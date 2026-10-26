import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { LocalStoreGame, StoreGame } from "@lootden/shared";
import { api, formatPlaytime, storeGamePath } from "../api";
import { bridgeError, desktop } from "../desktop";
import { Cover } from "./Cover";

export const storeKey = (g: { addon: string; externalId: string }) => `${g.addon}:${g.externalId}`;

/** A store game's page. Games only found on this PC carry their title, as the server doesn't know them. */
export const storeGameLink = (g: StoreGame) => `/store/${encodeURIComponent(g.addon)}/${encodeURIComponent(g.externalId)}${g.artUrl?.includes("?title=") ? `?title=${encodeURIComponent(g.title)}` : ""}`;

/**
 * The launcher link that installs a store game not on this PC. Steam and Epic have their own
 * install links; the other launchers open the game's page there, which has Install.
 */
export function storeInstallUrl(g: StoreGame): string | null {
  if (g.addon === "steam" && /^\d+$/.test(g.externalId)) return `steam://install/${g.externalId}`;
  if (g.addon === "epic" && g.launchUrl?.startsWith("com.epicgames.launcher:")) return g.launchUrl.replace(/\?.*$/, "?action=install");
  return g.launchUrl;
}

/**
 * Starts a store game: the PC's own launcher link (Heroic on Linux) when it has one, else the
 * store's. With install, a game this PC doesn't have opens the launcher's install instead.
 */
export async function launchStoreGame(g: StoreGame, local?: LocalStoreGame, install = false): Promise<void> {
  const url = local?.launchUrl ?? (install ? storeInstallUrl(g) : g.launchUrl);
  if (!url) return;
  if (desktop?.launchStore) await desktop.launchStore(url);
  else window.location.href = url;
}

/**
 * This person's store games, plus the ones installed on this PC from stores whose account
 * isn't connected (or that have no account side, like Ubisoft Connect).
 */
export function useStoreGames(enabled = true) {
  const [games, setGames] = useState<StoreGame[] | null>(null);
  const [local, setLocal] = useState<LocalStoreGame[]>([]);
  /** This PC's launchers have been looked at, so a game missing from them isn't installed here. */
  const [scanned, setScanned] = useState(false);
  const [custom, setCustom] = useState<Map<string, { title: string | null; coverUrl: string | null }>>(new Map());
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    api.storeGames().then(setGames, (e: Error) => {
      setError(e.message);
      setGames([]);
    });
    desktop?.storeGames?.().then(
      (l) => {
        setLocal(l);
        setScanned(true);
      },
      () => setLocal([]),
    );
    api.storeGamesCustom().then((l) => setCustom(new Map(l.map((c) => [storeKey(c), c]))), () => {});
  }, [enabled]);
  const installed = new Map(local.map((l) => [storeKey(l), l]));
  const all = games
    ? [
        ...games,
        ...local
          .filter((l) => !games.some((g) => storeKey(g) === storeKey(l)))
          .map((l): StoreGame => {
            const c = custom.get(storeKey(l));
            // The server finds a cover by the title the PC knows the game by.
            const art = `${storeGamePath(l.addon, l.externalId)}/cover?title=${encodeURIComponent(l.title)}`;
            return { addon: l.addon, store: l.store ?? l.addon, externalId: l.externalId, title: c?.title ?? l.title, coverUrl: c?.coverUrl ?? null, storeUrl: null, launchUrl: l.launchUrl ?? null, playtimeSeconds: null, lastPlayedAt: null, libraryGameId: null, artUrl: art };
          }),
      ]
    : null;
  return { games: all, installed, scanned, error };
}

/**
 * A game from another store: cover, store badge, and Play / Install / In LootDen / Store. In
 * the desktop app (scanned) a game this PC's launchers don't have says Install; in a browser,
 * where nothing can tell, the button just opens the launcher.
 */
export function StoreGameCard({ game: g, local, scanned, onError }: { game: StoreGame; local?: LocalStoreGame; scanned?: boolean; onError?: (message: string) => void }) {
  const install = !local && !!scanned;
  const launch = local?.launchUrl ?? (install ? storeInstallUrl(g) : g.launchUrl);
  return (
    <div className="card store-card">
      {/* The cover and title open the game's page, like a LootDen game's card. */}
      <Link to={storeGameLink(g)} className="store-card-link" aria-label={g.title}>
        <Cover game={{ id: storeKey(g), title: g.title, coverUrl: g.coverUrl ?? g.artUrl ?? null, backgroundUrl: g.coverUrl ? g.artUrl : null }} />
        {local && <span className="installed-dot" title="Installed on this PC" />}
        <div className="card-body">
          <div className="card-title" title={g.title}>
            {g.title}
          </div>
          <div className="card-meta">
            <span className="badge">{g.store}</span>
            {g.playtimeSeconds ? ` ${formatPlaytime(g.playtimeSeconds)}` : ""}
          </div>
        </div>
      </Link>
      <div className="card-body store-card-actions">
        <div className="store-actions">
          {launch && (
            <button
              className={`small ${install ? "secondary" : "primary"}`}
              onClick={() => launchStoreGame(g, local, install).catch((e) => onError?.(bridgeError(e)))}
              title={local ? "Start it through the store's launcher" : install ? `Not on this PC: install it through ${g.store}` : "Opens the store's launcher to install or play it"}
            >
              {local ? "▶ Play" : install ? "Install" : "Play"}
            </button>
          )}
          {g.libraryGameId && (
            <Link className="button small secondary" to={`/games/${g.libraryGameId}`} title="This game is on your LootDen server too">
              In LootDen
            </Link>
          )}
          {g.storeUrl && (
            <a className="button small ghost" href={g.storeUrl} target="_blank" rel="noreferrer">
              Store
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
