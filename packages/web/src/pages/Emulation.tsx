import { useEffect, useState, type CSSProperties } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { platformFor, type GameSummary } from "@lootden/shared";
import { api, formatBytes, type EmulationOverview } from "../api";
import { useAuth } from "../auth";
import { GameGrid } from "../components/GameCard";

function useOverview() {
  const [data, setData] = useState<EmulationOverview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.emulation().then(setData, (e: Error) => setError(e.message));
  }, []);
  return { data, error };
}

/** Chips for every system in the library; PC goes back to the main library. */
function SystemTabs({ data }: { data: EmulationOverview }) {
  return (
    <nav className="system-tabs" aria-label="Systems">
      <NavLink to="/emulation" end>
        All systems
      </NavLink>
      {data.library
        .filter((s) => s.id !== "pc")
        .map((s) => (
          <NavLink key={s.id} to={`/emulation/${s.id}`} style={{ "--system": platformFor(s.id).color } as CSSProperties}>
            {platformFor(s.id).short} <span className="muted">{s.count}</span>
          </NavLink>
        ))}
      <NavLink to="/emulation/setup">Emulators and BIOS</NavLink>
    </nav>
  );
}

/** The Emulation shelf: one tile per console, kept apart from the PC library. */
export function Emulation() {
  const { data, error } = useOverview();
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const systems = data.library.filter((s) => s.id !== "pc");

  return (
    <div className="emulation">
      <h1>Emulation</h1>
      <SystemTabs data={data} />
      {systems.length === 0 ? (
        <section className="panel">
          <h2>No console games yet</h2>
          <p>
            Put console games in an <code>Emulation</code> folder inside your games folder, one folder per system. Each file or folder in a system's folder is
            one game:
          </p>
          <pre className="code-block">{`Emulation/
  ps1/Crash Bandicoot (USA)/Crash Bandicoot (USA).cue + .bin
  ps2/Okami (USA).iso
  snes/Super Mario World (USA).sfc`}</pre>
          <p className="muted small">
            Folder names: {data.platforms.filter((p) => p.id !== "pc").map((p) => p.id).join(", ")}. Admins can also send a download straight to a system from the
            Downloads page.
          </p>
        </section>
      ) : (
        <div className="system-grid">
          {systems.map((s) => {
            const p = platformFor(s.id);
            const emulator = data.emulators.find((e) => e.id === p.emulator);
            return (
              <Link key={s.id} to={`/emulation/${s.id}`} className="system-tile" style={{ "--system": p.color } as CSSProperties}>
                <span className="system-short">{p.short}</span>
                <span className="system-name">{p.name}</span>
                <span className="muted small">
                  {s.count} {s.count === 1 ? "game" : "games"} · {formatBytes(s.sizeBytes)}
                  {emulator ? ` · ${emulator.name}` : ""}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One console's shelf, with box art shaped like that console's cases. */
export function EmulationSystem() {
  const { platform = "" } = useParams();
  const { data, error } = useOverview();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("title");
  const [note, setNote] = useState("");
  const { me } = useAuth();
  const p = platformFor(platform);
  // Looks this system's games up again with the sources and order under Settings, Metadata sources.
  const refresh = () =>
    api.refreshAllMetadata(p.id).then(
      (r) => setNote(`Refreshing ${r.queued} ${p.short} ${r.queued === 1 ? "game" : "games"} in the background. Reload in a minute to see new box art.`),
      (e: Error) => setNote(e.message),
    );

  useEffect(() => {
    setGames(null);
    const desc = sort === "added" || sort === "rating";
    api.games({ platform: p.id, search, sort, order: desc ? "desc" : "asc" }).then(setGames, () => setGames([]));
  }, [p.id, search, sort]);

  if (error) return <p className="error">{error}</p>;
  const emulator = data?.emulators.find((e) => e.id === p.emulator);
  return (
    <div className="emulation" style={{ "--system": p.color } as CSSProperties}>
      <header className="system-banner">
        <span className="system-short">{p.short}</span>
        <div>
          <h1>{p.name}</h1>
          <p className="muted small">
            {games ? `${games.length} ${games.length === 1 ? "game" : "games"}` : "Loading…"}
            {emulator ? ` · plays in ${emulator.name}` : " · no emulator for this system yet"}
            {emulator?.bios.some((b) => b.required && (!b.platform || b.platform === p.id)) ? " · needs a BIOS" : ""}
          </p>
        </div>
      </header>
      {data && <SystemTabs data={data} />}
      <div className="filters panel">
        <input type="search" placeholder={`Search ${p.short} games`} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="title">Title</option>
          <option value="added">Recently added</option>
          <option value="rating">Rating</option>
        </select>
        {me?.role === "admin" && (
          <button className="secondary" onClick={() => void refresh()} title="Look these games up again with the metadata sources and order under Settings">
            ⟳ Refresh metadata
          </button>
        )}
      </div>
      {note && <p className="muted small">{note}</p>}
      {games && games.length === 0 ? <p className="muted">No {p.name} games match.</p> : games && <GameGrid games={games} aspect={p.coverAspect} />}
    </div>
  );
}
