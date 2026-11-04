import { compareVersion, versionLabel, type GameSummary } from "@lootden/shared";

type VersionGame = Pick<GameSummary, "kind" | "version" | "latestVersion" | "storeVersion">;

const STORE: Record<string, string> = { gog: "GOG", steam: "Steam", itch: "itch.io" };

/** A store version worth showing as a version ("1.2", "Build 123"); itch.io sometimes only gives a date. */
const looksLikeVersion = (v: string | null | undefined): v is string => !!v && /^(\d|build\s)/i.test(v);

/**
 * Up to date, behind (an update waiting on the server, or a newer version at the store), or
 * not checked. Green only when the update check compared this copy with a store and found
 * nothing newer; a version nothing has been compared with stays neutral.
 */
export function versionStatus(game: VersionGame): { label: string; state: "current" | "outdated" | "unknown"; note: string } | null {
  if (game.kind !== "game") return null;
  const { version, latestVersion: latest, storeVersion: store } = game;
  if (latest && (!version || compareVersion(latest, version) > 0)) {
    return {
      label: version ? `${versionLabel(version)} → ${versionLabel(latest)}` : `Update ${versionLabel(latest)}`,
      state: "outdated",
      note: version ? `Out of date: ${versionLabel(version)}, the server has an update to ${versionLabel(latest)}` : `Out of date: the server has an update to ${versionLabel(latest)}`,
    };
  }
  const where = store ? (STORE[store.source] ?? "the store") : "";
  const storeLatest = looksLikeVersion(store?.latest) ? store!.latest : null;
  // The check is from before this copy was replaced with one at (or past) the store's version.
  const caughtUp = !!(version && storeLatest && compareVersion(storeLatest, version) <= 0);
  if (store?.behind && !caughtUp) {
    return {
      label: version && storeLatest ? `${versionLabel(version)} → ${versionLabel(storeLatest)}` : version ? `${versionLabel(version)} · update` : storeLatest ? `Update ${versionLabel(storeLatest)}` : "Update available",
      state: "outdated",
      note: `Out of date: ${where} has ${storeLatest ? versionLabel(storeLatest) : "a newer version"}${version ? `, this copy is ${versionLabel(version)}` : ""}`,
    };
  }
  if (!version) return null;
  if (store) return { label: versionLabel(version), state: "current", note: `Up to date: ${versionLabel(version)} matches ${where}` };
  return { label: versionLabel(version), state: "unknown", note: `${versionLabel(version)}: the newest version on the server, not compared with a store yet` };
}

/** The game's version on its cover: green when up to date, amber when behind, grey when not checked. */
export function VersionTag({ game, inline = false }: { game: VersionGame; inline?: boolean }) {
  const s = versionStatus(game);
  if (!s) return null;
  return (
    <span className={`version-tag version-${s.state}${inline ? " version-inline" : ""}`} title={s.note} aria-label={s.note}>
      <span className="version-dot" aria-hidden="true" />
      {s.label}
    </span>
  );
}
