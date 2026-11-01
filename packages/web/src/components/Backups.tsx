import { useEffect, useRef, useState } from "react";
import { api, formatBytes, type BackupState } from "../api";

/** Settings, Backups: copies of the database made daily or on demand, downloading, uploading and restoring them. */
export function BackupsSection({ say }: { say: (m: string, error?: boolean) => void }) {
  const [s, setS] = useState<BackupState | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api.backups().then(setS, (e: Error) => say(e.message, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async (fn: () => Promise<BackupState>, done?: string) => {
    setBusy(true);
    try {
      setS(await fn());
      if (done) say(done);
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  if (!s) return <p className="muted">Loading…</p>;
  return (
    <>
      <section className="panel">
        <p className="muted small">
          A backup is a copy of LootDen's database: everyone's accounts, play time, journals, tags, shelves, achievements and settings. Artwork, save backups and the games themselves aren't in it. Backups are kept in the data folder under <code>backups</code>.
        </p>
        <div className="inline wrap">
          <label className="check">
            <input type="checkbox" checked={s.settings.daily} onChange={(e) => void run(() => api.backupSettings({ daily: e.target.checked }))} />
            Make one every day
          </label>
          <label className="inline">
            Keep the newest
            <input type="number" min={1} max={60} value={s.settings.keep} style={{ width: "5rem" }} onChange={(e) => void run(() => api.backupSettings({ keep: Number(e.target.value) }))} />
          </label>
          <button className="primary" disabled={busy} onClick={() => void run(() => api.makeBackup(), "Backup made.")}>
            Back up now
          </button>
          <button className="ghost" disabled={busy} onClick={() => file.current?.click()}>
            Upload a backup…
          </button>
          <input
            ref={file}
            type="file"
            accept=".db,application/octet-stream"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void run(() => api.uploadBackup(f), "Uploaded. Restore it from the list below.");
            }}
          />
        </div>
      </section>
      {s.pendingRestore && (
        <p className="notice">
          A restore is waiting. <strong>Restart LootDen</strong> (on Unraid, restart the container) to finish it; the current database is kept beside it as <code>.before-restore</code>.{" "}
          <button className="small ghost" onClick={() => void run(() => api.cancelRestore(), "Restore cancelled.")}>
            Cancel the restore
          </button>
        </p>
      )}
      <section className="panel">
        <h3>Backups</h3>
        {s.backups.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Made</th>
                <th className="num">Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.backups.map((b) => (
                <tr key={b.name}>
                  <td>
                    {new Date(b.createdAt).toLocaleString()} <small className="muted">{/-(daily|upload|manual)\.db$/.exec(b.name)?.[1]}</small>
                  </td>
                  <td className="num">{formatBytes(b.bytes)}</td>
                  <td className="inline">
                    <a className="button small" href={`/api/backups/${encodeURIComponent(b.name)}`} download>
                      Download
                    </a>
                    <button
                      className="small secondary"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`Restore the backup from ${new Date(b.createdAt).toLocaleString()}? Everything since then is replaced when LootDen restarts (a backup of now is made first).`))
                          void run(() => api.restoreBackup(b.name), "Restore staged. Restart LootDen to finish it.");
                      }}
                    >
                      Restore
                    </button>
                    <button className="small ghost" disabled={busy} onClick={() => void run(() => api.deleteBackup(b.name))}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
