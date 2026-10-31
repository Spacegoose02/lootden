import { compareVersion, versionLabel, type GameSummary } from "@lootden/shared";

/** Up to date, an update waiting on the server, or nothing known. */
export function versionStatus(game: Pick<GameSummary, "kind" | "version" | "latestVersion">): { label: string; state: "current" | "outdated"; note: string } | null {
  if (game.kind !== "game") return null;
  const { version, latestVersion: latest } = game;
  if (latest && (!version || compareVersion(latest, version) > 0)) {
    return {
      label: version ? `${versionLabel(version)} → ${versionLabel(latest)}` : `Update ${versionLabel(latest)}`,
      state: "outdated",
      note: version ? `Out of date: ${versionLabel(version)}, the server has an update to ${versionLabel(latest)}` : `Out of date: the server has an update to ${versionLabel(latest)}`,
    };
  }
  if (!version) return null;
  return { label: versionLabel(version), state: "current", note: `Up to date: ${versionLabel(version)} is the newest version on the server` };
}

/** The game's version on its cover: green when up to date, amber when an update is waiting. */
export function VersionTag({ game, inline = false }: { game: Pick<GameSummary, "kind" | "version" | "latestVersion">; inline?: boolean }) {
  const s = versionStatus(game);
  if (!s) return null;
  return (
    <span className={`version-tag version-${s.state}${inline ? " version-inline" : ""}`} title={s.note} aria-label={s.note}>
      <span className="version-dot" aria-hidden="true" />
      {s.label}
    </span>
  );
}
