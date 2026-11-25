import { useEffect, useState } from "react";
import { XBOX_CONSOLE_ADDON, xboxRemotePlayUrl } from "@lootden/shared";
import { bridgeError, desktop, type GreenlightState } from "../desktop";

/** Whether a store game plays by streaming it from the person's own Xbox console. */
export const isRemotePlayGame = (addon: string) => addon === XBOX_CONSOLE_ADDON;

/** The console id out of a Play remotely link (xbox.com/play/consoles/launch/<id>), when it has one. */
export function consoleIdOf(launchUrl: string | null | undefined): string | null {
  const m = /\/play\/consoles\/launch\/([A-F0-9]{16})/i.exec(launchUrl ?? "");
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * Starts remote play: in the desktop app the built-in browser opens Xbox's page full screen (or
 * Greenlight, when that's picked); in a web browser it's a new tab. The stream shows whatever
 * the console is on, and the game starts from the console's own home.
 */
export async function startRemotePlay(launchUrl: string | null | undefined, app: "browser" | "greenlight" = "browser"): Promise<void> {
  const consoleId = consoleIdOf(launchUrl);
  if (desktop?.remotePlay) {
    await desktop.remotePlay({ consoleId, app });
    return;
  }
  window.open(launchUrl || xboxRemotePlayUrl(consoleId), "_blank", "noreferrer");
}

/** Play remotely, with Greenlight beside it when it's set up on this PC. */
export function RemotePlayButtons({ launchUrl, small, onError }: { launchUrl: string | null | undefined; small?: boolean; onError?: (message: string) => void }) {
  const [green, setGreen] = useState<GreenlightState | null>(null);
  useEffect(() => void desktop?.greenlight?.().then(setGreen, () => {}), []);
  const size = small ? "small " : "";
  const go = (app: "browser" | "greenlight") => () => startRemotePlay(launchUrl, app).catch((e) => onError?.(bridgeError(e)));
  return (
    <>
      <button className={`${size}primary`} onClick={go("browser")} title="Streams your Xbox in LootDen's browser, full screen. Start the game on the console's home, as if you were sitting at it.">
        ▶ Play remotely
      </button>
      {green?.exe && (
        <button className={`${size}secondary`} onClick={go("greenlight")} title="Streams your Xbox in Greenlight instead">
          Greenlight
        </button>
      )}
    </>
  );
}

/** Profile, This computer: Greenlight, the other way to stream your own Xbox. */
export function GreenlightSetup() {
  const [s, setS] = useState<GreenlightState | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void desktop?.greenlight?.().then(setS, () => {}), []);
  if (!desktop?.greenlight || !s) return null;

  const run = async (fn: () => Promise<GreenlightState>, done: (s: GreenlightState) => string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      setS(r);
      setMsg({ text: done(r) });
    } catch (e) {
      setMsg({ text: bridgeError(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="store-scan">
      <h3>🎮 Xbox remote play</h3>
      <p className="muted small">
        Play the games on your own Xbox on this PC. <strong>Play remotely</strong> on an Xbox console game streams it on Xbox's own page in LootDen's browser, full screen, with zoom and stretch for
        wide screens. <strong>Greenlight</strong> is an open-source Xbox streaming app LootDen can set up here as a second option. Either way the console streams 16:9, so filling an ultrawide screen
        means cropping or widening the picture.
      </p>
      {!s.supported ? (
        <p className="muted small">LootDen doesn't download Greenlight on this system yet. Remote play in the browser works here.</p>
      ) : s.exe ? (
        <p className="small">
          ✅ Greenlight {s.version ? `${s.version} ` : ""}
          {s.managed ? "is set up here" : "found on this PC"}
          {s.managed && (
            <>
              {" · "}
              <button
                className="button small"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => desktop!.installGreenlight!(),
                    (r) => `Greenlight ${r.version ?? ""} is up to date`,
                  )
                }
              >
                Check for updates
              </button>{" "}
              <button
                className="button small ghost"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => desktop!.removeGreenlight!(),
                    () => "Greenlight was removed from this PC",
                  )
                }
              >
                Remove
              </button>
            </>
          )}
        </p>
      ) : (
        <p className="small">
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              void run(
                () => desktop!.installGreenlight!(),
                (r) => `Greenlight ${r.version ?? ""} is ready`,
              )
            }
          >
            {busy ? "Setting up Greenlight…" : "Set up Greenlight"}
          </button>{" "}
          <span className="muted">Downloaded from the project's own releases into LootDen's tools folder.</span>
        </p>
      )}
      {msg && <p className={msg.error ? "error small" : "notice small"}>{msg.text}</p>}
    </div>
  );
}
