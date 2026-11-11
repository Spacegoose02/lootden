import { useEffect, useState } from "react";
import { androidApp, bridgeError, desktop, type AndroidEmulatorChoice } from "../desktop";

/**
 * The Android app's This handheld: which emulator plays each system. LootDen picks the best one
 * installed (standalone emulators first where they play better, then RetroArch), or Android's
 * Open with… when there's none; a pick here overrides that.
 */
export function AndroidEmulators() {
  const [list, setList] = useState<AndroidEmulatorChoice[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (androidApp) void desktop?.androidEmulators?.().then(setList, (e) => setError(bridgeError(e)));
  }, []);
  if (!androidApp || !list) return null;
  const pick = (platform: string, id: string) =>
    void desktop!.setAndroidEmulator!(platform, id || null).then(setList, (e) => setError(bridgeError(e)));
  const missing = [...new Map(list.flatMap((p) => p.options).filter((o) => !o.installed && o.store).map((o) => [o.id, o])).values()];

  return (
    <div className="store-scan">
      <h3>🎮 Emulators on this handheld</h3>
      <p className="muted small">
        Console games install to a ROMs folder and start in the emulator picked here. RetroArch saves follow you to your PCs and the browser player; other emulators keep theirs on this
        handheld.
      </p>
      <ul className="list">
        {list.map((p) => (
          <li key={p.platform}>
            <span>
              <strong>{p.name}</strong>
              <br />
              <small className="muted">
                {p.using ? `Plays in ${p.using}${p.core ? ` (${p.core} core)` : ""}` : "No emulator installed: Android asks which app to use"}
              </small>
            </span>
            <select value={p.picked ?? ""} onChange={(e) => pick(p.platform, e.target.value)} aria-label={`Emulator for ${p.name}`}>
              <option value="">Best installed</option>
              {p.options.map((o) => (
                <option key={o.id} value={o.id} disabled={!o.installed}>
                  {o.name}
                  {o.installed ? "" : " (not installed)"}
                </option>
              ))}
              <option value="ask">Ask each time</option>
            </select>
          </li>
        ))}
      </ul>
      {missing.length > 0 && (
        <p className="small">
          Get:{" "}
          {missing.map((o) => (
            <button key={o.id} className="button small ghost" onClick={() => void desktop?.openStore?.(o.store!)}>
              {o.name}
            </button>
          ))}
        </p>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
