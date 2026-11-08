import { useEffect, useState } from "react";
import { formatBytes } from "../api";
import { bridgeError, desktop, type RunnersState } from "../desktop";

/** Linux: Proton-GE builds for Windows games, and which one they use (Profile, This computer). */
export function LinuxRunners() {
  const bridge = desktop;
  const [state, setState] = useState<RunnersState | null>(null);
  const [releases, setReleases] = useState<Array<{ name: string; size: number }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = () => void bridge?.runners?.().then(setState, () => {});
  useEffect(() => {
    load();
    if (!bridge) return;
    return bridge.onProgress((p) => {
      if (p.type === "runner") setBusy(`Downloading ${p.name}… ${formatBytes(p.received)} of ${formatBytes(p.total)}`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!bridge?.runners || state?.platform !== "linux") return null;
  const install = async (name: string) => {
    setError("");
    setBusy(`Downloading ${name}…`);
    try {
      await bridge.installRunner!(name);
      load();
    } catch (e) {
      setError(bridgeError(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="app-options">
      <h3>Windows games on Linux</h3>
      <p className="muted small">
        Windows games start through Proton (Valve's Wine, as on the Steam Deck), each with its own prefix, like Heroic and Lutris. LootDen downloads{" "}
        <a href="https://github.com/GloriousEggroll/proton-ge-custom" target="_blank" rel="noreferrer">
          Proton-GE
        </a>{" "}
        from GitHub and checks its published checksum.
      </p>
      <label className="field">
        <span className="field-label">Games start with</span>
        <select value={state.default || "wine"} onChange={(e) => void bridge.setRunner!({ runner: e.target.value }).then(load, (err) => setError(bridgeError(err)))}>
          <option value="wine">Wine (installed on this PC)</option>
          {state.installed.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <div className="inline wrap">
        {releases === null ? (
          <button className="secondary" disabled={!!busy} onClick={() => void bridge.runnerReleases!().then(setReleases, (e) => setError(bridgeError(e)))}>
            Get Proton-GE…
          </button>
        ) : (
          releases.slice(0, 4).map((r) => (
            <button key={r.name} className="secondary small" disabled={!!busy || state.installed.includes(r.name)} onClick={() => void install(r.name)}>
              {state.installed.includes(r.name) ? `${r.name} ✓` : `Install ${r.name} (${formatBytes(r.size)})`}
            </button>
          ))
        )}
      </div>
      {busy && <p className="muted small">{busy}</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** One game's Proton build on Linux (the game's page). */
export function GameRunner({ gameId }: { gameId: string }) {
  const bridge = desktop;
  const [state, setState] = useState<RunnersState | null>(null);
  useEffect(() => void bridge?.runners?.().then(setState, () => {}), [bridge]);
  if (!bridge?.setRunner || state?.platform !== "linux") return null;
  const value = state.games[gameId] ?? "";
  return (
    <label className="inline small" title="How this Windows game starts on Linux">
      <span className="muted">Runs with</span>
      <select value={value} onChange={(e) => void bridge.setRunner!({ gameId, runner: e.target.value || null }).then(() => bridge.runners!().then(setState))}>
        <option value="">This PC's default ({state.default || "Wine"})</option>
        <option value="wine">Wine</option>
        {state.installed.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Add to Steam: LootDen games as non-Steam games, for Big Picture and the Steam Deck's Game Mode. */
export function SteamShortcuts() {
  const bridge = desktop;
  const [status, setStatus] = useState<{ users: string[]; user: string | null; added: string[] } | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => void bridge?.steamStatus?.().then(setStatus, () => {});
  useEffect(load, []);
  if (!bridge?.steamStatus || !status) return null;
  if (!status.users.length) return null;
  const go = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote({ text: await fn() });
      load();
    } catch (e) {
      setNote({ text: bridgeError(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app-options">
      <h3>Steam</h3>
      <p className="muted small">Put this PC's LootDen games in Steam as non-Steam games, with their covers, so they show in Big Picture and the Steam Deck's Game Mode. Steam picks them up when it restarts.</p>
      <div className="inline wrap">
        {status.users.length > 1 && (
          <select value={status.user ?? ""} onChange={(e) => void go(async () => (await bridge.addToSteam!(undefined, e.target.value), "Added to that Steam account."))} aria-label="Steam account">
            {status.users.map((u) => (
              <option key={u} value={u}>
                Steam account {u}
              </option>
            ))}
          </select>
        )}
        <button className="secondary" disabled={busy} onClick={() => void go(async () => `Added ${(await bridge.addToSteam!()).added} games. Restart Steam to see them.`)}>
          Add my games to Steam
        </button>
        {status.added.length > 0 && (
          <button className="ghost" disabled={busy} onClick={() => void go(async () => `Took ${(await bridge.removeFromSteam!()).removed} games out of Steam.`)}>
            Remove them
          </button>
        )}
        <span className="muted small">{status.added.length} in Steam now</span>
      </div>
      {note && <p className={note.error ? "error small" : "muted small"}>{note.text}</p>}
    </div>
  );
}
