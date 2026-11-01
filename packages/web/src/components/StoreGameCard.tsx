import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ROBLOX_ADDON, type LocalStoreGame, type StoreGame } from "@lootden/shared";
import { api, formatPlaytime, storeGamePath } from "../api";
import { bridgeError, desktop } from "../desktop";
import { Cover } from "./Cover";
import { InstalledPill } from "./LibraryLayout";

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
export async function launchStoreGame(g: StoreGame, local?: LocalStoreGame, install = false, actionId?: string): Promise<void> {
  const url = local?.launchUrl ?? (install ? storeInstallUrl(g) : g.launchUrl);
  if (!url) return;
  if (!desktop?.launchStore) return void (window.location.href = url);
  // Installed here with launch options (or steps every game runs): the app runs them around the game.
  if (local && !install && desktop.playStore && desktop.launchOptions && g.addon !== ROBLOX_ADDON) {
    const opts = await desktop.launchOptions(`store:${g.addon}:${g.externalId}`).catch(() => null);
    if (opts && (opts.profile || opts.global.before.length || opts.global.after.length)) return desktop.playStore(g.addon, g.externalId, url, actionId);
  }
  try {
    await desktop.launchStore(url);
  } catch (e) {
    // Apps from before 0.22.0 don't know Roblox links yet: say how to fix it instead of the bare refusal.
    if (g.addon === ROBLOX_ADDON && /isn't a store launcher link/.test(String((e as Error)?.message ?? e))) {
      const version = await desktop.info().then((i) => i.version, () => "");
      throw new Error(`This LootDen app${version ? ` (${version})` : ""} is too old to start Roblox games. Update it to 0.22.0 or newer: an admin clicks Get latest release under Settings, News & apps, then restart the app (or install LootDen-Setup-0.22.0.exe from the GitHub release).`);
    }
    throw e;
  }
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
  // Roblox games an admin picked play through the Roblox app, so in the app they're ready to play like an installed game.
  if (scanned) for (const g of games ?? []) if (g.addon === ROBLOX_ADDON && g.launchUrl) installed.set(storeKey(g), { addon: g.addon, externalId: g.externalId, title: g.title, installDir: "", store: g.store });
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
export function StoreGameCard({ game: g, local, scanned, onError, alsoOn }: { game: StoreGame; local?: LocalStoreGame; scanned?: boolean; onError?: (message: string) => void; alsoOn?: string[] }) {
  const install = !local && !!scanned;
  const launch = local?.launchUrl ?? (install ? storeInstallUrl(g) : g.launchUrl);
  return (
    <div className="card store-card">
      {/* The cover and title open the game's page, like a LootDen game's card. */}
      <Link to={storeGameLink(g)} className="store-card-link" aria-label={g.title}>
        <Cover game={{ id: storeKey(g), title: g.title, coverUrl: g.coverUrl ?? g.artUrl ?? null, backgroundUrl: g.coverUrl ? g.artUrl : null }} />
        {local && <InstalledPill />}
        <div className="card-body">
          <div className="card-title" title={g.title}>
            {g.title}
          </div>
          <div className="card-meta">
            <span className={`badge launcher-badge launcher-${g.addon.replace(/[^a-z0-9-]/gi, "")}`}>{g.store}</span>
            {alsoOn?.length ? (
              <span className="badge also-on" title={`Also on ${alsoOn.join(", ")}`}>
                +{alsoOn.length}
              </span>
            ) : null}
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
          {g.storeUrl && g.addon !== ROBLOX_ADDON && (
            <a className="button small ghost" href={g.storeUrl} target="_blank" rel="noreferrer">
              Store
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
