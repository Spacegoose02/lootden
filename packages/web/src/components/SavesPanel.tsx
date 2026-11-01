import { useEffect, useRef, useState } from "react";
import { EMULATORS, platformFor, recompInfo, type GameDetail, type SaveBackup } from "@lootden/shared";
import { api, formatBytes } from "../api";
import { useAuth } from "../auth";
import { bridgeError, desktop, useDesktopGame } from "../desktop";

/** Save sync: your backups for this game, and where the game keeps its saves. */
export function SavesPanel({ game, onChange }: { game: GameDetail; onChange: (g: GameDetail) => void }) {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const { installed, progress } = useDesktopGame(game.id);
  const [saves, setSaves] = useState<SaveBackup[] | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const load = () => api.saves(game.id).then(setSaves, (e: Error) => setError(e.message));
  useEffect(() => {
    if (me?.user) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id, me?.user?.id]);
  // The desktop app backs up automatically when a game closes.
  useEffect(() => {
    if (progress?.type !== "saves") return;
    if (progress.error) setError(`Automatic backup failed: ${progress.error}`);
    else setMessage(`Backed up ${formatBytes(progress.size ?? 0)} of saves after playing.`);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress]);

  if (!me?.user) return null;

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const m = await fn();
      if (m) setMessage(m);
      await load();
    } catch (e) {
      setError(bridgeError(e));
    } finally {
      setBusy(false);
    }
  };

  const emulated = game.platform !== "pc";
  const emulator = emulated ? EMULATORS.find((e) => e.id === platformFor(game.platform).emulator) : undefined;
  const canSync = Boolean(desktop?.backupSaves && installed && game.savePath && !emulated);

  return (
    <section className="panel saves">
      <h2>Saves</h2>
      <p className="muted small">
        Your save backups follow you between computers. They're private to your profile; the server keeps your last 10 per game.
        {desktop ? " The app backs up automatically every time you close the game." : ""}
      </p>
      {emulated ? (
        <p className="small">
          {emulator?.saveSync
            ? `Saves and memory cards from ${emulator.name} sync on their own: newer ones come down before you play, and the ones that changed go up when you stop. Playing in the browser uses the same save.`
            : `${emulator?.name ?? "This emulator"} keeps saves on each PC for now.`}
        </p>
      ) : game.savePath ? (
        <p className="small">
          Save folder: <code>{game.savePath}</code>
        </p>
      ) : (
        <p className="muted small">{isAdmin ? "Set the save folder below to turn on sync for this game." : "An admin hasn't set where this game keeps its saves yet. You can still upload a zip."}</p>
      )}
      {error && <p className="error">{error}</p>}
      {message && <p className="notice">{message}</p>}
      <div className="inline">
        {canSync && (
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await desktop!.backupSaves!(game.id);
                if ("error" in r) throw new Error(r.error);
                return `Uploaded ${formatBytes(r.size)} of saves.`;
              })
            }
          >
            Back up now
          </button>
        )}
        <button disabled={busy} onClick={() => file.current?.click()}>
          Upload a zip
        </button>
        <input
          ref={file}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void run(async () => (await api.uploadSave(game.id, f), "Uploaded."));
          }}
        />
      </div>
      {saves?.length ? (
        <table className="table">
          <tbody>
            {saves.map((s) => (
              <tr key={s.id}>
                <td>{new Date(s.createdAt).toLocaleString()}</td>
                <td className="muted">
                  {s.device ?? ""}
                  {s.runner?.startsWith("recomp:") ? ` · ${recompInfo(s.runner.slice(7))?.name ?? "recomp"}` : ""}
                </td>
                <td className="num">{formatBytes(s.size)}</td>
                <td className="actions">
                  {canSync && desktop?.restoreSaves && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const r = await desktop!.restoreSaves!(game.id, s.id);
                          if (!r) return;
                          return r.previous ? `Restored. Your previous saves were kept in ${r.previous}` : "Restored.";
                        })
                      }
                    >
                      Restore
                    </button>
                  )}
                  <a className="button" href={`/api/games/${game.id}/saves/${s.id}`} download>
                    Download
                  </a>
                  <button className="danger" disabled={busy} onClick={() => confirm("Delete this backup?") && run(async () => void (await api.deleteSave(game.id, s.id)))}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : saves ? (
        <p className="muted small">No backups yet.</p>
      ) : null}
      {isAdmin && !emulated && <SavePathEditor game={game} onChange={onChange} />}
    </section>
  );
}

function SavePathEditor({ game, onChange }: { game: GameDetail; onChange: (g: GameDetail) => void }) {
  const [value, setValue] = useState(game.savePath ?? "");
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => setValue(game.savePath ?? ""), [game.savePath]);

  const save = (p: string | null) =>
    api.setSavePath(game.id, p).then(
      (g) => (onChange(g), setError("")),
      (e: Error) => setError(e.message),
    );

  return (
    <div className="save-path">
      <h3>Save folder (admin)</h3>
      <p className="muted small">
        Use <code>%APPDATA%</code>, <code>%LOCALAPPDATA%</code>, <code>%USERPROFILE%</code>, <code>%DOCUMENTS%</code> or <code>{"{game}"}</code> for the install folder.
        A <code>*</code> folder matches the newest one (handy for user ids).
      </p>
      <div className="inline">
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="%APPDATA%/Studio/Game/Saves" style={{ flex: 1, minWidth: 220 }} />
        <button onClick={() => save(value.trim() || null)}>Save</button>
        <button
          onClick={() =>
            api.suggestSavePath(game.id).then(
              (r) => setSuggestions(r.paths),
              (e: Error) => setError(e.message),
            )
          }
        >
          Look up on PCGamingWiki
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {suggestions && (
        <div className="inline">
          {suggestions.length ? (
            suggestions.map((s) => (
              <button key={s} className="chip" onClick={() => setValue(s)}>
                {s}
              </button>
            ))
          ) : (
            <span className="muted small">PCGamingWiki has no Windows save location for this game.</span>
          )}
        </div>
      )}
    </div>
  );
}
