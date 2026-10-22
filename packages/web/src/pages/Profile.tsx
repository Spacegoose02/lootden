import { useEffect, useState } from "react";
import { AppOptions } from "../components/AppOptions";
import { Link } from "react-router-dom";
import type { ApiTokenInfo, GameSummary, UserGameState } from "@lootden/shared";
import { api, avatarUrl, formatPlaytime } from "../api";
import { useAuth } from "../auth";
import { bridgeError, desktop, type InstalledGame } from "../desktop";
import { THEMES, useTheme } from "../theme";

export function Profile() {
  const { me, refresh } = useAuth();
  const { theme, touch, setTouch } = useTheme();
  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0]!;
  const user = me?.user;
  const [name, setName] = useState(user?.displayName ?? "");
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [states, setStates] = useState<UserGameState[]>([]);
  const [games, setGames] = useState<Map<string, GameSummary>>(new Map());
  const [pw, setPw] = useState({ current: "", next: "" });
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!user) return;
    api.tokens().then(setTokens, () => {});
    api.myGames().then(setStates, () => {});
    api.games().then((g) => setGames(new Map(g.map((x) => [x.id, x]))), () => {});
  }, [user]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setMsg(done);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="profile">
      <h1>Profile</h1>
      {msg && <p className="notice">{msg}</p>}

      <section className="panel">
        <h2>Appearance</h2>
        <div className="inline">
          <span className="theme-dots static" aria-hidden="true">
            {current.swatch.map((c, i) => (
              <i key={i} style={{ background: c }} />
            ))}
          </span>
          <span>
            Theme: <strong>{current.name}</strong>
          </span>
          <Link className="button secondary" to="/settings/themes">
            Change theme
          </Link>
        </div>
        <label className="check">
          <input type="checkbox" checked={touch === "on"} onChange={(e) => setTouch(e.target.checked ? "on" : "off")} />
          Touch and handheld mode (bigger targets for ROG Ally and tablets)
        </label>
      </section>

      {desktop && <ThisComputer />}

      {user && (
        <>
          <section className="panel profile-card">
            <img src={avatarUrl(user.avatar)} alt="" width={112} height={112} className="avatar" />
            <div>
              <div className="inline">
                <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
                <button onClick={() => act(async () => { await api.updateMe({ displayName: name }); await refresh(); }, "Name saved")}>Save name</button>
              </div>
              <RaccoonPicker
                current={user.avatar}
                onPick={(seed) => act(async () => { await api.updateMe({ avatar: seed }); await refresh(); }, "New raccoon!")}
              />
              <p className="muted small">
                @{user.username} · {user.role}
                {user.kidMode ? " · kid profile" : ""}
              </p>
            </div>
          </section>

          <section className="panel">
            <h2>My games</h2>
            {states.length === 0 ? (
              <p className="muted">Nothing installed yet. Installs and play time from the LootDen app show up here.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Game</th>
                    <th>Device</th>
                    <th>Status</th>
                    <th className="num">Played</th>
                  </tr>
                </thead>
                <tbody>
                  {states.map((s) => (
                    <tr key={s.gameId + s.device}>
                      <td>{games.get(s.gameId) ? <Link to={`/games/${s.gameId}`}>{games.get(s.gameId)!.title}</Link> : s.gameId}</td>
                      <td>{s.device}</td>
                      <td>{s.uninstalledAt ? "Removed" : s.installedAt ? "Installed" : "—"}</td>
                      <td className="num">{formatPlaytime(s.playtimeSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {states.length > 0 && (
              <p className="small muted">
                <a href="/api/me/export/yamtrack.csv" download>
                  Export for Yamtrack
                </a>{" "}
                (in Yamtrack: Settings, Import, Yamtrack CSV).
              </p>
            )}
          </section>

          <section className="panel">
            <h2>Devices and tokens</h2>
            <p className="muted small">Each computer signed in with the LootDen app or <code>lootden login</code> gets its own token. Revoke one to sign that device out.</p>
            <ul className="list">
              {tokens.map((t) => (
                <li key={t.id}>
                  <span>
                    {t.name} <small className="muted">last used {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"}</small>
                  </span>
                  <button className="ghost" onClick={() => act(async () => { await api.revokeToken(t.id); setTokens(await api.tokens()); }, "Token revoked")}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
            <button
              className="secondary"
              onClick={() =>
                act(async () => {
                  const t = await api.createToken("Manual token");
                  setNewToken(t.token);
                  setTokens(await api.tokens());
                }, "Token created")
              }
            >
              Create token
            </button>
            {newToken && (
              <p className="notice small">
                Copy it now, it is not shown again: <code>{newToken}</code>
              </p>
            )}
          </section>

          <section className="panel">
            <h2>Password</h2>
            <div className="inline">
              {user.hasPassword && <input type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />}
              <input type="password" placeholder="New password (8+ characters)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
              <button onClick={() => act(async () => { await api.changePassword(pw.current, pw.next); setPw({ current: "", next: "" }); }, "Password changed")}>
                {user.hasPassword ? "Change" : "Set password"}
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function ThisComputer() {
  const [info, setInfo] = useState<Awaited<ReturnType<NonNullable<typeof desktop>["info"]>> | null>(null);
  const [installed, setInstalled] = useState<InstalledGame[]>([]);
  const [error, setError] = useState("");
  const load = () => {
    void desktop!.info().then(setInfo);
    void desktop!.installed().then(setInstalled);
  };
  useEffect(load, []);
  if (!info) return null;
  return (
    <section className="panel">
      <h2>This computer ({info.hostname})</h2>
      {error && <p className="error">{error}</p>}
      <div className="inline">
        <span>
          Install new games to <code>{info.installDir}</code>
        </span>
        <button
          className="secondary"
          onClick={async () => {
            const dir = await desktop!.chooseFolder();
            if (dir) {
              await desktop!.setInstallDir(dir).catch((e) => setError(bridgeError(e)));
              load();
            }
          }}
        >
          Change
        </button>
        <button className="ghost" onClick={() => desktop!.toggleFullscreen()}>
          Toggle fullscreen (F11)
        </button>
        <button className="ghost" onClick={() => desktop!.changeServer()}>
          Switch server
        </button>
      </div>
      <ul className="list">
        {installed.map((g) => (
          <li key={g.dir}>
            <Link to={`/games/${g.gameId}`}>{g.title}</Link>
            <small className="muted">{g.dir}</small>
          </li>
        ))}
      </ul>
      {installed.length === 0 && <p className="muted">No games installed on this computer yet.</p>}
      <AppOptions />
    </section>
  );
}

const newSeed = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
const seedBatch = () => Array.from({ length: 8 }, newSeed);

/** Eight random raccoons to choose from, and a button for eight more. */
function RaccoonPicker({ current, onPick }: { current: string; onPick: (seed: string) => void }) {
  const [seeds, setSeeds] = useState(seedBatch);
  return (
    <div className="raccoon-picker">
      <div className="raccoon-grid" role="listbox" aria-label="Pick a raccoon">
        {seeds.map((seed) => (
          <button key={seed} role="option" aria-selected={seed === current} className={seed === current ? "active" : ""} onClick={() => onPick(seed)} title="Use this raccoon">
            <img src={avatarUrl(seed)} alt="" width={48} height={48} />
          </button>
        ))}
      </div>
      <button className="secondary small" onClick={() => setSeeds(seedBatch())}>
        🎲 More raccoons
      </button>
    </div>
  );
}
