import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { platformFor, type GameSummary } from "@lootden/shared";
import { formatBytes } from "../api";
import { useAuth } from "../auth";
import { Badges } from "./Badges";
import { Cover } from "./Cover";
import { GameCard } from "./GameCard";

export type ViewMode = "grid" | "compact" | "covers" | "list";
export type GroupBy = "none" | "genre" | "platform" | "installed" | "letter";

export const VIEW_MODES: Array<[ViewMode, string, string]> = [
  ["grid", "Grid", "▦"],
  ["compact", "Compact", "▪"],
  ["covers", "Cover wall", "▩"],
  ["list", "List", "☰"],
];
export const GROUPS: Array<[GroupBy, string]> = [
  ["none", "No grouping"],
  ["genre", "By genre"],
  ["platform", "By system"],
  ["installed", "Installed or not"],
  ["letter", "A to Z"],
];

export interface ViewPrefs {
  mode: ViewMode;
  group: GroupBy;
}

/**
 * The library layout this person picked, remembered in this browser per user. Storage can
 * be blocked (private windows, previews), so it falls back to the grid.
 */
export function useViewPrefs(scope: string, fallback: ViewPrefs = { mode: "grid", group: "none" }): [ViewPrefs, (p: Partial<ViewPrefs>) => void] {
  const { me } = useAuth();
  const key = `lootden.view.${me?.user?.id ?? me?.role ?? "guest"}.${scope}`;
  const read = (): ViewPrefs => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<ViewPrefs> | null;
      return { ...fallback, ...(saved ?? {}) };
    } catch {
      return fallback;
    }
  };
  const [state, setState] = useState<{ key: string; prefs: ViewPrefs }>(() => ({ key, prefs: read() }));
  // The signed-in user can arrive after the first render; pick up their saved choice then.
  const prefs = state.key === key ? state.prefs : read();
  const update = (p: Partial<ViewPrefs>) => {
    const next = { ...prefs, ...p };
    setState({ key, prefs: next });
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Not saved; the choice still applies until the page is closed.
    }
  };
  return [prefs, update];
}

/** View mode buttons and the grouping menu. */
export function ViewPicker({ prefs, onChange, groups = GROUPS }: { prefs: ViewPrefs; onChange: (p: Partial<ViewPrefs>) => void; groups?: Array<[GroupBy, string]> }) {
  return (
    <div className="view-picker">
      <div className="segmented" role="radiogroup" aria-label="Layout">
        {VIEW_MODES.map(([mode, label, icon]) => (
          <button key={mode} role="radio" aria-checked={prefs.mode === mode} className={prefs.mode === mode ? "active" : ""} onClick={() => onChange({ mode })} title={label}>
            <span aria-hidden="true">{icon}</span> <span className="view-label">{label}</span>
          </button>
        ))}
      </div>
      <select value={prefs.group} onChange={(e) => onChange({ group: e.target.value as GroupBy })} aria-label="Group">
        {groups.map(([g, label]) => (
          <option key={g} value={g}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Splits games into titled groups, keeping their order inside each group. */
export function groupGames<T extends GameSummary>(games: T[], group: GroupBy, isInstalled: (g: T) => boolean): Array<{ title: string; games: T[] }> {
  if (group === "none") return [{ title: "", games }];
  const groups = new Map<string, T[]>();
  const put = (title: string, g: T) => groups.set(title, [...(groups.get(title) ?? []), g]);
  for (const g of games) {
    if (group === "genre") put(g.genres[0] ?? "No genre yet", g);
    else if (group === "platform") put(platformFor(g.platform).name, g);
    else if (group === "installed") put(isInstalled(g) ? "Installed" : "Not installed", g);
    else {
      const first = g.title.trim().charAt(0).toUpperCase();
      put(/[A-Z]/.test(first) ? first : "#", g);
    }
  }
  const order = (t: string) => (t === "Installed" || t === "PC" ? -1 : t === "No genre yet" || t === "#" || t === "Not installed" ? 1 : 0);
  return [...groups.entries()]
    .map(([title, list]) => ({ title, games: list }))
    .sort((a, b) => order(a.title) - order(b.title) || (group === "genre" ? b.games.length - a.games.length : 0) || a.title.localeCompare(b.title));
}

/** The installed mark on a cover. */
export function InstalledPill({ label = "Installed" }: { label?: string }) {
  return (
    <span className="installed-pill" title={label}>
      <span className="installed-glyph" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * Games in the chosen layout, grouped. `aside` adds something per game (an installed mark,
 * Play buttons) to cards and list rows.
 */
export function GameCollection<T extends GameSummary>({
  games,
  prefs,
  isInstalled = () => false,
  aside,
  aspect,
}: {
  games: T[];
  prefs: ViewPrefs;
  isInstalled?: (g: T) => boolean;
  aside?: (g: T) => ReactNode;
  aspect?: number;
}) {
  const groups = groupGames(games, prefs.group, isInstalled);
  const style = aspect ? ({ "--cover-aspect": String(aspect) } as CSSProperties) : undefined;
  return (
    <div className={`collection view-${prefs.mode}`}>
      {groups.map(({ title, games: list }) => (
        <section key={title || "all"} className="collection-group">
          {title && (
            <h2 className="collection-title">
              {title} <span className="muted small">{list.length}</span>
            </h2>
          )}
          {prefs.mode === "list" ? (
            <ul className="game-list">
              {list.map((g) => (
                <li key={g.id}>
                  <Link to={`/games/${g.id}`} className="game-list-cover" tabIndex={-1} aria-hidden="true">
                    <Cover game={g} />
                  </Link>
                  <div className="game-list-main">
                    <Link to={`/games/${g.id}`} className="game-list-title">
                      {g.title}
                    </Link>
                    <span className="muted small">{[g.releaseYear, g.genres.slice(0, 2).join(", ")].filter(Boolean).join(" · ")}</span>
                  </div>
                  <Badges game={g} compact />
                  <span className="muted small num">{formatBytes(g.sizeBytes)}</span>
                  <span className="game-list-aside">
                    {isInstalled(g) && (
                      <span className="badge badge-kid">
                        <span className="installed-glyph" aria-hidden="true" /> Installed
                      </span>
                    )}
                    {aside?.(g)}
                  </span>
                </li>
              ))}
            </ul>
          ) : prefs.mode === "covers" ? (
            <div className={`cover-wall${aspect ? " grid-shaped" : ""}`} style={style}>
              {list.map((g) => (
                <Link key={g.id} to={`/games/${g.id}`} className={`cover-tile${isInstalled(g) ? " is-installed" : ""}`} aria-label={g.title} title={g.title}>
                  <Cover game={g} />
                  <span className="cover-tile-name">{g.title}</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className={`grid${prefs.mode === "compact" ? " grid-compact" : ""}${aspect ? " grid-shaped" : ""}`} style={style}>
              {list.map((g) => (
                <div key={g.id} className={`card-wrap${isInstalled(g) ? " is-installed" : ""}`}>
                  <GameCard game={g} />
                  {isInstalled(g) && <InstalledPill />}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
