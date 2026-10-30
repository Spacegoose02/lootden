import { useEffect, useState } from "react";
import { PLATFORMS } from "@lootden/shared";
import { api, formatBytes, type DirectPackage, type LinkCheck } from "../api";
import { ImportMeter } from "../pages/Downloads";
import { useLive } from "../live";

const STATUS: Record<DirectPackage["status"], { label: string; tone: "go" | "wait" | "ok" | "bad" | "muted" }> = {
  queued: { label: "Queued", tone: "wait" },
  downloading: { label: "Downloading", tone: "go" },
  paused: { label: "Paused", tone: "wait" },
  importing: { label: "Importing", tone: "go" },
  imported: { label: "In library", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
};

/**
 * Download Manager: paste links from file hosts (MediaFire, Datanodes, Pixeldrain...), and the
 * server finds the real file behind each page, downloads the lot and adds the game to the library.
 */
export function LinkDownloads({ onMessage }: { onMessage: (m: string) => void }) {
  const [links, setLinks] = useState("");
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState("pc");
  const [checked, setChecked] = useState<LinkCheck[] | null>(null);
  const [hosts, setHosts] = useState<string[]>([]);
  const [packages, setPackages] = useState<DirectPackage[]>([]);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.directDownloads().then(
      (r) => {
        setHosts(r.hosts);
        setPackages(r.packages);
      },
      (e: Error) => onMessage(e.message),
    );
  useLive("downloads", () => void load());
  useEffect(() => {
    void load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) onMessage(done);
      await load();
    } catch (e) {
      onMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const count = (links.match(/https?:\/\/\S+/gi) ?? []).length;
  const bad = checked?.filter((c) => !c.ok).length ?? 0;
  const total = checked?.reduce((t, c) => t + (c.sizeBytes ?? 0), 0) ?? 0;

  return (
    <>
      <section className="panel link-dl">
        <h2>Download from links</h2>
        <p className="muted small">
          Paste the links for one game, one per line (every part of a split archive). LootDen finds the real file behind each page, downloads them on the server and adds the game
          to the library. Works with {hosts.length ? hosts.join(", ") : "the common file hosts"} and plain file links.
        </p>
        <textarea
          rows={5}
          value={links}
          onChange={(e) => {
            setLinks(e.target.value);
            setChecked(null);
          }}
          placeholder={"https://www.mediafire.com/file/…/Game.part1.rar/file\nhttps://datanodes.to/…/Game.part2.rar"}
          aria-label="Links"
          spellCheck={false}
        />
        <div className="inline">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Game name (optional, taken from the files)" aria-label="Game name" style={{ flex: 1, minWidth: 200 }} />
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Send to">
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === "pc" ? "PC games" : `Emulation: ${p.name}`}
              </option>
            ))}
          </select>
        </div>
        <div className="inline">
          <button disabled={busy || !count} onClick={() => act(async () => setChecked(await api.checkLinks(links)))}>
            Check links
          </button>
          <button
            className="primary"
            disabled={busy || !count}
            onClick={() =>
              act(async () => {
                const p = await api.addLinks({ links, name: name.trim() || undefined, platform });
                setLinks("");
                setName("");
                setChecked(null);
                onMessage(`Downloading ${p.name} (${p.files.length} ${p.files.length === 1 ? "file" : "files"}).`);
              })
            }
          >
            Download {count > 1 ? `${count} links` : ""}
          </button>
          {checked && (
            <span className={bad ? "error small" : "muted small"}>
              {bad ? `${bad} of ${checked.length} links won't work` : `All ${checked.length} found${total ? `, ${formatBytes(total)}` : ""}`}
            </span>
          )}
        </div>
        {checked && (
          <table className="table small">
            <tbody>
              {checked.map((c) => (
                <tr key={c.url} className={c.ok ? "" : "blocked"}>
                  <td>{c.host}</td>
                  <td className="link-dl-name">{c.ok ? (c.fileName ?? "File found") : <span className="error">{c.error}</span>}</td>
                  <td className="num">{c.sizeBytes ? formatBytes(c.sizeBytes) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {packages.length > 0 && (
        <section className="dl-queue">
          <div className="dl-cards">
            {packages.map((p) => (
              <LinkCard key={p.id} p={p} busy={busy} act={act} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function LinkCard({ p, busy, act }: { p: DirectPackage; busy: boolean; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const s = STATUS[p.status];
  const size = p.files.reduce((t, f) => t + (f.sizeBytes ?? 0), 0);
  const got = p.files.reduce((t, f) => t + (f.status === "done" ? (f.sizeBytes ?? f.receivedBytes) : f.receivedBytes), 0);
  const done = p.files.filter((f) => f.status === "done").length;
  const pct = size ? Math.min(100, Math.round((got / size) * 1000) / 10) : Math.round((done / p.files.length) * 100);
  const current = p.files.find((f) => f.status === "downloading");
  return (
    <article className={`dl-card tone-${s.tone}`}>
      <div className="dl-card-head">
        <strong className="dl-name" title={p.name}>
          {p.name}
        </strong>
        <span className={`badge dl-state tone-${s.tone}`}>{s.label}</span>
      </div>
      {p.progress ? (
        <ImportMeter progress={p.progress} />
      ) : p.status !== "imported" ? (
        <div className={`meter${p.status === "paused" ? " paused" : ""}`}>
          <div style={{ width: `${pct}%` }} />
          <span>{pct}%</span>
        </div>
      ) : null}
      <div className="dl-facts muted small">
        {p.speed ? <span className="dl-speed">↓ {formatBytes(p.speed)}/s</span> : null}
        <span>
          {done} of {p.files.length} {p.files.length === 1 ? "file" : "files"}
        </span>
        {size > 0 && <span>{p.status === "imported" ? formatBytes(size) : `${formatBytes(got)} of ${formatBytes(size)}`}</span>}
        <span>{[...new Set(p.files.map((f) => f.host))].join(", ")}</span>
        {p.platform && <span>{PLATFORMS.find((x) => x.id === p.platform)?.name ?? p.platform}</span>}
      </div>
      {current && <p className="small muted dl-path">Now: {current.fileName ?? current.url}</p>}
      {p.status === "imported" && p.importedPath && (
        <p className="small dl-path">
          <code>{p.importedPath}</code>
        </p>
      )}
      {p.error && <p className="error small">{p.error}</p>}
      <details className="small">
        <summary>Links</summary>
        <ul className="link-dl-files">
          {p.files.map((f) => (
            <li key={f.id}>
              <span className={f.status === "failed" ? "error" : f.status === "done" ? "" : "muted"}>{f.status === "done" ? "✓" : f.status === "failed" ? "✗" : f.status === "downloading" ? "↓" : "·"}</span>{" "}
              <a href={f.url} target="_blank" rel="noreferrer">
                {f.fileName ?? f.url}
              </a>
              {f.error && <span className="error"> {f.error}</span>}
            </li>
          ))}
        </ul>
      </details>
      <div className="dl-actions">
        {(p.status === "downloading" || p.status === "queued") && (
          <button className="small" disabled={busy} onClick={() => act(() => api.controlDirect(p.id, "pause"))}>
            ❚❚ Pause
          </button>
        )}
        {p.status === "paused" && (
          <button className="small" disabled={busy} onClick={() => act(() => api.controlDirect(p.id, "resume"))}>
            ▶ Resume
          </button>
        )}
        {p.status === "failed" && (
          <button className="small" disabled={busy} onClick={() => act(() => api.controlDirect(p.id, "retry"))}>
            ↻ Retry
          </button>
        )}
        {p.status !== "importing" && (
          <button
            className="ghost small"
            disabled={busy}
            onClick={() => (p.status === "imported" || confirm("Remove this download and delete what's downloaded so far?")) && act(() => api.controlDirect(p.id, "remove"))}
          >
            {p.status === "imported" ? "Clear" : "Remove"}
          </button>
        )}
      </div>
    </article>
  );
}
