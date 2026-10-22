import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { LocalStoreGame, StoreGame } from "@lootden/shared";
import { api, formatPlaytime } from "../api";
import { bridgeError, desktop } from "../desktop";
import { Cover } from "./Cover";

export const storeKey = (g: { addon: string; externalId: string }) => `${g.addon}:${g.externalId}`;

/** Starts a store game: the PC's own launcher link (Heroic on Linux) when it has one, else the store's. */
export async function launchStoreGame(g: StoreGame, local?: LocalStoreGame): Promise<void> {
  const url = local?.launchUrl ?? g.launchUrl;
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
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    api.storeGames().then(setGames, (e: Error) => {
      setError(e.message);
      setGames([]);
    });
    desktop?.storeGames?.().then(setLocal, () => setLocal([]));
  }, [enabled]);
  const installed = new Map(local.map((l) => [storeKey(l), l]));
  const all = games
    ? [
        ...games,
        ...local
          .filter((l) => !games.some((g) => storeKey(g) === storeKey(l)))
          .map((l): StoreGame => ({ addon: l.addon, store: l.store ?? l.addon, externalId: l.externalId, title: l.title, coverUrl: null, storeUrl: null, launchUrl: l.launchUrl ?? null, playtimeSeconds: null, lastPlayedAt: null, libraryGameId: null })),
      ]
    : null;
  return { games: all, installed, error };
}

/** A game from another store: cover, store badge, and Play / In LootDen / Store. */
export function StoreGameCard({ game: g, local, onError }: { game: StoreGame; local?: LocalStoreGame; onError?: (message: string) => void }) {
  const launch = local?.launchUrl ?? g.launchUrl;
  return (
    <div className="card store-card">
      <Cover game={{ id: storeKey(g), title: g.title, coverUrl: g.coverUrl }} />
      {local && <span className="installed-dot" title="Installed on this PC" />}
      <div className="card-body">
        <div className="card-title" title={g.title}>
          {g.title}
        </div>
        <div className="card-meta">
          <span className="badge">{g.store}</span>
          {g.playtimeSeconds ? ` ${formatPlaytime(g.playtimeSeconds)}` : ""}
        </div>
        <div className="store-actions">
          {launch && (
            <button className="small primary" onClick={() => launchStoreGame(g, local).catch((e) => onError?.(bridgeError(e)))} title={local ? "Start it through the store's launcher" : "Opens the store's launcher to install or play it"}>
              {local ? "▶ Play" : "Play"}
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
