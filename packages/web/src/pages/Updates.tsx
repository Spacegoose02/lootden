import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { versionLabel as v, type GameSummary } from "@lootden/shared";
import { api, formatBytes } from "../api";
import { Cover } from "../components/Cover";
import { KindBadge, UpdateActions, useInstalled, versionLabel, versionProblem } from "../components/UpdateActions";

type Filter = "all" | "ready" | "updates" | "dlc" | "only";

/**
 * Updates and DLC on the server, grouped by the game they belong to, with what can be
 * applied to the games installed on this PC.
 */
export function Updates() {
  const [addons, setAddons] = useState<GameSummary[] | null>(null);
  const [games, setGames] = useState<Map<string, GameSummary>>(new Map());
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [installed, refreshInstalled] = useInstalled();

  useEffect(() => {
    Promise.all([api.games({ kind: "addon", sort: "added", order: "desc" }), api.games()]).then(
      ([a, g]) => {
        setAddons(a);
        setGames(new Map(g.map((x) => [x.id, x])));
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  const ready = (u: GameSummary) => {
    const local = installed?.find((g) => g.gameId === u.baseGameId);
    return !!local && !local.updates?.some((x) => x.id === u.id) && !versionProblem(u, local);
  };
  const groups = useMemo(() => {
    const shown = (addons ?? []).filter((u) =>
      filter === "ready" ? ready(u) : filter === "updates" ? u.kind === "update" : filter === "dlc" ? u.kind === "dlc" : filter === "only" ? !u.baseGameId : true,
    );
    const byBase = new Map<string, GameSummary[]>();
    for (const u of shown) byBase.set(u.baseGameId ?? "", [...(byBase.get(u.baseGameId ?? "") ?? []), u]);
    // Games with something to apply first, then by name; update-only packages last.
    return [...byBase.entries()].sort(([a, ua], [b, ub]) => {
      if (!a !== !b) return a ? -1 : 1;
      const ra = ua.some(ready) ? 0 : 1;
      const rb = ub.some(ready) ? 0 : 1;
      return ra - rb || (games.get(a)?.title ?? "").localeCompare(games.get(b)?.title ?? "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addons, filter, installed, games]);

  const moved = [...games.values()].filter((g) => g.kindReason && (g.kindReason.by === "size" || g.kindReason.by === "content"));
  if (error) return <p className="error">{error}</p>;
  if (!addons) return <p className="muted">Loading…</p>;
  const count = (f: Filter) => addons.filter((u) => (f === "ready" ? ready(u) : f === "updates" ? u.kind === "update" : f === "dlc" ? u.kind === "dlc" : f === "only" ? !u.baseGameId : true)).length;

  return (
    <section className="pkg-page">
      <h1>Updates</h1>
      <p className="muted">
        Patches and DLC on the server, apart from full games. Apply one to a game installed on this PC; the files it replaces are kept so it can be undone.
      </p>
      <div className="tabs">
        {(
          [
            ["all", "All"],
            ...(installed ? [["ready", "Ready to apply"]] : []),
            ["updates", "Updates"],
            ["dlc", "DLC"],
            ["only", "Update only"],
          ] as Array<[Filter, string]>
        ).map(([id, label]) => (
          <button key={id} className={filter === id ? "tab active" : "tab"} onClick={() => setFilter(id)}>
            {label} <span className="muted">{count(id)}</span>
          </button>
        ))}
      </div>

      {!addons.length && (
        <div className="panel">
          <p>No updates or DLC on the server yet.</p>
          <p className="muted small">
            Put patches in an <code>Updates</code> folder (and DLC in <code>DLC</code>) in your games folder, or name them like <code>Game Name Update v1.2</code>. Each is matched to its game by name.
          </p>
        </div>
      )}
      {addons.length > 0 && !groups.length && <p className="muted">Nothing here.</p>}

      {moved.length > 0 && filter === "all" && (
        <article className="panel pkg-group">
          <h2>Full games named as updates</h2>
          <p className="muted small">These are as big as their game, or hold a full installer, so they're in the library as games. An admin can change that from their page.</p>
          <ul className="pkg-list">
            {moved.map((g) => (
              <li key={g.id}>
                <div className="pkg-title">
                  <Link to={`/games/${g.id}`}>{g.title}</Link>
                  <KindBadge game={g} detail />
                </div>
              </li>
            ))}
          </ul>
        </article>
      )}

      {groups.map(([baseId, items]) => {
        const base = baseId ? games.get(baseId) : undefined;
        const local = installed?.find((g) => g.gameId === baseId);
        return (
          <article key={baseId || "none"} className="panel pkg-group">
            <header className="pkg-head">
              {base ? (
                <Link to={`/games/${base.id}`} className="pkg-cover">
                  <Cover game={base} />
                </Link>
              ) : null}
              <div>
                <h2>{base ? <Link to={`/games/${base.id}`}>{base.title}</Link> : "Update only"}</h2>
                <p className="muted small">
                  {!base
                    ? "Their games aren't on the server. An admin can match them to a game from their page."
                    : installed === null
                      ? `${base.version ? `Server copy ${v(base.version)}` : ""}`
                      : local
                        ? `Installed on this PC${local.version ? `: ${v(local.version)}` : ""}${local.updates?.length ? ` · ${local.updates.length} applied` : ""}`
                        : "Not installed on this PC"}
                </p>
              </div>
            </header>
            <ul className="pkg-list">
              {items.map((u) => (
                <li key={u.id}>
                  <div className="pkg-title">
                    <Link to={`/games/${u.id}`}>{u.title}</Link>
                    <KindBadge game={u} />
                    {versionLabel(u) && <span className="muted small">{versionLabel(u)}</span>}
                    <span className="muted small">{formatBytes(u.sizeBytes)}</span>
                  </div>
                  <UpdateActions update={u} baseTitle={base?.title ?? null} installed={installed} onChange={refreshInstalled} />
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </section>
  );
}
