import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatBytes } from "../api";
import { bridgeError, desktop, type AppSettings, type AppSettingsPatch, type AppUpdate } from "../desktop";
import { EveryGameScripts } from "./LaunchOptions";

/** Live state of the desktop app's own update (desktop app 0.9.1 and later). */
export function useAppUpdate(): [AppUpdate | null, (a: "check" | "install") => Promise<void>] {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  useEffect(() => {
    if (!desktop?.appUpdate) return;
    void desktop.appUpdate("status").then(setUpdate, () => {});
    return desktop.onProgress((p) => {
      if (p.type === "appUpdate") setUpdate(p);
    });
  }, []);
  const act = async (a: "check" | "install") => {
    if (desktop?.appUpdate) setUpdate(await desktop.appUpdate(a));
  };
  return [update, act];
}

function updateLine(u: AppUpdate): string {
  switch (u.state) {
    case "checking":
      return "Checking for a new version…";
    case "none":
      return "Up to date.";
    case "available":
      return `Version ${u.version} is available.`;
    case "downloading":
      return `Downloading ${u.version}${u.total ? `: ${formatBytes(u.received ?? 0)} of ${formatBytes(u.total)}` : "…"}`;
    case "ready":
      return `Version ${u.version} is ready. It installs when you quit, or now with Restart to update.`;
    case "error":
      return `Couldn't update: ${u.error ?? "unknown error"}`;
    case "unsupported":
      return "This copy (a .deb or a copy run from source) can't update itself; install new versions from the app downloads page (below).";
    default:
      return "";
  }
}

/** Tray, start-up, update and quit options for the desktop app, on the profile page. */
export function AppOptions() {
  const [opts, setOpts] = useState<AppSettings | null>(null);
  const [update, act] = useAppUpdate();
  const [error, setError] = useState("");
  const [discordId, setDiscordId] = useState("");
  useEffect(() => {
    if (desktop?.appSettings)
      void desktop.appSettings().then((o) => {
        setOpts(o);
        setDiscordId(o.discordClientId ?? "");
      }, () => {});
  }, []);
  if (!desktop) return null;
  const bridge = desktop;
  if (!bridge.appSettings || !bridge.quit) {
    return <p className="muted small">Update the LootDen app to choose tray, start-up and update options here.</p>;
  }
  const set = (patch: AppSettingsPatch) =>
    bridge.appSettings!(patch).then(setOpts, (e) => setError(bridgeError(e)));
  const run = (fn: () => Promise<unknown>) => fn().catch((e) => setError(bridgeError(e)));
  return (
    <div className="app-options">
      <h3>App</h3>
      {opts && (
        <div className="app-options-checks">
          {opts.trayAvailable && (
            <label className="check">
              <input type="checkbox" checked={opts.closeToTray} onChange={(e) => void set({ closeToTray: e.target.checked })} />
              Closing the window keeps LootDen running in the system tray, so play time and installs keep being tracked
            </label>
          )}
          {opts.loginItemSupported && (
            <label className="check">
              <input type="checkbox" checked={opts.openAtLogin} onChange={(e) => void set({ openAtLogin: e.target.checked })} />
              Start LootDen with the computer ({opts.handheldActive || opts.fullscreen ? "full screen" : "in the tray"})
            </label>
          )}
          {opts.loginItemSupported && opts.openAtLogin && opts.loginItemEnabled === false && (
            <p className="error small">
              Windows is set not to start LootDen. Turn it back on in Settings &gt; Apps &gt; Startup, or untick and tick the box above.
            </p>
          )}
          {opts.fullscreen !== undefined && (
            <label className="check">
              <input type="checkbox" checked={opts.fullscreen} onChange={(e) => void set({ fullscreen: e.target.checked })} />
              Always open full screen (F11 switches)
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={opts.autoUpdate} onChange={(e) => void set({ autoUpdate: e.target.checked })} />
            Install app updates automatically
          </label>
          {opts.handheld && (
            <label className="field">
              <span className="field-label">Handheld mode</span>
              <select value={opts.handheld} onChange={(e) => void set({ handheld: e.target.value as "auto" | "on" | "off" })}>
                <option value="auto">Automatic{opts.looksHandheld ? " (on for this PC)" : " (off for this PC)"}</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
              <small className="muted">
                Full screen with larger text and buttons, for the ROG Ally, Steam Deck and other handhelds or a TV. Starting with the computer opens LootDen in front instead of in the tray.
              </small>
            </label>
          )}
          {opts.browserLinks && (
            <label className="field">
              <span className="field-label">Open links in</span>
              <select value={opts.browserLinks} onChange={(e) => void set({ browserLinks: e.target.value as "auto" | "on" | "off" })}>
                <option value="auto">LootDen's browser in handheld mode, otherwise your usual browser</option>
                <option value="on">LootDen's browser</option>
                <option value="off">Your usual browser</option>
              </select>
              <small className="muted">Links in news, game pages and trailers. LootDen's browser works with a controller and stays in full screen.</small>
            </label>
          )}
          {opts.splash && (
            <label className="field">
              <span className="field-label">Launch splash</span>
              <select value={opts.splash} onChange={(e) => void set({ splash: e.target.value as "off" | "handheld" | "on" })}>
                <option value="off">Off</option>
                <option value="handheld">In handheld mode</option>
                <option value="on">Always</option>
              </select>
              <small className="muted">Shows the game's picture full screen while it loads, instead of the desktop.</small>
            </label>
          )}
          {opts.suspendKey !== undefined && (
            <label className="check">
              <input type="checkbox" checked={opts.suspendKey} onChange={(e) => void set({ suspendKey: e.target.checked })} />
              Ctrl+Shift+P pauses and resumes the game that's running (a Pause button also shows on its page). Paused time doesn't count as play time. Online games may disconnect while paused.
            </label>
          )}
          {opts.storeSaves !== undefined && (
            <label className="check">
              <input type="checkbox" checked={opts.storeSaves} onChange={(e) => void set({ storeSaves: e.target.checked })} />
              Back up other stores' games' saves after playing (found through Ludusavi's list of save locations)
            </label>
          )}
          {opts.discordEnabled !== undefined && (
            <div className="field">
              <label className="check">
                <input type="checkbox" checked={opts.discordEnabled} onChange={(e) => void set({ discordEnabled: e.target.checked })} />
                Show what I'm playing on Discord
              </label>
              {opts.discordEnabled && (
                <div className="inline wrap">
                  <input value={discordId} onChange={(e) => setDiscordId(e.target.value)} placeholder="Discord application ID" aria-label="Discord application ID" inputMode="numeric" />
                  <button className="small" onClick={() => void set({ discordClientId: discordId })}>
                    Save
                  </button>
                </div>
              )}
              {opts.discordEnabled && (
                <small className="muted">
                  Needs the Discord app on this PC. Make a free application named LootDen at discord.com/developers/applications (its name is what Discord shows), copy its Application ID here, and optionally add an art asset called <code>lootden</code> for the picture.
                </small>
              )}
            </div>
          )}
        </div>
      )}
      {desktop.setLaunchScripts && <EveryGameScripts />}
      <div className="inline app-update">
        <span>
          Version {update?.current ?? "?"}
          {update && updateLine(update) ? <span className={update.state === "error" ? "error" : "muted"}> · {updateLine(update)}</span> : null}
        </span>
        {update?.state === "ready" ? (
          <button className="primary small" onClick={() => void run(() => act("install"))}>
            Restart to update
          </button>
        ) : (
          update?.state !== "unsupported" && (
            <button className="small" disabled={update?.state === "checking" || update?.state === "downloading"} onClick={() => void run(() => act("check"))}>
              Check for updates
            </button>
          )
        )}
      </div>
      <p className="muted small">
        <Link to="/apps">Playnite extension and app downloads</Link> for your other PCs.
      </p>
      <div className="inline">
        <button className="danger" onClick={() => void run(() => bridge.quit!())}>
          Exit LootDen
        </button>
        <span className="muted small">Closes the app completely. Play time isn't tracked until you open it again.</span>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** A slim bar across the app when a new version has downloaded. */
export function AppUpdateBanner() {
  const [update, act] = useAppUpdate();
  const [hidden, setHidden] = useState(false);
  if (!update || update.state !== "ready" || hidden) return null;
  return (
    <div className="app-update-banner" role="status">
      <span>LootDen {update.version} is ready to install.</span>
      <button className="primary small" onClick={() => void act("install")}>
        Restart to update
      </button>
      <button className="ghost small" onClick={() => setHidden(true)}>
        Later
      </button>
    </div>
  );
}
