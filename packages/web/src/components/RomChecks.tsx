import { useEffect, useRef, useState } from "react";
import type { RomCheck, RomCheckProgress, RomDat } from "@lootden/shared";
import { api } from "../api";

const LABELS: Record<RomCheck["status"], string> = {
  verified: "✔ Verified dump",
  partial: "Partly verified",
  unknown: "Not in the DATs",
  unchecked: "Can't check (packed)",
};

/** The game page's No-Intro/Redump badge for an emulated game; admins can check it again. */
export function RomBadge({ gameId, isAdmin }: { gameId: string; isAdmin: boolean }) {
  const [check, setCheck] = useState<RomCheck | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setCheck(null);
    api.romCheck(gameId).then(setCheck, () => setCheck(null));
  }, [gameId]);
  if (!check && !isAdmin) return null;
  const title = check
    ? [
        check.matched ? `${check.matched}${check.dat ? ` in ${check.dat}` : ""}` : "No file matched a No-Intro or Redump DAT. It could be a hack, a patched or bad dump, or a system with no DAT uploaded.",
        ...check.files.map((f) => `${f.match ? "✔" : "✘"} ${f.path}`),
        `Checked ${new Date(check.checkedAt).toLocaleString()}`,
      ].join("\n")
    : "Check this game's files against the uploaded No-Intro and Redump DATs";
  return (
    <p className="compat-badges">
      {check && (
        <span className={`badge rom-${check.status}`} title={title}>
          {LABELS[check.status]}
        </span>
      )}
      {isAdmin && (
        <button
          className="ghost small"
          disabled={busy}
          title={title}
          onClick={() => {
            setBusy(true);
            api
              .checkRom(gameId)
              .then(setCheck, (e: Error) => alert(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Checking…" : check ? "Check again" : "Check ROM"}
        </button>
      )}
    </p>
  );
}

/** Emulators and BIOS page (admins): No-Intro and Redump DATs, and checking every game against them. */
export function RomDats() {
  const file = useRef<HTMLInputElement>(null);
  const [dats, setDats] = useState<RomDat[]>([]);
  const [progress, setProgress] = useState<RomCheckProgress | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    api.romDats().then((r) => {
      setDats(r.dats);
      setProgress(r.progress);
    });
  useEffect(() => void load().catch(() => {}), []);
  // Follow a running check.
  useEffect(() => {
    if (!progress?.running) return;
    const t = setTimeout(() => void load(), 2000);
    return () => clearTimeout(t);
  }, [progress]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <h2>ROM checks</h2>
      <p className="muted small">
        Upload the{" "}
        <a href="https://datomatic.no-intro.org/index.php?page=download" target="_blank" rel="noreferrer">
          No-Intro
        </a>{" "}
        (cartridges) and{" "}
        <a href="http://redump.org/downloads/" target="_blank" rel="noreferrer">
          Redump
        </a>{" "}
        (discs) .dat files for your systems, and LootDen checks every console game against them, like RomVault does. A match means a known good,
        unmodified dump. Zipped ROMs are checked without unpacking; 7z, CHD and RVZ files can't be. New games are checked after each scan.
      </p>
      <div className="inline wrap">
        <button className="primary" disabled={busy} onClick={() => file.current?.click()}>
          Upload DAT files
        </button>
        <button className="secondary" disabled={busy || !dats.length || progress?.running} onClick={() => void act(() => api.checkAllRoms().then(setProgress))}>
          Check all games
        </button>
        {progress?.running && (
          <span className="muted small">
            Checking {progress.done + 1} of {progress.total}
            {progress.current ? `: ${progress.current}` : ""}…
          </span>
        )}
        <input
          ref={file}
          type="file"
          accept=".dat,.xml"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            void act(async () => {
              for (const f of files) await api.uploadDat(f);
            });
          }}
        />
      </div>
      {error && <p className="error">{error}</p>}
      {dats.length > 0 && (
        <table className="table">
          <tbody>
            {dats.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td className="muted small">{d.version ?? ""}</td>
                <td className="num">{d.games.toLocaleString()} games</td>
                <td className="actions">
                  <button className="danger" disabled={busy} onClick={() => confirm(`Remove ${d.name}?`) && act(() => api.deleteDat(d.id))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
