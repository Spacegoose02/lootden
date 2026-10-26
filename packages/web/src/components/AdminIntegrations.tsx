import { useEffect, useRef, useState } from "react";
import { api, type Integrations, type MetadataSourceEntry } from "../api";

type S = Integrations["settings"];

const SOURCE_LABELS: Record<string, string> = {
  igdb: "IGDB",
  screenscraper: "ScreenScraper",
  launchbox: "LaunchBox Games DB",
  thegamesdb: "TheGamesDB",
  rawg: "RAWG",
  steam: "Steam store",
};

/** One reorderable list of metadata sources: tried top to bottom, unticked ones skipped. */
function SourceOrder({ title, entries, ready, onChange }: { title: string; entries: MetadataSourceEntry[]; ready: string[]; onChange: (e: MetadataSourceEntry[]) => void }) {
  const move = (i: number, d: number) => {
    const next = [...entries];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="source-order">
      <strong>{title}</strong>
      <ol>
        {entries.map((e, i) => (
          <li key={e.id} className={e.on ? "" : "muted"}>
            <label className="check">
              <input type="checkbox" checked={e.on} onChange={(ev) => onChange(entries.map((x) => (x.id === e.id ? { ...x, on: ev.target.checked } : x)))} />
              {SOURCE_LABELS[e.id] ?? e.id}
            </label>
            {e.on && !ready.includes(e.id) && <small className="muted"> {e.id === "launchbox" ? "not turned on" : "needs its key"}</small>}
            <span className="order-buttons">
              <button type="button" className="secondary small" aria-label={`Move ${SOURCE_LABELS[e.id]} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" className="secondary small" aria-label={`Move ${SOURCE_LABELS[e.id]} down`} disabled={i === entries.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** API keys and TinyAuth / OIDC sign-in, editable without touching the container. */
export function AdminIntegrations({ onMessage }: { onMessage: (m: string) => void }) {
  const [view, setView] = useState<Integrations | null>(null);
  const [s, setS] = useState<S | null>(null);
  const [busy, setBusy] = useState(false);

  // Load once, so a parent re-render never replaces what is being typed.
  const report = useRef(onMessage);
  report.current = onMessage;
  useEffect(() => {
    api.integrations().then((v) => {
      setView(v);
      setS(v.settings);
    }, (e: Error) => report.current(e.message));
  }, []);
  if (!s || !view) return null;

  const set = <K extends keyof S>(k: K, patch: S[K] extends object ? Partial<S[K]> : S[K]) =>
    setS({ ...s, [k]: typeof patch === "object" ? { ...(s[k] as object), ...patch } : patch });
  const env = (k: string) => view.fromEnvironment.includes(k);
  const save = async () => {
    const v = await api.saveIntegrations(s);
    setView(v);
    setS(v.settings);
    return v;
  };
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      onMessage(await fn());
    } catch (e) {
      onMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const test = (name: string) => run(async () => (await save(), (await api.testIntegration(name)).message));
  const envNote = (k: string) => (env(k) ? <small className="muted"> Set in the container's environment; values here take priority.</small> : null);
  const origin = location.origin;

  return (
    <section className="panel integrations" id="integrations">
      <h2>Sign-in and game info keys</h2>

      <h3>Public address</h3>
      <div className="inline">
        <input placeholder={origin} value={s.publicUrl} onChange={(e) => set("publicUrl", e.target.value)} style={{ flex: 1 }} />
        <button type="button" className="secondary" onClick={() => set("publicUrl", origin)}>
          Use this address
        </button>
      </div>
      <p className="muted small">How people reach the server, e.g. https://games.example.com. Needed for single sign-on.{envNote("publicUrl")}</p>

      <h3>Single sign-on (TinyAuth or any OIDC provider)</h3>
      <ol className="steps small muted">
        <li>
          In TinyAuth, add an OIDC client for LootDen with this redirect URL:{" "}
          <code>{view.callbackUrl ?? `${s.publicUrl || origin}/api/auth/oidc/callback`}</code>
        </li>
        <li>Paste TinyAuth's address and the client ID and secret it gives you below.</li>
        <li>Press Save and test. A "Sign in with …" button then appears on the login page.</li>
      </ol>
      <div className="grid-form">
        <label>
          Issuer (TinyAuth's address)
          <input placeholder="https://auth.example.com" value={s.oidc.issuer} onChange={(e) => set("oidc", { issuer: e.target.value })} />
        </label>
        <label>
          Client ID
          <input value={s.oidc.clientId} onChange={(e) => set("oidc", { clientId: e.target.value })} />
        </label>
        <label>
          Client secret
          <input type="password" value={s.oidc.clientSecret} onChange={(e) => set("oidc", { clientSecret: e.target.value })} />
        </label>
        <label>
          Button label
          <input placeholder="TinyAuth" value={s.oidc.name} onChange={(e) => set("oidc", { name: e.target.value })} />
        </label>
        <label>
          Admin group (optional)
          <input placeholder="admins" value={s.oidc.adminGroup} onChange={(e) => set("oidc", { adminGroup: e.target.value })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={s.oidc.autoCreate} onChange={(e) => set("oidc", { autoCreate: e.target.checked })} />
          Create a profile on first sign-in
        </label>
      </div>
      <button disabled={busy} onClick={() => test("oidc")}>
        Save and test
      </button>
      {envNote("oidc")}

      <h3>Game information and artwork</h3>
      <p className="muted small">All free. Steam and PCGamingWiki always work without keys; these add better matches and artwork.</p>
      <div className="api-row">
        <div>
          <strong>IGDB</strong> <small className="muted">best metadata · Twitch developer app at dev.twitch.tv/console</small>
          {envNote("igdb")}
        </div>
        <input placeholder="Client ID" value={s.igdb.clientId} onChange={(e) => set("igdb", { clientId: e.target.value })} />
        <input type="password" placeholder="Client secret" value={s.igdb.clientSecret} onChange={(e) => set("igdb", { clientSecret: e.target.value })} />
        <button disabled={busy} onClick={() => test("igdb")}>
          Save and test
        </button>
      </div>
      <div className="api-row">
        <div>
          <strong>SteamGridDB</strong> <small className="muted">covers and backgrounds · key at steamgriddb.com, Preferences, API</small>
          {envNote("steamgriddb")}
        </div>
        <input type="password" placeholder="API key" value={s.steamgriddb.apiKey} onChange={(e) => set("steamgriddb", { apiKey: e.target.value })} />
        <button disabled={busy} onClick={() => test("steamgriddb")}>
          Save and test
        </button>
      </div>
      <div className="api-row">
        <div>
          <strong>RAWG</strong> <small className="muted">large catalogue · key at rawg.io/apidocs</small>
          {envNote("rawg")}
        </div>
        <input type="password" placeholder="API key" value={s.rawg.apiKey} onChange={(e) => set("rawg", { apiKey: e.target.value })} />
        <button disabled={busy} onClick={() => test("rawg")}>
          Save and test
        </button>
      </div>

      <h3>Retro and emulated games</h3>
      <p className="muted small">Box art, screenshots and descriptions for ROMs. Each one is optional.</p>
      <div className="api-row">
        <div>
          <strong>ScreenScraper</strong>{" "}
          <small className="muted">
            matches ROMs by checksum · developer login from the screenscraper.fr forum, plus your own account (optional) for more lookups a day
          </small>
          {envNote("screenscraper")}
        </div>
        <input placeholder="Developer ID" value={s.screenscraper.devId} onChange={(e) => set("screenscraper", { devId: e.target.value })} />
        <input type="password" placeholder="Developer password" value={s.screenscraper.devPassword} onChange={(e) => set("screenscraper", { devPassword: e.target.value })} />
        <input placeholder="Username (optional)" value={s.screenscraper.username} onChange={(e) => set("screenscraper", { username: e.target.value })} />
        <input type="password" placeholder="Password (optional)" value={s.screenscraper.password} onChange={(e) => set("screenscraper", { password: e.target.value })} />
        <button disabled={busy} onClick={() => test("screenscraper")}>
          Save and test
        </button>
      </div>
      <div className="api-row">
        <div>
          <strong>TheGamesDB</strong> <small className="muted">console box art · API key from the API key thread on forums.thegamesdb.net</small>
          {envNote("thegamesdb")}
        </div>
        <input type="password" placeholder="API key" value={s.thegamesdb.apiKey} onChange={(e) => set("thegamesdb", { apiKey: e.target.value })} />
        <button disabled={busy} onClick={() => test("thegamesdb")}>
          Save and test
        </button>
      </div>
      <div className="api-row">
        <div>
          <strong>LaunchBox Games DB</strong>{" "}
          <small className="muted">no key · the server downloads the whole database (about 100 MB) once a month and searches it locally</small>
          {envNote("launchbox")}
        </div>
        <label className="check">
          <input type="checkbox" checked={s.launchbox.enabled} onChange={(e) => set("launchbox", { enabled: e.target.checked })} />
          Use LaunchBox
        </label>
        <button disabled={busy} onClick={() => test("launchbox")}>
          Save and test
        </button>
      </div>

      <h3>Source priority</h3>
      <p className="muted small">
        Sources are tried from the top until one finds a confident match. Later sources fill in a missing cover, description or screenshots.
      </p>
      <div className="source-orders">
        <SourceOrder title="PC games" entries={s.metadataOrder.pc} ready={view.ready} onChange={(pc) => set("metadataOrder", { pc })} />
        <SourceOrder title="Emulated games" entries={s.metadataOrder.emulated} ready={view.ready} onChange={(emulated) => set("metadataOrder", { emulated })} />
      </div>
      <button disabled={busy} onClick={() => run(async () => (await save(), "Source priority saved"))}>
        Save priority
      </button>
      <p className="muted small">IGDB is throttled to about 3 requests a second, under its limit of 4. After adding keys or changing the order, use "Retry unmatched" under Library.</p>
    </section>
  );
}
