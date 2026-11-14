import { useEffect, useRef, useState } from "react";
import type { GameLicence } from "@lootden/shared";
import { api } from "../api";

/**
 * A PS3 game's licence files (.rap). Admins upload them once; every PC's RPCS3 and every
 * handheld's ARMSX3 gets them when the game is installed, so PSN games start without copying keys.
 */
export function LicencesPanel({ gameId, isAdmin }: { gameId: string; isAdmin: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  const [licences, setLicences] = useState<GameLicence[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => api.licences(gameId).then(setLicences, () => setLicences([]));
  useEffect(() => {
    setLicences(null);
    void load();
  }, [gameId]);
  if (!licences || (!licences.length && !isAdmin)) return null;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await load();
    }
  };
  return (
    <section className="panel">
      <h2>Licences</h2>
      <p className="muted small">
        {isAdmin
          ? "PSN games need their .rap licence to start. Upload it here once: it goes into RPCS3 on every PC and into ARMSX3 on every handheld when the game is installed or played. Name it after the content id it unlocks (UP0001-BLUS30001_00-….rap); a game that's one .pkg works it out from the package."
          : "This game's licence goes to your emulator by itself when you install or play it."}
      </p>
      {isAdmin && (
        <div className="inline">
          <button className="primary" disabled={busy} onClick={() => file.current?.click()}>
            Upload .rap files
          </button>
          <input
            ref={file}
            type="file"
            accept=".rap"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              void act(async () => {
                for (const f of files) await api.uploadLicence(gameId, f);
              });
            }}
          />
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {licences.length > 0 && (
        <table className="table">
          <tbody>
            {licences.map((l) => (
              <tr key={l.name}>
                <td>{l.contentId}</td>
                <td className="muted small">Added {new Date(l.uploadedAt).toLocaleDateString()}</td>
                {isAdmin && (
                  <td className="actions">
                    <button className="danger" disabled={busy} onClick={() => confirm(`Delete the licence ${l.name}?`) && act(() => api.deleteLicence(gameId, l.name))}>
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
