import { useEffect, useSyncExternalStore } from "react";
import type { HelperGameRef } from "@lootden/shared";

/** The game on screen, for Bandit: game pages say which one they show, and stop saying when they close. */
export interface HelperGame {
  ref: HelperGameRef;
  title: string;
  /** Tells chats apart: one conversation per game. */
  key: string;
}

let current: HelperGame | null = null;
const listeners = new Set<() => void>();

function set(next: HelperGame | null): void {
  if (current?.key === next?.key && current?.title === next?.title) return;
  current = next;
  for (const l of listeners) l();
}

/** On a game's page: tells Bandit which game it is (null while it's still loading). */
export function useHelperGame(game: { ref: HelperGameRef; title: string } | null): void {
  const key = game ? ("gameId" in game.ref ? `game:${game.ref.gameId}` : `store:${game.ref.store.addon}:${game.ref.store.id}`) : null;
  const title = game?.title ?? "";
  useEffect(() => {
    if (!key || !game) return;
    set({ ref: game.ref, title, key });
    return () => {
      if (current?.key === key) set(null);
    };
    // The ref is rebuilt each render; the key says when it really changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, title]);
}

/** The game Bandit should help with right now, if any. */
export function useCurrentHelperGame(): HelperGame | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
