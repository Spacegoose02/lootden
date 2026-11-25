import { useEffect, useState } from "react";
import { XBOX_CONSOLE_ADDON, xboxRemotePlayUrl, type LocalStoreGame } from "@lootden/shared";
import { bridgeError, desktop, type GreenlightState, type RemotePlayApp, type XboxConsoleInfo, type XboxRemoteStatus } from "../desktop";

/** Whether a store game plays by streaming it from the person's own Xbox console. */
export const isRemotePlayGame = (addon: string) => addon === XBOX_CONSOLE_ADDON;

/** The console id out of a Play remotely link (xbox.com/play/consoles/launch/<id>), when it has one. */
export function consoleIdOf(launchUrl: string | null | undefined): string | null {
  const m = /\/play\/consoles\/launch\/([A-F0-9]{16})/i.exec(launchUrl ?? "");
  return m ? m[1]!.toUpperCase() : null;
}

/** The game's Microsoft Store id, which LootDen's own player starts on the console first (#product=<id> on links it makes). */
export function productIdOf(launchUrl: string | null | undefined): string | null {
  const m = /#product=([A-Z0-9]{8,16})\b/i.exec(launchUrl ?? "");
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * Starts remote play. In the desktop app, LootDen's own player when a Microsoft account is signed
 * in there (it starts the game on the console first when it knows which), else Xbox's page in
 * the built-in browser, or Greenlight when asked for. In a web browser it's a new tab.
 */
export async function startRemotePlay(launchUrl: string | null | undefined, app?: RemotePlayApp, title?: string): Promise<void> {
  const consoleId = consoleIdOf(launchUrl);
  if (desktop?.remotePlay) {
    await desktop.remotePlay({ consoleId, app, productId: productIdOf(launchUrl), title: title ?? null });
    return;
  }
  window.open((launchUrl ?? "").replace(/#.*$/, "") || xboxRemotePlayUrl(consoleId), "_blank", "noreferrer");
}

/** This PC's Xbox sign-in, kept fresh when it changes (the sign-in finishing in the background). */
export function useXboxStatus(): [XboxRemoteStatus | null, (s: XboxRemoteStatus) => void] {
  const [s, setS] = useState<XboxRemoteStatus | null>(null);
  useEffect(() => {
    if (!desktop?.xbox) return;
    desktop.xbox.status().then(setS, () => {});
    return desktop.onProgress((p) => {
      if (p.type === "xbox") setS(p.status);
    });
  }, []);
  return [s, setS];
}

/** Play remotely, with Xbox's page and Greenlight beside it when they're there. */
export function RemotePlayButtons({ launchUrl, title, small, onError }: { launchUrl: string | null | undefined; title?: string; small?: boolean; onError?: (message: string) => void }) {
  const [green, setGreen] = useState<GreenlightState | null>(null);
  const [xbox] = useXboxStatus();
  useEffect(() => void desktop?.greenlight?.().then(setGreen, () => {}), []);
  const size = small ? "small " : "";
  const go = (app?: RemotePlayApp) => () => startRemotePlay(launchUrl, app, title).catch((e) => onError?.(bridgeError(e)));
  const own = !!xbox?.signedIn;
  return (
    <>
      <button
        className={`${size}primary`}
        onClick={go()}
        title={
          own
            ? "Streams your Xbox in LootDen, full screen, starting this game on it"
            : "Streams your Xbox in LootDen's browser, full screen. Sign in under Profile, This computer, Xbox remote play for LootDen's own player"
        }
      >
        ▶ Play remotely
      </button>
      {!small && own && (
        <button className={`${size}ghost`} onClick={go("browser")} title="Xbox's own remote play page instead">
          Xbox page
        </button>
      )}
      {green?.exe && (
        <button className={`${size}secondary`} onClick={go("greenlight")} title="Streams your Xbox in Greenlight instead">
          Greenlight
        </button>
      )}
    </>
  );
}

const POWER: Record<string, string> = { On: "On", ConnectedStandby: "Asleep", Off: "Off" };

/**
 * The games installed on the default console, as "this PC" store games, so they show in the
 * library with Play remotely (and match the Xbox console add-on's games by title id).
 */
export async function consoleStoreGames(): Promise<LocalStoreGame[]> {
  const x = desktop?.xbox;
  if (!x) return [];
  const status = await x.status();
  if (!status.signedIn) return [];
  const consoles = await x.consoles();
  const target = consoles.find((c) => c.id === status.defaultConsole) ?? consoles.find((c) => c.streamingEnabled) ?? consoles[0];
  if (!target) return [];
  const games = await x.installed(target.id);
  return games.map((g) => ({
    addon: XBOX_CONSOLE_ADDON,
    store: "Xbox console",
    externalId: g.titleId,
    title: g.name,
    installDir: "",
    launchUrl: `${xboxRemotePlayUrl(target.id)}${g.productId ? `#product=${g.productId}` : ""}`,
  }));
}

/** Profile, This computer: LootDen's own Xbox remote play (sign-in, consoles, fit), with Greenlight below. */
export function XboxRemoteSetup() {
  const [s, setS] = useXboxStatus();
  const [consoles, setConsoles] = useState<XboxConsoleInfo[] | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const x = desktop?.xbox;
  const signedIn = !!s?.signedIn;

  useEffect(() => {
    if (!x || !signedIn) return setConsoles(null);
    x.consoles().then(setConsoles, (e) => setMsg({ text: bridgeError(e), error: true }));
  }, [x, signedIn]);

  // Apps from before 0.44 only have Greenlight.
  if (!x) return <GreenlightSetup />;
  if (!s) return null;

  const run = async <T,>(fn: () => Promise<T>, done?: (r: T) => string | null) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      const text = done?.(r);
      if (text) setMsg({ text });
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
        Play the games on your own Xbox on this PC, in LootDen's own player: full screen, your controller, and fit, zoom or stretch for a wide screen. Sign in once with the Microsoft account your
        Xbox uses. On the console, turn on <strong>Settings, Devices &amp; connections, Remote features</strong> and use sleep mode, so LootDen can wake it.
      </p>
      {!s.signedIn && !s.pending && (
        <p>
          <button className="button primary" disabled={busy} onClick={() => void run(() => x.signIn().then(setS))}>
            Sign in with Microsoft
          </button>
        </p>
      )}
      {s.pending && (
        <div className="notice">
          <p>
            On any device, go to <strong>{s.pending.verificationUri.replace(/^https:\/\//, "")}</strong> and enter this code:
          </p>
          <p style={{ fontSize: "2em", fontWeight: 700, letterSpacing: "0.12em", margin: "0.3em 0" }}>{s.pending.userCode}</p>
          <p className="small">
            <button className="button small" onClick={() => void x.openSignInPage()}>
              Open the page here
            </button>{" "}
            <button className="button small ghost" onClick={() => void x.cancelSignIn().then(setS)}>
              Cancel
            </button>{" "}
            <span className="muted">LootDen notices by itself once you've signed in.</span>
          </p>
        </div>
      )}
      {s.error && <p className="error small">{s.error}</p>}
      {s.signedIn && (
        <>
          <p className="small">
            ✅ Signed in{s.gamertag ? ` as ${s.gamertag}` : ""} ·{" "}
            <button className="button small ghost" disabled={busy} onClick={() => void run(() => x.signOut().then(setS))}>
              Sign out
            </button>
          </p>
          {consoles && consoles.length === 0 && <p className="muted small">No consoles on this account yet. Sign in on your Xbox with the same Microsoft account.</p>}
          {consoles && consoles.length > 0 && (
            <ul className="xbox-consoles">
              {consoles.map((c) => (
                <li key={c.id} className="inline wrap">
                  <strong>{c.name}</strong>
                  <span className="muted small">
                    {POWER[c.powerState] ?? c.powerState}
                    {!c.streamingEnabled ? " · remote play is off on this console" : ""}
                  </span>
                  <button className="button small primary" disabled={busy || !c.streamingEnabled} onClick={() => void run(() => x.play({ consoleId: c.id }))}>
                    ▶ Stream
                  </button>
                  {c.powerState !== "On" && (
                    <button className="button small" disabled={busy} onClick={() => void run(() => x.wake(c.id), () => `Waking ${c.name}`)}>
                      Wake
                    </button>
                  )}
                  {consoles.length > 1 &&
                    (s.defaultConsole === c.id ? (
                      <span className="badge">Default</span>
                    ) : (
                      <button className="button small ghost" disabled={busy} onClick={() => void run(() => x.setDefault(c.id).then(setS))}>
                        Make default
                      </button>
                    ))}
                </li>
              ))}
            </ul>
          )}
          <label className="small">
            Wide screens:{" "}
            <select value={s.fit} onChange={(e) => void run(() => x.setFit(e.target.value).then(setS))}>
              <option value="fit">Fit (16:9, bars at the sides)</option>
              <option value="zoom">Zoom to fill (crops the top and bottom)</option>
              <option value="stretch">Stretch to fill</option>
            </select>
          </label>
          <p className="muted small">
            In a stream, move the mouse to the top or hold <kbd>View</kbd>+<kbd>Menu</kbd> for the bar (fit, the Xbox button, end). <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> switches the fit and{" "}
            <kbd>Ctrl</kbd>+<kbd>Q</kbd> ends the stream. The console's games show in the library under Other stores with Play remotely, which starts the game on the console first.
          </p>
        </>
      )}
      {msg && <p className={msg.error ? "error small" : "notice small"}>{msg.text}</p>}
      <GreenlightSetup embedded />
    </div>
  );
}

/** Greenlight, the open-source Xbox streaming app, as another option. */
export function GreenlightSetup({ embedded }: { embedded?: boolean }) {
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

  const body = (
    <>
      <p className="muted small">
        <strong>Greenlight</strong> is a separate open-source Xbox streaming app. LootDen can set it up here too; it then shows beside Play remotely.
      </p>
      {!s.supported ? (
        <p className="muted small">LootDen doesn't download Greenlight on this system yet.</p>
      ) : s.exe ? (
        <p className="small">
          ✅ Greenlight {s.version ? `${s.version} ` : ""}
          {s.managed ? "is set up here" : "found on this PC"}
          {s.managed && (
            <>
              {" · "}
              <button className="button small" disabled={busy} onClick={() => void run(() => desktop!.installGreenlight!(), (r) => `Greenlight ${r.version ?? ""} is up to date`)}>
                Check for updates
              </button>{" "}
              <button className="button small ghost" disabled={busy} onClick={() => void run(() => desktop!.removeGreenlight!(), () => "Greenlight was removed from this PC")}>
                Remove
              </button>
            </>
          )}
        </p>
      ) : (
        <p className="small">
          <button className="button" disabled={busy} onClick={() => void run(() => desktop!.installGreenlight!(), (r) => `Greenlight ${r.version ?? ""} is ready`)}>
            {busy ? "Setting up Greenlight…" : "Set up Greenlight"}
          </button>
        </p>
      )}
      {msg && <p className={msg.error ? "error small" : "notice small"}>{msg.text}</p>}
    </>
  );
  if (embedded) return body;
  return (
    <div className="store-scan">
      <h3>🎮 Xbox remote play</h3>
      {body}
    </div>
  );
}
