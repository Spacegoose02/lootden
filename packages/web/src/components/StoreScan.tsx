import { useEffect, useState } from "react";
import { bridgeError, desktop, type StoreScanSettings } from "../desktop";
import { Toggle } from "./SettingsUi";

/**
 * Profile, This computer: where this PC looks for other stores' games. Kept by the app on this
 * PC only, as each computer has its own drives and launchers.
 */
export function StoreScan() {
  const [scan, setScan] = useState<StoreScanSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    desktop?.storeScan?.().then(setScan, (e) => setError(bridgeError(e)));
  }, []);
  if (!desktop?.storeScan || !scan) return error ? <p className="error">{error}</p> : null;
  const save = (patch: { disabled?: string[]; folders?: string[] }) => desktop!.storeScan!(patch).then(setScan, (e) => setError(bridgeError(e)));
  const disabled = scan.stores.filter((s) => !s.enabled).map((s) => s.id);

  return (
    <div className="store-scan">
      <h3>Games from other stores on this PC</h3>
      <p className="muted small">LootDen looks in these launchers for installed games, so they get ▶ Play under Library, Other stores. These settings are for this PC only.</p>
      {error && <p className="error">{error}</p>}
      {scan.stores.map((s) => (
        <Toggle key={s.id} label={s.name} checked={s.enabled} onChange={(on) => void save({ disabled: on ? disabled.filter((d) => d !== s.id) : [...disabled, s.id] })} />
      ))}
      <h4>Also look in these folders</h4>
      <p className="muted small">For game libraries the launchers don't list, such as a Steam library or GOG, Epic or Xbox games on another drive.</p>
      <ul className="list">
        {scan.folders.map((f) => (
          <li key={f}>
            <code>{f}</code>
            <button className="ghost small" onClick={() => void save({ folders: scan.folders.filter((x) => x !== f) })}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {scan.folders.length === 0 && <p className="muted small">No folders added.</p>}
      <button className="secondary" onClick={() => desktop!.addStoreFolder!().then(setScan, (e) => setError(bridgeError(e)))}>
        Add a folder
      </button>
    </div>
  );
}
