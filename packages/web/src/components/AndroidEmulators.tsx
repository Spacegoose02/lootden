import { useCallback, useEffect, useState } from "react";
import { androidApp, biosPullMessage, bridgeError, desktop, type AndroidEmulatorChoice } from "../desktop";

type Option = AndroidEmulatorChoice["options"][number];

/**
 * The Android app's This handheld: which emulators are on the handheld, and which one plays each
 * system. LootDen picks the best one installed (standalone emulators first where they play
 * better, then RetroArch), or Android's Open with… when there's none; a pick here overrides that.
 */
export function AndroidEmulators() {
  const [list, setList] = useState<AndroidEmulatorChoice[] | null>(null);
  const [error, setError] = useState("");
  const [bios, setBios] = useState("");
  const [gettingBios, setGettingBios] = useState(false);
  const load = useCallback(() => {
    if (androidApp) void desktop?.androidEmulators?.().then(setList, (e) => setError(bridgeError(e)));
  }, []);
  useEffect(() => {
    load();
    // Back from installing an emulator in Google Play: look again.
    const again = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [load]);
  if (!androidApp || !list) return null;
  const pick = (platform: string, id: string) =>
    void desktop!.setAndroidEmulator!(platform, id || null).then(setList, (e) => setError(bridgeError(e)));
  const all = [...new Map(list.flatMap((p) => p.options).map((o) => [o.id, o])).values()];
  const installed = all.filter((o) => o.installed);
  const missing = all.filter((o) => !o.installed && o.store);

  return (
    <div className="store-scan android-emulators">
      <h3>🎮 Emulators on this handheld</h3>
      <p className="muted small">
        Console games install to a ROMs folder and start in the emulator picked here. RetroArch saves follow you to your PCs and the browser player; other emulators keep theirs on this
        handheld.
      </p>

      <h4>Installed here</h4>
      {installed.length ? (
        <div className="badges">
          {installed.map((o) => (
            <span key={o.id} className="badge badge-installed" title={o.package ?? undefined}>
              ✓ {o.name}
              {o.version ? <span className="muted"> {o.version}</span> : null}
            </span>
          ))}
        </div>
      ) : (
        <p className="small">None of the emulators LootDen knows are installed yet. Get one below, then come back here.</p>
      )}
      {missing.length > 0 && (
        <>
          <h4>Not installed</h4>
          <div className="badges">
            {missing.map((o) => (
              <button key={o.id} className="button small ghost" onClick={() => void desktop?.openStore?.(o.store!)} title="Opens Google Play">
                ⬇ Get {o.name}
              </button>
            ))}
          </div>
        </>
      )}

      <h4>Each system</h4>
      <ul className="list">
        {list.map((p) => (
          <li key={p.platform}>
            <span>
              <strong>{p.name}</strong>
              <br />
              <small className="muted">
                {p.using ? `Plays in ${p.using}${p.core ? ` (${p.core} core)` : ""}` : "No emulator installed: Android asks which app to use"}
              </small>
              <span className="badges badges-compact">
                {p.options.map((o) => (
                  <OptionBadge key={o.id} option={o} />
                ))}
              </span>
            </span>
            <select value={p.picked ?? ""} onChange={(e) => pick(p.platform, e.target.value)} aria-label={`Emulator for ${p.name}`}>
              <option value="">Best installed</option>
              {p.options.map((o) => (
                <option key={o.id} value={o.id} disabled={!o.installed}>
                  {o.installed ? `✓ ${o.name}` : `${o.name} (not installed)`}
                </option>
              ))}
              <option value="ask">Ask each time</option>
            </select>
          </li>
        ))}
      </ul>
      <p className="small">
        <button className="button small ghost" onClick={load}>
          ↻ Check again
        </button>
        {desktop?.biosFromServer && (
          <button
            className="button small ghost"
            disabled={gettingBios}
            onClick={() => {
              setGettingBios(true);
              setBios("");
              desktop!.biosFromServer!().then(
                (r) => setBios(biosPullMessage(r)),
                (e) => setError(bridgeError(e)),
              ).finally(() => setGettingBios(false));
            }}
          >
            {gettingBios ? "Getting BIOS files…" : "⬇ Get BIOS files from the server"}
          </button>
        )}
      </p>
      {bios && <p className="notice small">{bios}</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function OptionBadge({ option: o }: { option: Option }) {
  return o.installed ? <span className="badge badge-installed">✓ {o.name}</span> : <span className="badge badge-muted">{o.name}: not installed</span>;
}
