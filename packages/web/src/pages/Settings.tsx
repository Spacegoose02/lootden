import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, useParams } from "react-router-dom";
import type { GameSummary, LibraryStats, User } from "@lootden/shared";
import { api, avatarUrl, formatBytes, type Connectors, type ReleaseSourceView, type SourceConfig, type WishlistState } from "../api";
import { AdminApps } from "../components/AdminApps";
import { AdminIntegrations } from "../components/AdminIntegrations";
import { AdminVideos } from "../components/AdminVideos";
import { Card, Field, Pill, Toggle, useConnectors } from "../components/SettingsUi";
import { ThemePicker } from "../components/ThemePicker";
import { useAuth } from "../auth";

type Msg = (m: string, error?: boolean) => void;

const SECTIONS: Array<{ id: string; title: string; blurb: string }> = [
  { id: "library", title: "Library", blurb: "Scanning, metadata and profiles" },
  { id: "steam", title: "Steam & wishlist", blurb: "Your Steam ID and list feeds" },
  { id: "downloads", title: "Downloads", blurb: "Prowlarr, clients and importing" },
  { id: "wanted", title: "Wanted & rules", blurb: "Auto-search and what to grab" },
  { id: "sources", title: "Release sources", blurb: "Feeds and APIs that list new games" },
  { id: "safety", title: "Scanning & alerts", blurb: "Virus scan and notifications" },
  { id: "services", title: "Sign-in & services", blurb: "SSO, metadata keys, itch.io, Nexus" },
  { id: "content", title: "News & apps", blurb: "Feeds, videos and app builds" },
  { id: "themes", title: "Themes", blurb: "Colours and look of LootDen" },
];
/** Sections everyone can open; the rest are admin settings. */
const PERSONAL = new Set(["themes"]);

/** Every admin setting in one place, grouped into a few sections. */
export function Settings() {
  const { me } = useAuth();
  const admin = me?.role === "admin";
  const sections = admin ? SECTIONS : SECTIONS.filter((s) => PERSONAL.has(s.id));
  const { section = sections[0]!.id } = useParams();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const say: Msg = (text, error) => setMsg(text ? { text, error } : null);
  useEffect(() => setMsg(null), [section]);
  if (!sections.some((s) => s.id === section)) return <Navigate to="/settings" replace />;
  const current = sections.find((s) => s.id === section)!;

  return (
    <div className="settings">
      <aside className="settings-nav" aria-label="Settings sections">
        <h1>Settings</h1>
        <nav>
          {sections.map((s) => (
            <NavLink key={s.id} to={`/settings/${s.id}`} className={() => (s.id === section ? "active" : "")}>
              <strong>{s.title}</strong>
              <small>{s.blurb}</small>
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="settings-content">
        <h2 className="settings-title">{current.title}</h2>
        {msg && (
          <p className={msg.error ? "error settings-msg" : "notice settings-msg"} role="status">
            {msg.text}
          </p>
        )}
        {section === "library" && <LibrarySection say={say} />}
        {section === "steam" && <SteamSection say={say} />}
        {section === "downloads" && <DownloadsSection say={say} />}
        {section === "wanted" && <WantedSection say={say} />}
        {section === "sources" && <SourcesSection say={say} />}
        {section === "safety" && <SafetySection say={say} />}
        {section === "services" && <ServicesSection say={say} />}
        {section === "content" && <ContentSection say={say} />}
        {section === "themes" && <ThemePicker />}
      </div>
    </div>
  );
}

function useAct(say: Msg, reload?: () => void) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      say(done);
      reload?.();
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return { busy, act };
}

// ---- Library ----------------------------------------------------------------

function LibrarySection({ say }: { say: Msg }) {
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof api.metadataStatus>> | null>(null);
  const [unmatched, setUnmatched] = useState<GameSummary[]>([]);
  const load = () => {
    api.stats().then(setStats, () => {});
    api.metadataStatus().then(setMeta, () => {});
    api.games({ missingMetadata: true }).then(setUnmatched, () => {});
  };
  useEffect(load, []);
  const { busy, act } = useAct(say, load);
  const used = stats?.disk ? stats.disk.totalBytes - stats.disk.freeBytes : 0;
  return (
    <>
      <Card
        title="Games folder"
        description={stats ? `${stats.gameCount} games, ${formatBytes(stats.totalBytes)}. Last scan ${stats.lastScanAt ? new Date(stats.lastScanAt).toLocaleString() : "never"}.` : "Loading…"}
        actions={
          <>
            <Link className="button ghost" to="/library?tab=stats">
              Library stats
            </Link>
            <button disabled={busy} onClick={() => act(api.rescan, "Library rescanned")}>
              Rescan now
            </button>
          </>
        }
      >
        {stats?.disk && (
          <div className="meter" title={`${formatBytes(stats.disk.freeBytes)} free`}>
            <div style={{ width: `${(used / stats.disk.totalBytes) * 100}%` }} />
            <span>
              {formatBytes(stats.disk.freeBytes)} free of {formatBytes(stats.disk.totalBytes)}
            </span>
          </div>
        )}
      </Card>
      <Card
        title="Metadata"
        description={meta ? `Sources: ${meta.providers.join(", ") || "none"}. ${meta.matched} matched, ${meta.unmatched} without metadata${meta.running ? `, ${meta.queued} in the queue` : ""}.` : "Loading…"}
        status={meta && !meta.providers.includes("igdb") ? <Pill tone="warn">No IGDB keys</Pill> : null}
        actions={
          <>
            <button className="ghost" disabled={busy} onClick={() => act(() => api.refreshMetadata(true), "Retrying every unmatched game")}>
              Retry unmatched
            </button>
            <button
              className="ghost"
              disabled={busy}
              title="Look every game up again with the current sources and their priority. Hand-picked matches keep their pick."
              onClick={() => act(() => api.refreshAllMetadata("all"), "Refreshing every game's metadata in the background")}
            >
              Refresh all
            </button>
            <button disabled={busy} onClick={() => act(() => api.refreshMetadata(false), "Looking up new games")}>
              Look up new games
            </button>
          </>
        }
      >
        {meta && !meta.providers.includes("igdb") && (
          <p className="muted small">
            Add IGDB keys under <Link to="/settings/services">Sign-in &amp; services</Link> for covers, age ratings, Time to Beat and better matches.
          </p>
        )}
        {unmatched.length > 0 && (
          <details>
            <summary>{unmatched.length} games need a match</summary>
            <ul className="list compact">
              {unmatched.slice(0, 50).map((g) => (
                <li key={g.id}>
                  <Link to={`/games/${g.id}`}>{g.title}</Link>
                  <small className="muted">{g.source}</small>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
      <Profiles say={say} />
    </>
  );
}

function Profiles({ say }: { say: Msg }) {
  const [users, setUsers] = useState<User[]>([]);
  const [newUser, setNewUser] = useState({ username: "", password: "", kidMode: false, role: "user" });
  const load = () => void api.users().then(setUsers, () => {});
  useEffect(load, []);
  const { busy, act } = useAct(say, load);
  return (
    <Card title="Profiles" description="Who can sign in. Kid profiles only see games marked family friendly.">
      <ul className="list users">
        {users.map((u) => (
          <li key={u.id}>
            <span className="inline">
              <img src={avatarUrl(u.avatar)} alt="" width={32} height={32} className="avatar" />
              {u.displayName} <small className="muted">@{u.username}</small>
            </span>
            <span className="inline">
              <label className="check">
                <input type="checkbox" checked={u.kidMode} onChange={(e) => act(() => api.updateUser(u.id, { kidMode: e.target.checked }), "Saved")} />
                Kid
              </label>
              <select value={u.role} onChange={(e) => act(() => api.updateUser(u.id, { role: e.target.value }), "Saved")} aria-label="Role">
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
              <button className="ghost small" onClick={() => confirm(`Delete ${u.username}?`) && act(() => api.deleteUser(u.id), "Deleted")}>
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      <form
        className="inline wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await api.createUser({ ...newUser, password: newUser.password || undefined });
            setNewUser({ username: "", password: "", kidMode: false, role: "user" });
          }, "Profile created");
        }}
      >
        <input placeholder="Username" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} required />
        <input type="password" placeholder="Password (blank for SSO only)" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
        <label className="check">
          <input type="checkbox" checked={newUser.kidMode} onChange={(e) => setNewUser({ ...newUser, kidMode: e.target.checked })} />
          Kid profile
        </label>
        <button disabled={busy}>Add profile</button>
      </form>
    </Card>
  );
}

// ---- Steam & wishlist ----------------------------------------------------------------

function SteamSection({ say }: { say: Msg }) {
  const [data, setData] = useState<WishlistState | null>(null);
  const [steamId, setSteamId] = useState("");
  const [autoSync, setAutoSync] = useState(true);
  const [feedUrl, setFeedUrl] = useState("");
  const [feedName, setFeedName] = useState("");
  const [busy, setBusy] = useState(false);
  const apply = (d: WishlistState) => {
    setData(d);
    setSteamId(d.steam?.profile || d.steam?.steamId || "");
    setAutoSync(d.steam?.autoSync !== false);
  };
  useEffect(() => {
    api.wishlist().then(apply, (e: Error) => say(e.message, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async (fn: () => Promise<WishlistState>, done: string) => {
    setBusy(true);
    try {
      apply(await fn());
      say(done);
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const steam = data?.steam;
  return (
    <>
      <Card
        title="Steam integration"
        description="Your Steam ID lets LootDen read your Steam wishlist and show it on the Wishlist page."
        status={steam?.steamId ? <Pill tone={steam.error ? "bad" : "good"}>{steam.error ? "Sync failed" : `Linked · ${steam.count} games`}</Pill> : <Pill tone="muted">Not linked</Pill>}
      >
        <Field
          label="Steam ID (64-bit)"
          hint={
            <>
              The 17-digit number starting 7656…, found on your Steam profile's address or at steamid.io. A profile link or custom URL name works too. The wishlist must be public: Steam, Edit Profile, Privacy Settings, Game details: Public.
            </>
          }
        >
          <span className="inline">
            <input placeholder="76561198000000000" value={steamId} onChange={(e) => setSteamId(e.target.value)} style={{ flex: 1 }} inputMode="text" />
            <button className="primary" disabled={busy} onClick={() => void run(() => api.linkSteamWishlist(steamId, autoSync), steamId.trim() ? "Steam ID saved and wishlist synced" : "Steam unlinked")}>
              {steam?.steamId && !steamId.trim() ? "Unlink" : "Save ID"}
            </button>
          </span>
        </Field>
        {steam?.error && <p className="error small">{steam.error}</p>}
        {steam?.syncedAt && <p className="muted small">Last synced {new Date(steam.syncedAt).toLocaleString()}.</p>}
        <Toggle checked={autoSync} onChange={setAutoSync} label="Auto-Sync Wishlist" hint="Checks your Steam wishlist every six hours and adds new games." />
        <footer className="settings-actions">
          <button className="ghost" disabled={busy || !steam?.steamId} onClick={() => void run(() => api.syncWishlist(), "Synced")}>
            Sync now
          </button>
          <button disabled={busy || !steam?.steamId} onClick={() => void run(() => api.setSteamAutoSync(autoSync), autoSync ? "Auto-sync is on" : "Auto-sync is off")}>
            Save sync settings
          </button>
        </footer>
      </Card>

      <Card title="List feeds" description="Any RSS or Atom feed of games, such as a curator or a Backloggd list. Each item becomes a wishlist entry, and a game already on the list isn't added twice.">
        {data && data.feeds.length > 0 && (
          <ul className="list">
            {data.feeds.map((f) => (
              <li key={f.id}>
                <span>
                  <strong>{f.name}</strong>
                  <br />
                  <small className="muted">
                    {f.url} · {f.itemCount} items{f.checkedAt ? ` · checked ${new Date(f.checkedAt).toLocaleString()}` : ""}
                  </small>
                  {f.error && <small className="error"> · {f.error}</small>}
                </span>
                <button className="ghost small" disabled={busy} onClick={() => void run(() => api.removeWishFeed(f.id), `Removed ${f.name} and the games only it added`)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="inline wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.addWishFeed(feedUrl.trim(), feedName.trim() || undefined), "Feed added").then(() => {
              setFeedUrl("");
              setFeedName("");
            });
          }}
        >
          <input type="url" placeholder="https://example.com/list/rss" value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} style={{ flex: 2, minWidth: 220 }} />
          <input placeholder="Name (optional)" value={feedName} onChange={(e) => setFeedName(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
          <button disabled={busy || !feedUrl.trim()}>Add feed</button>
        </form>
      </Card>
    </>
  );
}

// ---- Downloads ----------------------------------------------------------------

const CLIENT_NAMES: Record<Connectors["torrentClient"], string> = { qbittorrent: "qBittorrent", transmission: "Transmission", deluge: "Deluge" };

function DownloadsSection({ say }: { say: Msg }) {
  const { c, set, save, test, busy } = useConnectors(say);
  const [mapping, setMapping] = useState<string | null>(null);
  if (!c) return <p className="muted">Loading…</p>;
  const map = mapping ?? c.import.pathMappings.map((m) => `${m.from} => ${m.to}`).join("\n");
  const configured = (url: string) => (url ? <Pill tone="good">Set up</Pill> : <Pill tone="muted">Not set up</Pill>);
  const tc = c.torrentClient;
  const saveImport = () => {
    const pathMappings = map
      .split("\n")
      .map((l) => l.split("=>").map((x) => x.trim()))
      .filter((p) => p.length === 2 && p[0] && p[1])
      .map(([from, to]) => ({ from: from!, to: to! }));
    set("import", { pathMappings });
    c.import.pathMappings = pathMappings;
    void save("Import settings saved");
  };
  return (
    <>
      <Card
        title="Prowlarr"
        description="Searches your indexers. Add indexers, and FlareSolverr for sites behind Cloudflare, in Prowlarr itself."
        status={configured(c.prowlarr.url)}
        actions={
          <button disabled={busy} onClick={() => test("prowlarr")}>
            Save and test
          </button>
        }
      >
        <div className="field-grid">
          <Field label="Address">
            <input placeholder="http://tower:9696" value={c.prowlarr.url} onChange={(e) => set("prowlarr", { url: e.target.value })} />
          </Field>
          <Field label="API key">
            <input type="password" value={c.prowlarr.apiKey} onChange={(e) => set("prowlarr", { apiKey: e.target.value })} />
          </Field>
        </div>
      </Card>

      <Card
        title="Torrent client"
        description="LootDen fetches the torrent from Prowlarr itself and hands the client the magnet or .torrent file, then checks the client really added it."
        status={configured(c[tc].url)}
        actions={
          <button disabled={busy} onClick={() => test(tc)}>
            Save and test
          </button>
        }
      >
        <div className="segmented" role="tablist" aria-label="Torrent client">
          {(Object.keys(CLIENT_NAMES) as Array<Connectors["torrentClient"]>).map((k) => (
            <button key={k} role="tab" aria-selected={tc === k} className={tc === k ? "active" : ""} onClick={() => set("torrentClient", k)}>
              {CLIENT_NAMES[k]}
            </button>
          ))}
        </div>
        <div className="field-grid">
          <Field label="Address" hint={tc === "deluge" ? "Deluge's web UI, usually port 8112" : tc === "transmission" ? "Usually port 9091" : "The web UI, usually port 8080"}>
            <input placeholder={tc === "deluge" ? "http://tower:8112" : tc === "transmission" ? "http://tower:9091" : "http://tower:8080"} value={c[tc].url} onChange={(e) => set(tc, { url: e.target.value })} />
          </Field>
          {tc !== "deluge" && (
            <Field label="Username">
              <input value={c[tc].username} onChange={(e) => set(tc, { username: e.target.value })} />
            </Field>
          )}
          <Field label="Password">
            <input type="password" value={c[tc].password} onChange={(e) => set(tc, { password: e.target.value })} />
          </Field>
          <Field label={tc === "qbittorrent" ? "Category" : "Label"} hint={tc === "deluge" ? "Needs Deluge's Label plugin" : undefined}>
            <input value={c[tc].category} onChange={(e) => set(tc, { category: e.target.value })} />
          </Field>
          <Field label="Save to (optional)" hint="As the client sees it; blank uses the client's default">
            <input placeholder="/downloads/games" value={c[tc].savePath} onChange={(e) => set(tc, { savePath: e.target.value })} />
          </Field>
        </div>
      </Card>

      <Card
        title="SABnzbd"
        description="Usenet downloads."
        status={configured(c.sabnzbd.url)}
        actions={
          <button disabled={busy} onClick={() => test("sabnzbd")}>
            Save and test
          </button>
        }
      >
        <div className="field-grid">
          <Field label="Address">
            <input placeholder="http://tower:8085" value={c.sabnzbd.url} onChange={(e) => set("sabnzbd", { url: e.target.value })} />
          </Field>
          <Field label="API key">
            <input type="password" value={c.sabnzbd.apiKey} onChange={(e) => set("sabnzbd", { apiKey: e.target.value })} />
          </Field>
          <Field label="Category">
            <input value={c.sabnzbd.category} onChange={(e) => set("sabnzbd", { category: e.target.value })} />
          </Field>
        </div>
      </Card>

      <Card
        title="Importing"
        description="What happens when a download finishes, and the folder LootDen watches for games you copy in yourself."
        actions={
          <button className="primary" disabled={busy} onClick={saveImport}>
            Save
          </button>
        }
      >
        <div className="field-grid">
          <Field label="When a download finishes">
            <select value={c.import.mode} onChange={(e) => set("import", { mode: e.target.value as Connectors["import"]["mode"] })}>
              <option value="move">Import it, then delete the download</option>
              <option value="copy">Copy it (keeps torrents seeding)</option>
              <option value="off">Leave it where it is</option>
            </select>
          </Field>
          <Field label="Store the game as">
            <select value={c.import.tidy.repack} onChange={(e) => set("import", { tidy: { ...c.import.tidy, repack: e.target.value as "zip" | "folder" } })}>
              <option value="zip">One zip, "Title v1.2.zip"</option>
              <option value="folder">A folder, "Title v1.2"</option>
            </select>
          </Field>
        </div>
        <Toggle checked={c.import.tidy.stripJunk} onChange={(v) => set("import", { tidy: { ...c.import.tidy, stripJunk: v } })} label="Remove junk" hint={'Site links, .nfo files, read-me and "install tutorial" files'} />
        <Toggle checked={c.import.tidy.extract} onChange={(v) => set("import", { tidy: { ...c.import.tidy, extract: v } })} label="Unpack archives" hint="Including archives inside archives. Disc images stay as folders." />
        <Toggle
          checked={c.import.tidy.installers !== false}
          onChange={(v) => set("import", { tidy: { ...c.import.tidy, installers: v } })}
          label="Install installer games on the server"
          hint="Unpacks Inno Setup installers, which most GOG games use, so PCs download the game ready to play. Other installers still run on a PC."
        />
        <Field label="Downloads folder" hint="As this container sees it. Games sitting there are listed on the Downloads page." wide>
          <input placeholder="/downloads/complete" value={c.import.folder} onChange={(e) => set("import", { folder: e.target.value })} />
        </Field>
        <Toggle checked={c.import.autoImportFolder} onChange={(v) => set("import", { autoImportFolder: v })} label="Import new games from that folder automatically" />
        <Field label="Path mappings" hint={<>One per line: <code>client path =&gt; path in this container</code></>} wide>
          <textarea rows={3} value={map} onChange={(e) => setMapping(e.target.value)} placeholder="/data/torrents => /downloads" />
        </Field>
      </Card>
    </>
  );
}

// ---- Wanted & rules ----------------------------------------------------------------

const list = (xs: string[]) => xs.join(", ");
const unlist = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

function WantedSection({ say }: { say: Msg }) {
  const { c, set, save, busy } = useConnectors(say);
  const [text, setText] = useState<Record<string, string>>({});
  if (!c) return <p className="muted">Loading…</p>;
  const w = c.wanted;
  const r = c.rules;
  const listField = (k: "mustContain" | "mustNotContain" | "preferred" | "blockedIndexers") => ({
    value: text[k] ?? list(r[k]),
    onChange: (e: { target: { value: string } }) => {
      setText({ ...text, [k]: e.target.value });
      set("rules", { [k]: unlist(e.target.value) });
    },
  });
  return (
    <>
      <Card
        title="Wanted list"
        description="Wishlist games you don't own yet are searched through Prowlarr. The best release your rules allow shows on the Wishlist page."
        status={c.prowlarr.url ? null : <Pill tone="warn">Prowlarr not set up</Pill>}
        actions={
          <>
            <button className="ghost" disabled={busy} onClick={() => api.runWanted().then(() => say("Searching due games now"), (e: Error) => say(e.message, true))}>
              Search now
            </button>
            <button className="primary" disabled={busy} onClick={() => void save("Wanted settings saved")}>
              Save
            </button>
          </>
        }
      >
        <Toggle checked={w.autoSearch} onChange={(v) => set("wanted", { autoSearch: v })} label="Search automatically" hint="Monitored games are searched on a schedule, one at a time." />
        <Toggle checked={w.autoGrab} onChange={(v) => set("wanted", { autoGrab: v })} disabled={!w.autoSearch} label="Send the best match to the download client" hint="Off: you get an alert and press Grab yourself." />
        <Toggle checked={w.onlyReleased} onChange={(v) => set("wanted", { onlyReleased: v })} label="Only search games that are out" />
        <div className="field-grid">
          <Field label="Search each game every (hours)">
            <input type="number" min={1} max={168} value={w.intervalHours} onChange={(e) => set("wanted", { intervalHours: Number(e.target.value) })} />
          </Field>
        </div>
      </Card>

      <Card
        title="Release rules"
        description="Applied to every search, by hand or automatic. Comma separated; whole words, any case."
        actions={
          <button className="primary" disabled={busy} onClick={() => void save("Rules saved")}>
            Save
          </button>
        }
      >
        <div className="field-grid">
          <Field label="Must contain" hint="Every word here must be in the name">
            <input placeholder="e.g. GOG" {...listField("mustContain")} />
          </Field>
          <Field label="Must not contain">
            <input {...listField("mustNotContain")} />
          </Field>
          <Field label="Preferred words" hint="Earlier words rank higher">
            <input placeholder="e.g. GOG, DRM-Free" {...listField("preferred")} />
          </Field>
          <Field label="Blocked indexers">
            <input {...listField("blockedIndexers")} />
          </Field>
          <Field label="Smallest size (MB)" hint="0 for no limit">
            <input type="number" min={0} value={r.minSizeMb} onChange={(e) => set("rules", { minSizeMb: Number(e.target.value) })} />
          </Field>
          <Field label="Largest size (MB)" hint="0 for no limit">
            <input type="number" min={0} value={r.maxSizeMb} onChange={(e) => set("rules", { maxSizeMb: Number(e.target.value) })} />
          </Field>
          <Field label="Fewest seeders (torrents)">
            <input type="number" min={0} value={r.minSeeders} onChange={(e) => set("rules", { minSeeders: Number(e.target.value) })} />
          </Field>
          <Field label="Prefer">
            <select value={r.preferProtocol} onChange={(e) => set("rules", { preferProtocol: e.target.value as typeof r.preferProtocol })}>
              <option value="any">Either</option>
              <option value="torrent">Torrents</option>
              <option value="usenet">Usenet</option>
            </select>
          </Field>
        </div>
      </Card>
    </>
  );
}

// ---- Scanning & alerts ----------------------------------------------------------------

const ALERT_KINDS: Array<[keyof Connectors["notify"] & string, string, string]> = [
  ["released", "A wishlist game comes out", "Once per game, when its release date passes"],
  ["found", "A wanted game is found", "The search found a release your rules allow"],
  ["grabbed", "A download starts", "Sent to the torrent or usenet client"],
  ["imported", "A game joins the library", "After importing and scanning"],
  ["updates", "A game has an update", "This copy is behind GOG, itch.io or Steam"],
  ["flagged", "The virus scan flags something", "Held for review"],
  ["sources", "A wishlist game shows up in a release source", "From the sources under Release sources"],
];

function SafetySection({ say }: { say: Msg }) {
  const { c, set, save, busy } = useConnectors(say);
  if (!c) return <p className="muted">Loading…</p>;
  const s = c.scan;
  const n = c.notify;
  return (
    <>
      <Card
        title="Virus scan on import"
        description="Every finished download is scanned before it joins the library."
        status={s.clamav === "off" && !s.virusTotalKey ? <Pill tone="muted">Off</Pill> : <Pill tone="good">On</Pill>}
        actions={
          <>
            <Link className="button ghost" to="/downloads#held">
              Held items
            </Link>
            <button disabled={busy} onClick={() => void save("", async () => (await api.testScanner()).message)}>
              Save and test
            </button>
          </>
        }
      >
        <div className="field-grid">
          <Field label="ClamAV">
            <select value={s.clamav} onChange={(e) => set("scan", { clamav: e.target.value as typeof s.clamav })}>
              <option value="off">Off</option>
              <option value="clamd">ClamAV container (clamd)</option>
              <option value="clamscan">clamscan in this container</option>
            </select>
          </Field>
          {s.clamav === "clamd" && (
            <>
              <Field label="ClamAV host">
                <input value={s.clamdHost} onChange={(e) => set("scan", { clamdHost: e.target.value })} />
              </Field>
              <Field label="Port">
                <input type="number" value={s.clamdPort} onChange={(e) => set("scan", { clamdPort: Number(e.target.value) })} />
              </Field>
            </>
          )}
          <Field label="VirusTotal API key (optional)" hint="Looks up the main programs by hash; nothing is uploaded. Free keys allow 4 lookups a minute.">
            <input type="password" value={s.virusTotalKey} onChange={(e) => set("scan", { virusTotalKey: e.target.value })} />
          </Field>
        </div>
        {s.clamav === "clamd" && <p className="muted small">Mount the games folder into the ClamAV container at the same path as here, so ClamAV can read the files.</p>}
        <Toggle checked={s.hold} onChange={(v) => set("scan", { hold: v })} label="Hold flagged games for review" hint="They wait in .held/ until you release or delete them on the Downloads page." />
      </Card>

      <Card
        title="Alerts"
        description="Shown under the bell at the top, and sent through Apprise to Discord, Telegram, ntfy, email and the rest."
        actions={
          <>
            <button className="ghost" disabled={busy || !n.appriseUrl} onClick={() => void save("", async () => (await api.testAlert()).message)}>
              Send a test
            </button>
            <button className="primary" disabled={busy} onClick={() => void save("Alert settings saved")}>
              Save
            </button>
          </>
        }
      >
        <div className="field-grid">
          <Field label="Apprise address" hint="An Apprise API server; add /notify/<key> to use a saved config">
            <input placeholder="http://tower:8000" value={n.appriseUrl} onChange={(e) => set("notify", { appriseUrl: e.target.value })} />
          </Field>
          <Field label="Targets (without a saved config)" hint="Apprise URLs, comma separated">
            <input placeholder="discord://id/token, ntfys://topic" value={n.appriseTargets} onChange={(e) => set("notify", { appriseTargets: e.target.value })} />
          </Field>
        </div>
        <div className="toggle-list">
          {ALERT_KINDS.map(([k, label, hint]) => (
            <Toggle key={k} checked={n[k] as boolean} onChange={(v) => set("notify", { [k]: v } as Partial<Connectors["notify"]>)} label={label} hint={hint} />
          ))}
        </div>
        <p className="muted small">Failed downloads always alert.</p>
      </Card>
    </>
  );
}

// ---- Sign-in & services ----------------------------------------------------------------

function ServicesSection({ say }: { say: Msg }) {
  const { c, set, save, busy } = useConnectors(say);
  return (
    <>
      <Legacy>
        <AdminIntegrations onMessage={(m) => say(m)} />
      </Legacy>
      {c && (
        <Card
          title="Other services"
          actions={
            <>
              <button disabled={busy || !c.nexus.apiKey} onClick={() => void save("", async () => (await api.testNexus()).message)}>
                Save and test NexusMods
              </button>
              <button className="primary" disabled={busy} onClick={() => void save("Saved")}>
                Save
              </button>
            </>
          }
        >
          <div className="field-grid">
            <Field
              label="itch.io API key"
              hint={
                <>
                  Adds free itch.io games from Discover straight into the library, and checks them for updates.{" "}
                  <a href="https://itch.io/user/settings/api-keys" target="_blank" rel="noreferrer">
                    Get a key
                  </a>
                </>
              }
            >
              <input type="password" value={c.itch.apiKey} onChange={(e) => set("itch", { apiKey: e.target.value })} />
            </Field>
            <Field
              label="NexusMods API key"
              hint={
                <>
                  Shows a Trending mods row on each PC game's page, under the game details. Save and test NexusMods checks the key.{" "}
                  <a href="https://next.nexusmods.com/settings/api-keys" target="_blank" rel="noreferrer">
                    Get a key
                  </a>
                </>
              }
            >
              <input type="password" value={c.nexus.apiKey} onChange={(e) => set("nexus", { apiKey: e.target.value })} />
            </Field>
          </div>
          <div className="toggle-list">
            <Toggle
              checked={c.hltb?.enabled !== false}
              onChange={(v) => set("hltb", { enabled: v })}
              label="Time to beat from HowLongToBeat"
              hint="Main story, extras and completionist hours on game pages. HowLongToBeat has no official API, so when it can't be reached IGDB's times show instead (with IGDB keys)."
            />
          </div>
        </Card>
      )}
    </>
  );
}

// ---- News & apps ----------------------------------------------------------------

function ContentSection({ say }: { say: Msg }) {
  const [feeds, setFeeds] = useState<Array<{ id: string; url: string; title: string }>>([]);
  const [feedUrl, setFeedUrl] = useState("");
  const load = () => void api.feeds().then(setFeeds, () => {});
  useEffect(load, []);
  const { busy, act } = useAct(say, load);
  const onMessage = (m: string) => say(m);
  return (
    <>
      <Card title="News feeds" description="RSS or Atom feeds on the News page.">
        <ul className="list">
          {feeds.map((f) => (
            <li key={f.id}>
              <span>
                {f.title} <small className="muted">{f.url}</small>
              </span>
              <button className="ghost small" onClick={() => act(() => api.removeFeed(f.id), "Feed removed")}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api.addFeed(feedUrl);
              setFeedUrl("");
            }, "Feed added");
          }}
        >
          <input type="url" placeholder="https://example.com/feed.xml" value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} required style={{ flex: 1 }} />
          <button disabled={busy}>Add feed</button>
        </form>
      </Card>
      <Legacy>
        <AdminVideos onMessage={onMessage} />
      </Legacy>
      <Legacy>
        <AdminApps onMessage={onMessage} />
      </Legacy>
    </>
  );
}

/** Older panels restyled as settings cards. */
function Legacy({ children }: { children: ReactNode }) {
  return <div className="settings-legacy">{children}</div>;
}

// ---- Release sources ----------------------------------------------------------------

function SourcesSection({ say }: { say: Msg }) {
  const [list, setList] = useState<ReleaseSourceView[] | null>(null);
  useEffect(() => {
    api.sources().then(setList, (e: Error) => say(e.message, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!list) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="muted small settings-intro">
        Sources list newly released games. LootDen checks the ones you switch on every half hour, shows what they list on Discover, and alerts you when a wishlist game appears. To add your own, see{" "}
        <code>packages/server/src/sources/README.md</code>.
      </p>
      {list.map((s) => (
        <SourceCard key={s.id} source={s} say={say} onChange={(v) => setList((l) => l!.map((x) => (x.id === v.id ? v : x)))} onAll={setList} />
      ))}
    </>
  );
}

function SourceCard({ source, say, onChange, onAll }: { source: ReleaseSourceView; say: Msg; onChange: (v: ReleaseSourceView) => void; onAll: (l: ReleaseSourceView[]) => void }) {
  const [c, setC] = useState<SourceConfig>(source.config);
  const [hosts, setHosts] = useState(source.config.extraHosts.join(", "));
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<SourceConfig>) => setC({ ...c, ...patch });
  const payload = () => ({ ...c, extraHosts: hosts.split(/[,\s]+/).filter(Boolean) });
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      say(await fn());
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const st = source.status;
  return (
    <Card
      title={source.name}
      description={source.name !== source.defaultName ? `${source.defaultName}. ${source.description}` : source.description}
      status={!c.enabled ? <Pill tone="muted">Off</Pill> : st.error ? <Pill tone="bad">Failing</Pill> : <Pill tone="good">On · {st.items} listed</Pill>}
      actions={
        <>
          <button
            className="ghost"
            disabled={busy || !c.baseUrl}
            onClick={() =>
              run(async () => {
                const v = await api.saveSource(source.id, payload());
                onChange(v);
                const r = await api.testSource(source.id);
                onAll(r.sources);
                return `${v.name}: ${r.message}`;
              })
            }
          >
            Save and check now
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const v = await api.saveSource(source.id, payload());
                onChange(v);
                return `${v.name} saved`;
              })
            }
          >
            Save
          </button>
        </>
      }
    >
      <Toggle checked={c.enabled} onChange={(v) => set({ enabled: v })} label="Use this source" />
      <div className="field-grid">
        {source.nameable && (
          <Field label="Name (optional)" hint="Shown on Discover and in alerts">
            <input placeholder={source.defaultName} maxLength={80} value={c.displayName} onChange={(e) => set({ displayName: e.target.value })} />
          </Field>
        )}
        <Field label="Address" hint={source.defaultBaseUrl ? `Default: ${source.defaultBaseUrl}` : "The feed or API address"}>
          <input placeholder={source.defaultBaseUrl || "https://example.com/releases.json"} value={c.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
        </Field>
        {source.needsKey && (
          <Field label="API key (optional)" hint="Sent as a Bearer token">
            <input type="password" value={c.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
          </Field>
        )}
        <Field label="Requests per minute">
          <input type="number" min={1} max={120} value={c.perMinute} onChange={(e) => set({ perMinute: Number(e.target.value) })} />
        </Field>
        <Field label="Requests per hour">
          <input type="number" min={1} max={5000} value={c.perHour} onChange={(e) => set({ perHour: Number(e.target.value) })} />
        </Field>
        <Field label="Extra hosts (optional)" hint="Other domains this source may call, comma separated">
          <input placeholder="api.example.com" value={hosts} onChange={(e) => setHosts(e.target.value)} />
        </Field>
      </div>
      <Toggle checked={c.onMyNetwork} onChange={(v) => set({ onMyNetwork: v })} label="On my network" hint="Allow a 192.168.x.x or .lan address. Leave off for internet sources." />
      {(st.lastRunAt || st.error) && (
        <p className={`small ${st.error ? "error" : "muted"}`}>
          {st.error ?? `Checked ${new Date(st.lastRunAt!).toLocaleString()}`} · {st.usedThisHour} requests this hour
        </p>
      )}
    </Card>
  );
}
