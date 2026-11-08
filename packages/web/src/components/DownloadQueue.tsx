import { useEffect, useState } from "react";
import { bridgeError, desktop, type DownloadSettings, type QueueItem, type VerifyResult } from "../desktop";

/**
 * This PC's downloads: the queue (move up, pause, resume), a speed limit, how many at once,
 * and a download window such as overnight. Downloads stopped by the window or a pause resume
 * from where they were.
 */
export function DownloadQueuePanel() {
  const bridge = desktop;
  const [items, setItems] = useState<QueueItem[]>([]);
  const [s, setS] = useState<DownloadSettings | null>(null);
  const [form, setForm] = useState({ limit: "", from: "23:00", to: "07:00", useWindow: false, max: 1 });
  const [error, setError] = useState("");
  useEffect(() => {
    if (!bridge?.queue || !bridge.downloadSettings) return;
    void bridge.queue().then(setItems, () => {});
    void bridge.downloadSettings().then((x) => {
      setS(x);
      setForm({ limit: x.limitKBps ? String(Math.round(x.limitKBps / 1024 * 10) / 10) : "", from: x.window?.from ?? "23:00", to: x.window?.to ?? "07:00", useWindow: !!x.window, max: x.maxAtOnce });
    }, () => {});
    return bridge.onProgress((p) => {
      if (p.type === "queue") setItems(p.items);
    });
  }, [bridge]);
  if (!bridge?.queue || !bridge.downloadSettings) return null;
  const act = (id: string, what: "up" | "down" | "top" | "pause" | "resume") => void bridge.queue!({ id, do: what }).then(setItems, (e) => setError(bridgeError(e)));
  const save = () => {
    const mb = Number(form.limit.replace(",", "."));
    void bridge
      .downloadSettings!({ limitKBps: form.limit.trim() && mb > 0 ? Math.round(mb * 1024) : 0, maxAtOnce: form.max, window: form.useWindow ? { from: form.from, to: form.to } : null })
      .then((x) => (setS(x), setError("")), (e) => setError(bridgeError(e)));
  };
  return (
    <div className="app-options">
      <h3>Downloads on this PC</h3>
      <div className="inline wrap">
        <label className="field">
          <span className="field-label">Speed limit (MB/s, empty for none)</span>
          <input inputMode="decimal" value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} placeholder="No limit" style={{ width: "8em" }} />
        </label>
        <label className="field">
          <span className="field-label">At once</span>
          <select value={form.max} onChange={(e) => setForm({ ...form, max: Number(e.target.value) })}>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n === 1 ? "One at a time" : `${n} at once`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={form.useWindow} onChange={(e) => setForm({ ...form, useWindow: e.target.checked })} />
        Only download between
        <input type="time" value={form.from} disabled={!form.useWindow} onChange={(e) => setForm({ ...form, from: e.target.value })} aria-label="From" />
        and
        <input type="time" value={form.to} disabled={!form.useWindow} onChange={(e) => setForm({ ...form, to: e.target.value })} aria-label="To" />
      </label>
      <div className="inline">
        <button className="secondary" onClick={save}>
          Save
        </button>
        {s && <span className="muted small">{[s.limitKBps ? `${Math.round((s.limitKBps / 1024) * 10) / 10} MB/s` : "No speed limit", s.window ? `${s.window.from} to ${s.window.to}` : "any time"].join(" · ")}</span>}
      </div>
      {error && <p className="error small">{error}</p>}
      {items.length > 0 && (
        <ol className="list download-queue">
          {items.map((i, n) => (
            <li key={i.id} className="inline wrap">
              <strong>{i.title}</strong>
              <span className="muted small">{i.state === "running" ? "Downloading" : (i.note ?? (i.state === "queued" ? "Next up" : i.state))}</span>
              <span className="inline">
                {n > 0 && (
                  <button className="small ghost" onClick={() => act(i.id, "top")} title="Download this next">
                    ⤒ Top
                  </button>
                )}
                {n > 0 && (
                  <button className="small ghost" onClick={() => act(i.id, "up")} aria-label="Move up">
                    ↑
                  </button>
                )}
                {n < items.length - 1 && (
                  <button className="small ghost" onClick={() => act(i.id, "down")} aria-label="Move down">
                    ↓
                  </button>
                )}
                {i.state === "paused" ? (
                  <button className="small" onClick={() => act(i.id, "resume")}>
                    ▶ Resume
                  </button>
                ) : (
                  <button className="small" onClick={() => act(i.id, "pause")}>
                    ⏸ Pause
                  </button>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Verify files on an installed game's page, then Repair what's broken. */
export function VerifyFiles({ gameId }: { gameId: string }) {
  const bridge = desktop;
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [state, setState] = useState<{ busy: string | null; note: string | null; error: boolean }>({ busy: null, note: null, error: false });
  useEffect(() => {
    if (!bridge) return;
    return bridge.onProgress((p) => {
      if (p.gameId !== gameId) return;
      if (p.type === "verify") setState((s) => ({ ...s, busy: `Checking files… ${p.done}/${p.total}` }));
      if (p.type === "repair") setState((s) => ({ ...s, busy: p.total ? `${p.step} (${Math.round((p.received / p.total) * 100)}%)` : p.step }));
    });
  }, [bridge, gameId]);
  if (!bridge?.verify || !bridge.repair) return null;
  const broken = result ? [...result.missing, ...result.changed] : [];
  const verify = async () => {
    setState({ busy: "Checking files…", note: null, error: false });
    try {
      const r = await bridge.verify!(gameId);
      setResult(r);
      const bad = r.missing.length + r.changed.length;
      setState({ busy: null, note: bad ? `${r.missing.length} missing, ${r.changed.length} damaged of ${r.checked} files.` : `All ${r.checked} files are fine.`, error: bad > 0 });
    } catch (e) {
      setState({ busy: null, note: bridgeError(e), error: true });
    }
  };
  const repair = async () => {
    setState({ busy: "Repairing…", note: null, error: false });
    try {
      const r = await bridge.repair!(gameId, broken);
      setResult(null);
      setState({ busy: null, note: `Repaired ${r.repaired} file${r.repaired === 1 ? "" : "s"}. Updates you applied may need applying again.`, error: false });
    } catch (e) {
      setState({ busy: null, note: bridgeError(e), error: true });
    }
  };
  return (
    <span className="inline">
      <button className="ghost" disabled={!!state.busy} onClick={() => void verify()} title="Check the game's files and fix missing or damaged ones">
        {state.busy && !broken.length ? "Checking…" : "Verify files"}
      </button>
      {broken.length > 0 && (
        <button className="secondary" disabled={!!state.busy} onClick={() => void repair()}>
          Repair {broken.length} file{broken.length === 1 ? "" : "s"}
        </button>
      )}
      {(state.busy || state.note) && <span className={state.error ? "error small" : "muted small"}>{state.busy ?? state.note}</span>}
    </span>
  );
}
