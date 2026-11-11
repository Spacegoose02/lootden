import { useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { formatBytes } from "../api";
import { androidApp, bridgeError, desktop, type DeviceApp } from "../desktop";

type Tab = "games" | "apps";

/**
 * The Android app's On this handheld: the Android games and apps installed on the device, to
 * start from LootDen. Games are what Android files under Games; anything can be moved between
 * the two, as some games don't say they're games.
 */
export function DeviceApps() {
  const [apps, setApps] = useState<DeviceApp[] | null>(null);
  const [tab, setTab] = useState<Tab>("games");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = () => void desktop?.deviceApps?.().then(setApps, (e) => setError(bridgeError(e)));
  useEffect(() => {
    load();
    // Back from Android's installer, uninstaller or app settings: the list may have changed.
    const again = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, []);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (apps ?? []).filter((a) => a.game === (tab === "games") && (!q || a.label.toLowerCase().includes(q) || a.package.includes(q)));
  }, [apps, tab, search]);

  if (!androidApp || !desktop?.deviceApps) return <Navigate to="/library" replace />;
  const bridge = desktop;
  const counts = { games: apps?.filter((a) => a.game).length ?? 0, apps: apps?.filter((a) => !a.game).length ?? 0 };

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(bridgeError(e));
    }
  };
  const move = (a: DeviceApp, kind: "game" | "app") =>
    act(async () => {
      // Back to Android's own sorting when that's where it's going anyway.
      const next = (kind === "game") === a.detectedGame ? null : kind;
      setApps(await bridge.setDeviceAppKind!(a.package, next));
      setOpen(null);
    });

  return (
    <div className="device-apps">
      <h1>On this handheld</h1>
      <p className="muted">
        Android games and apps installed on this handheld. Android games on your LootDen server are under{" "}
        <Link to="/emulation/android">Emulation, Android</Link>: installing one there puts it here too.
      </p>
      <div className="inline device-apps-bar">
        <nav className="system-tabs" aria-label="Games or apps">
          <a href="#games" className={tab === "games" ? "active" : ""} onClick={(e) => (e.preventDefault(), setTab("games"))}>
            Games <span className="muted">{counts.games}</span>
          </a>
          <a href="#apps" className={tab === "apps" ? "active" : ""} onClick={(e) => (e.preventDefault(), setTab("apps"))}>
            Apps <span className="muted">{counts.apps}</span>
          </a>
        </nav>
        <input type="search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search games and apps" />
      </div>
      {error && <p className="error">{error}</p>}
      {!apps ? (
        <p className="muted">Looking at what's installed…</p>
      ) : shown.length === 0 ? (
        <p className="panel muted">
          {search
            ? "Nothing matches."
            : tab === "games"
              ? "No games found. Some games don't tell Android they're games: find them under Apps and choose Move to Games."
              : "No other apps."}
        </p>
      ) : (
        <div className="device-app-grid">
          {shown.map((a) => (
            <div key={a.package} className="device-app">
              <button className="device-app-main" onClick={() => void act(() => bridge.launchApp!(a.package))} title={`Open ${a.label}`}>
                {a.icon ? <img src={a.icon} alt="" width={64} height={64} /> : <span className="device-app-noicon">{a.label.slice(0, 1)}</span>}
                <span className="device-app-label">{a.label}</span>
              </button>
              <button className="ghost small device-app-more" aria-label={`More for ${a.label}`} aria-expanded={open === a.package} onClick={() => setOpen(open === a.package ? null : a.package)}>
                ⋯
              </button>
              {open === a.package && (
                <div className="device-app-menu">
                  <p className="muted small">
                    {[a.version && `Version ${a.version}`, a.sizeBytes > 0 && formatBytes(a.sizeBytes), a.system && "Came with the handheld"].filter(Boolean).join(" · ")}
                  </p>
                  {a.gameId && (
                    <Link className="button small secondary" to={`/games/${a.gameId}`}>
                      In LootDen
                    </Link>
                  )}
                  <button className="small secondary" onClick={() => void move(a, a.game ? "app" : "game")}>
                    {a.game ? "Move to Apps" : "Move to Games"}
                  </button>
                  <button className="small ghost" onClick={() => void act(() => bridge.appDetails!(a.package))}>
                    App info
                  </button>
                  {!a.system && bridge.uninstallApp && (
                    <button className="small ghost" onClick={() => void act(() => bridge.uninstallApp!(a.package))}>
                      Uninstall
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
