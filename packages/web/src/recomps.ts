import { useEffect, useState } from "react";
import { recompsFor, type GameSummary, type RecompInfo } from "@lootden/shared";
import { api } from "./api";

// The recomps an admin added by GitHub link, fetched once per page load and shared by every card.
let added: RecompInfo[] = [];
let loading: Promise<RecompInfo[]> | null = null;
const listeners = new Set<(r: RecompInfo[]) => void>();

function load(): Promise<RecompInfo[]> {
  loading ??= api.recomps().then(
    (r) => {
      added = r.added;
      for (const l of listeners) l(added);
      return added;
    },
    () => added,
  );
  return loading;
}

/** Admin-added recomps (LootDen's own are always known), updating once the server answers. */
export function useAddedRecomps(): RecompInfo[] {
  const [list, setList] = useState(added);
  useEffect(() => {
    listeners.add(setList);
    void load();
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}

/** Recomps that play this library game: native PC versions of a console game. */
export function useRecompsFor(game: Pick<GameSummary, "platform" | "title">): RecompInfo[] {
  const list = useAddedRecomps();
  return recompsFor(game, list);
}
