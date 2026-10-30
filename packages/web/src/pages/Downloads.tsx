import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PLATFORMS } from "@lootden/shared";
import { api, formatBytes, type DownloadRecord, type ScanRecord, type FolderItem, type ImportProgress, type LiveDownload, type SearchResult } from "../api";
import { DownloadResults } from "../components/DownloadResults";
import { LinkDownloads } from "../components/LinkDownloads";
import { useLive } from "../live";

const eta = (s: number | null) => (s == null ? "" : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

export function Downloads() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "links" ? "links" : "indexers";
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [list, setList] = useState<{ downloads: DownloadRecord[]; other: LiveDownload[] }>({ downloads: [], other: [] });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.downloads().then(setList, (e: Error) => setMsg(e.message));
  // Grabs, failures and imports show at once; the timer keeps the download clients' progress moving.
  useLive("downloads", () => void load());
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) setMsg(done);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Arriving from Discover with ?q= runs the search straight away.
  useEffect(() => {
    const q = params.get("q");
    if (q) void act(async () => setResults(await api.searchDownloads(q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const search = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => setResults(await api.searchDownloads(query)));
  };

  return (
    <div className="downloads">
      <div className="inline" style={{ justifyContent: "space-between" }}>
        <h1>Downloads</h1>
        <Link className="button secondary" to="/settings/downloads">
          Download settings
        </Link>
      </div>
      <div className="segmented" role="radiogroup" aria-label="Kind of download">
        <button role="radio" aria-checked={tab === "indexers"} className={tab === "indexers" ? "active" : ""} onClick={() => setParams({}, { replace: true })}>
          Indexers and clients
        </button>
        <button role="radio" aria-checked={tab === "links"} className={tab === "links" ? "active" : ""} onClick={() => setParams({ tab: "links" }, { replace: true })}>
          Download Manager
        </button>
      </div>
      {msg && <p className="notice">{msg}</p>}
      <HeldForReview onMessage={setMsg} />
      {tab === "links" ? (
        <LinkDownloads onMessage={setMsg} />
      ) : (
        <>

      <form className="panel inline" onSubmit={search}>
        <input type="search" placeholder="Search your Prowlarr indexers (usenet and torrent)" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1 }} />
        <button className="primary" disabled={busy || !query.trim()}>
          Search
        </button>
      </form>

      {results && (
        <section className="panel">
          <h2>Results</h2>
          <DownloadResults results={results} onGrab={(r, platform) => act(() => api.grab({ url: r.downloadUrl, title: r.title, protocol: r.protocol, platform }), `Sent "${r.title}" to ${r.protocol === "usenet" ? "SABnzbd" : "the torrent client"}`)} busy={busy} />
        </section>
      )}

      <DownloadsFolder onMessage={setMsg} />

      <Queue list={list} busy={busy} act={act} />
        </>
      )}
    </div>
  );
}

type Stage = "active" | "queued" | "done";

/** Where a download is, for grouping and its badge. */
function stageOf(d: DownloadRecord): { stage: Stage; label: string; tone: "go" | "wait" | "ok" | "bad" | "muted" } {
  if (d.status === "failed") return { stage: "done", label: "Failed", tone: "bad" };
  if (d.status === "imported") return { stage: "done", label: "In library", tone: "ok" };
  if (d.status === "removed") return { stage: "done", label: "Removed", tone: "muted" };
  if (d.status === "importing") return { stage: "active", label: "Importing", tone: "go" };
  const state = d.live?.state;
  // Finished in the client but the import keeps failing (files not where the path mapping says).
  if (d.error && (!d.live || d.live.progress >= 1)) return { stage: "done", label: "Can't import", tone: "bad" };
  if (!state) return { stage: "queued", label: "Waiting for client", tone: "wait" };
  if (state === "paused") return { stage: "queued", label: "Paused", tone: "wait" };
  if (state === "queued") return { stage: "queued", label: "Queued", tone: "wait" };
  if (state === "checking") return { stage: "active", label: "Checking", tone: "go" };
  if (state === "completed" || state === "seeding") return { stage: "active", label: "Finishing", tone: "go" };
  if (state === "failed") return { stage: "done", label: "Failed", tone: "bad" };
  return { stage: "active", label: "Downloading", tone: "go" };
}

const GROUPS: Array<[Stage, string, string]> = [
  ["active", "Active", "Downloading or being imported into the library."],
  ["queued", "Queued", "Waiting in the download client, or paused."],
  ["done", "Done", "Finished downloads are copied or moved into the games folder and show up in the library."],
];

/** Sent downloads as cards: active first with progress and speed, then queued, then finished. */
function Queue({
  list,
  busy,
  act,
}: {
  list: { downloads: DownloadRecord[]; other: LiveDownload[] };
  busy: boolean;
  act: (fn: () => Promise<unknown>, done?: string) => Promise<void>;
}) {
  const [showDone, setShowDone] = useState(12);
  const staged = list.downloads.map((d) => ({ d, s: stageOf(d) }));
  const speed = staged.reduce((t, { d, s }) => t + (s.stage === "active" && d.live ? d.live.downloadSpeed : 0), 0);
  const active = staged.filter((x) => x.s.stage === "active").length;
  const queued = staged.filter((x) => x.s.stage === "queued").length;
  return (
    <section className="dl-queue">
      <header className="dl-summary panel">
        <div>
          <span className="dl-big">{active}</span> active
        </div>
        <div>
          <span className="dl-big">{queued}</span> queued
        </div>
        <div>
          <span className="dl-big">{speed ? `${formatBytes(speed)}/s` : "Idle"}</span> {speed ? "total speed" : ""}
        </div>
      </header>
      {list.downloads.length === 0 && (
        <div className="panel">
          <p className="muted">Nothing sent yet. Search above, or grab a game from Discover or the wishlist.</p>
        </div>
      )}
      {GROUPS.map(([stage, title, note]) => {
        let items = staged.filter((x) => x.s.stage === stage);
        if (!items.length) return null;
        // Failures first so they're seen; then newest.
        if (stage === "done") items = [...items].sort((a, b) => Number(b.s.tone === "bad") - Number(a.s.tone === "bad") || b.d.addedAt.localeCompare(a.d.addedAt));
        const more = stage === "done" ? Math.max(0, items.length - showDone) : 0;
        return (
          <div key={stage} className={`dl-group dl-${stage}`}>
            <h2>
              {title} <span className="muted small">{items.length}</span>
            </h2>
            {stage !== "active" && <p className="muted small">{note}</p>}
            <div className="dl-cards">
              {items.slice(0, stage === "done" ? showDone : undefined).map(({ d, s }) => (
                <DownloadCard key={d.id} d={d} stage={s} busy={busy} act={act} />
              ))}
            </div>
            {more > 0 && (
              <button className="ghost small" onClick={() => setShowDone((n) => n + 24)}>
                Show {Math.min(more, 24)} more
              </button>
            )}
          </div>
        );
      })}
      {list.other.length > 0 && (
        <details className="dl-group">
          <summary>
            <h2>
              Also in the game category <span className="muted small">{list.other.length}</span>
            </h2>
          </summary>
          <p className="muted small">Added to the download client some other way. LootDen doesn't import these.</p>
          <div className="dl-cards">
            {list.other.map((o) => (
              <article key={o.client + o.id} className="dl-card">
                <div className="dl-card-head">
                  <strong className="dl-name">{o.name}</strong>
                  <span className="badge badge-muted">{o.state}</span>
                </div>
                <div className="meter slim">
                  <div style={{ width: `${o.progress * 100}%` }} />
                </div>
                <div className="dl-facts muted small">
                  <span>{Math.round(o.progress * 100)}%</span>
                  <span>{o.client}</span>
                  {o.sizeBytes > 0 && <span>{formatBytes(o.sizeBytes)}</span>}
                </div>
              </article>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function DownloadCard({
  d,
  stage,
  busy,
  act,
}: {
  d: DownloadRecord;
  stage: ReturnType<typeof stageOf>;
  busy: boolean;
  act: (fn: () => Promise<unknown>, done?: string) => Promise<void>;
}) {
  const live = d.live;
  const pct = live ? Math.round(live.progress * 1000) / 10 : null;
  const showBar = stage.stage !== "done" && (d.progress || live);
  return (
    <article className={`dl-card tone-${stage.tone}`}>
      <div className="dl-card-head">
        <strong className="dl-name" title={d.name}>
          {d.name}
        </strong>
        <span className={`badge dl-state tone-${stage.tone}`}>{stage.label}</span>
      </div>
      {showBar &&
        (d.progress ? (
          <ImportMeter progress={d.progress} />
        ) : (
          <div className={`meter${stage.label === "Paused" ? " paused" : ""}`}>
            <div style={{ width: `${pct ?? 0}%` }} />
            <span>{pct != null ? `${pct}%` : ""}</span>
          </div>
        ))}
      <div className="dl-facts muted small">
        {stage.stage === "active" && live?.downloadSpeed ? <span className="dl-speed">↓ {formatBytes(live.downloadSpeed)}/s</span> : null}
        {stage.stage === "active" && live?.etaSeconds ? <span>{eta(live.etaSeconds)} left</span> : null}
        {live?.sizeBytes ? <span>{stage.stage === "done" ? formatBytes(live.sizeBytes) : `${formatBytes(live.sizeBytes * live.progress)} of ${formatBytes(live.sizeBytes)}`}</span> : null}
        <span>{d.client}</span>
        <span title={new Date(d.addedAt).toLocaleString()}>Added {new Date(d.addedAt).toLocaleDateString()}</span>
      </div>
      {d.status === "imported" && d.importedPath && (
        <p className="small dl-path">
          <code>{d.importedPath}</code>
        </p>
      )}
      {d.error && <p className="error small">{d.error}</p>}
      <div className="dl-actions">
        {live?.state === "paused" && (
          <button className="small" disabled={busy} onClick={() => act(() => api.controlDownload(d.id, "resume"))}>
            ▶ Resume
          </button>
        )}
        {live?.state === "downloading" && (
          <button className="small" disabled={busy} onClick={() => act(() => api.controlDownload(d.id, "pause"))}>
            ❚❚ Pause
          </button>
        )}
        <button className="ghost small" disabled={busy} onClick={() => act(() => api.controlDownload(d.id, "remove", d.status !== "imported" && confirm("Also delete the downloaded files?")))}>
          Remove
        </button>
      </div>
    </article>
  );
}

/** Imports the virus scan flagged, waiting for an admin to release or delete them. */
function HeldForReview({ onMessage }: { onMessage: (m: string) => void }) {
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.scans().then(setScans, () => {});
  }, []);
  const held = scans.filter((s) => s.status === "flagged" && s.heldPath);
  if (!held.length) return null;
  const decide = async (s: ScanRecord, action: "release" | "delete") => {
    if (action === "delete" && !confirm(`Delete ${s.name} for good?`)) return;
    setBusy(true);
    try {
      setScans(await api.decideScan(s.id, action));
      onMessage(action === "release" ? `${s.name} is in the library` : `Deleted ${s.name}`);
    } catch (e) {
      onMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel held" id="held">
      <h2>Held for review</h2>
      <p className="muted small">The virus scan flagged these, so they were kept out of the library.</p>
      <ul className="list">
        {held.map((s) => (
          <li key={s.id} className="download">
            <div style={{ flex: 1, minWidth: 240 }}>
              <strong>{s.name}</strong>
              <br />
              <small className="muted">Scanned {new Date(s.scannedAt).toLocaleString()}</small>
              <ul className="findings">
                {s.findings.slice(0, 6).map((f, i) => (
                  <li key={i}>
                    <small className="error">{f.threat}</small> <small className="muted">{f.file}</small>
                  </li>
                ))}
              </ul>
            </div>
            <span className="inline">
              <button disabled={busy} onClick={() => void decide(s, "release")}>
                Add to library anyway
              </button>
              <button className="ghost" disabled={busy} onClick={() => void decide(s, "delete")}>
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Games already in the downloads folder: import them with the usual clean-up, or leave them be. */
function DownloadsFolder({ onMessage }: { onMessage: (m: string) => void }) {
  const [data, setData] = useState<{ folder: string; items: FolderItem[] } | null>(null);
  const [platforms, setPlatforms] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const load = () => api.downloadsFolder().then(setData, (e: Error) => setData({ folder: "", items: [] }) ?? onMessage(e.message));
  useEffect(() => {
    void load();
  }, []);
  const active = !!busy || !!data?.items.some((i) => i.status === "importing");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void api.downloadsFolder().then(setData, () => {}), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!data?.folder) return null;
  // ROM files say which system they're for when only one system uses the extension.
  const guess = (name: string) => {
    const ext = name.match(/\.(\w+)$/)?.[1]?.toLowerCase();
    const hits = ext ? PLATFORMS.filter((p) => p.id !== "pc" && p.extensions.includes(ext)) : [];
    return hits.length === 1 ? hits[0]!.id : "pc";
  };
  const items = data.items.filter((i) => showDone || i.status === "new" || i.status === "failed" || i.status === "importing");
  const run = async (name: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(name);
    try {
      await fn();
      onMessage(done);
    } catch (e) {
      onMessage((e as Error).message);
    } finally {
      setBusy(null);
      await load();
    }
  };
  return (
    <section className="panel">
      <div className="inline" style={{ justifyContent: "space-between" }}>
        <h2>In the downloads folder</h2>
        <label className="check small">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          Show imported and skipped
        </label>
      </div>
      <p className="muted small">
        <code>{data.folder}</code>. Import unpacks archives, removes junk and stores the game in the library (or a console's folder).
      </p>
      {items.length === 0 ? (
        <p className="muted">Nothing new.</p>
      ) : (
        <ul className="list">
          {items.map((i) => (
            <li key={i.name} className="download">
              <div style={{ flex: 1, minWidth: 240 }}>
                <strong>{i.name}</strong>
                <br />
                <small className="muted">
                  {formatBytes(i.sizeBytes)} · {new Date(i.modifiedAt).toLocaleString()}
                  {i.settling ? " · still being written" : ""}
                  {i.status === "imported" ? ` · imported to ${i.target}` : i.status !== "new" ? ` · ${i.status}` : ""}
                </small>
                {i.error && <small className="error"> · {i.error}</small>}
                {i.progress && <ImportMeter progress={i.progress} />}
              </div>
              {i.status !== "imported" && (
                <span className="inline">
                  <select value={platforms[i.name] ?? guess(i.name)} onChange={(e) => setPlatforms({ ...platforms, [i.name]: e.target.value })} aria-label="Send to">
                    {PLATFORMS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id === "pc" ? "PC games" : `Emulation: ${p.short}`}
                      </option>
                    ))}
                  </select>
                  <button
                    className="primary"
                    disabled={!!busy || i.settling}
                    onClick={() => {
                      const p = platforms[i.name] ?? guess(i.name);
                      void run(i.name, () => api.importFromFolder(i.name, p === "pc" ? null : p), `Imported ${i.name}`);
                    }}
                  >
                    {busy === i.name ? "Importing…" : "Import"}
                  </button>
                  {i.status !== "skipped" && (
                    <button className="ghost" disabled={!!busy} onClick={() => void run(i.name, () => api.skipFolderItem(i.name), `Skipping ${i.name}`)}>
                      Skip
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const STAGES: Record<ImportProgress["stage"], string> = { copying: "Copying", unpacking: "Unpacking", installing: "Installing", cleaning: "Cleaning up", zipping: "Zipping" };

/** "Unpacking 42%" with a bar; steps that can't measure themselves show a moving bar. */
export function ImportMeter({ progress }: { progress: ImportProgress }) {
  return (
    <div className="import-meter">
      <small>
        {STAGES[progress.stage]}
        {progress.percent != null ? ` ${progress.percent}%` : "…"}
      </small>
      <div className={`meter slim${progress.percent == null ? " busy" : ""}`}>
        <div style={{ width: `${progress.percent ?? 100}%` }} />
      </div>
    </div>
  );
}
