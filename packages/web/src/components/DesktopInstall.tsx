import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EMULATORS, platformFor, recompsFor, type GameDetail, type RecompInfo } from "@lootden/shared";
import { api, formatBytes } from "../api";
import { useAuth } from "../auth";
import { bridgeError, desktop, useDesktopGame, type Drive, type RecompSettingView, type RecompSetup } from "../desktop";
import { LaunchOptionsPanel, PlayWithButtons, useLaunchOptions } from "./LaunchOptions";

/** Install / play / uninstall panel shown inside the desktop app. */
export function DesktopInstall({ game, autoFocus }: { game: GameDetail; autoFocus: boolean }) {
  const { installed, loose, progress, refresh, setProgress } = useDesktopGame(game.id);
  const { me } = useAuth();
  const navigate = useNavigate();
  const [drives, setDrives] = useState<Drive[]>([]);
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pcGame = (installed?.platform ?? "pc") === "pc";
  const launch = useLaunchOptions(installed && pcGame ? `lootden:${game.id}` : null);
  /** Recomps that play this console game, and which are set up on this PC. */
  const [added, setAdded] = useState<RecompInfo[]>([]);
  useEffect(() => {
    if (game.platform !== "pc" && desktop?.recomps) void api.recomps().then((r) => setAdded(r.added), () => {});
  }, [game.platform]);
  const recomps = pcGame ? [] : recompsFor(game, added);
  const [recompSetup, setRecompSetup] = useState<RecompSetup[] | null>(null);
  const recompKey = recomps.map((r) => r.id).join(",");
  useEffect(() => {
    if (recompKey && desktop?.recomps) void desktop.recomps().then((r) => setRecompSetup(r.recomps), () => {});
  }, [recompKey]);
  const readyRecomps = recomps.filter((r) => recompSetup?.find((x) => x.id === r.id)?.installed);
  /** Running and paused, followed from the app's events (waits and messages come in between). */
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const p = progress;
    if (!p) return;
    if (p.type === "playing") setRunning(true);
    if (p.type === "stopped" || p.type === "error") {
      setRunning(false);
      setPaused(false);
    }
    if (p.type === "suspended") setPaused(true);
    if (p.type === "resumed") setPaused(false);
  }, [progress]);

  useEffect(() => {
    if (!desktop) return;
    void Promise.all([desktop.info(), desktop.drives()]).then(([info, d]) => {
      setTarget(info.installDir);
      setDrives(d);
      if (info.installing.includes(game.id)) setBusy(true);
    });
  }, [game.id]);
  useEffect(() => {
    if (autoFocus) button.current?.focus();
  }, [autoFocus, installed]);
  // After uploading an installed copy the game has a new id on the server.
  useEffect(() => {
    if (progress?.type === "prepare" && progress.done && progress.newId && progress.newId !== game.id) navigate(`/games/${progress.newId}`, { replace: true });
  }, [progress, game.id, navigate]);

  if (!desktop) return null;
  const bridge = desktop;
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(bridgeError(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const driveFor = (p: string) => drives.filter((d) => p.toLowerCase().startsWith(d.path.toLowerCase())).sort((a, b) => b.path.length - a.path.length)[0];
  const drive = driveFor(target);
  const lowSpace = drive && drive.freeBytes < game.sizeBytes * (game.packed ? 2 : 1);

  const p = progress;
  const emulatorName = game.platform !== "pc" ? EMULATORS.find((e) => e.id === platformFor(game.platform).emulator)?.name : undefined;
  const downloading = busy && p?.type === "download";
  const pct = downloading ? (p.received / Math.max(1, p.total)) * 100 : 0;

  const setupMessage = p?.type === "prepare" ? p : null;

  // Downloaded, but it's still the installer: run it once here before anything can be played.
  if (installed && installed.needsSetup && !installed.installedDir && (installed.platform ?? "pc") === "pc") {
    const what = installed.needsSetup === "disc" ? "a disc image" : "the game's installer";
    return (
      <div className="install panel">
        <div className="inline">
          {bridge.runSetup ? (
            <button ref={button} className="primary" disabled={busy} onClick={() => run(() => bridge.runSetup!(game.id))}>
              {busy ? "Installing…" : "Run installer"}
            </button>
          ) : null}
          <button className="secondary" onClick={() => run(() => bridge.openFolder(game.id))}>
            Open folder
          </button>
          <button className="ghost" onClick={() => run(() => bridge.uninstall(game.id))}>
            Uninstall
          </button>
        </div>
        <p className="muted small">
          This download is {what}, not the game yet. {bridge.runSetup ? "Run installer sets it up in an Installed folder inside" : "Update the app to run it from here, or run setup.exe yourself in"} <code>{installed.dir}</code>
          {bridge.runSetup ? ", then Play starts the game." : "."}
        </p>
        {setupMessage && <p className={setupMessage.error ? "error small" : "notice small"}>{setupMessage.message}</p>}
        {error && <p className="error small">{error}</p>}
      </div>
    );
  }

  if (installed) {
    // An admin who just ran an installer can put the installed game on the server for everyone.
    const canUpload = me?.role === "admin" && !!game.needsSetup && !!installed.installedDir && !!bridge.uploadInstalled;
    return (
      <div className="install panel">
        <div className="inline">
          <button ref={button} className="primary" disabled={busy || running} onClick={() => run(() => bridge.play(game.id))}>
            {running ? (paused ? "Paused" : "Playing…") : emulatorName ? `▶ Play in ${emulatorName}` : launch.state?.profile?.defaultAction ? `▶ Play with ${launch.state.profile.actions.find((a) => a.id === launch.state!.profile!.defaultAction)?.name ?? "mods"}` : "▶ Play"}
          </button>
          {!running && <PlayWithButtons profile={launch.state?.profile ?? null} disabled={busy} onPlay={(id) => void run(() => bridge.play(game.id, id))} />}
          {!running &&
            bridge.recomps &&
            recomps.map((r) =>
              recompSetup?.find((x) => x.id === r.id)?.installed ? (
                <button key={r.id} className="secondary" disabled={busy} title={`${r.name}: a native PC version of ${r.game}`} onClick={() => void run(() => bridge.play(game.id, `recomp:${r.id}`))}>
                  ▶ Play with {r.name}
                </button>
              ) : (
                <button
                  key={r.id}
                  className="secondary"
                  disabled={busy}
                  title={`Downloads ${r.name} from github.com/${r.repo}`}
                  onClick={() =>
                    void run(async () => {
                      await bridge.installRecomp!(r.id);
                      setRecompSetup((await bridge.recomps!()).recomps);
                    })
                  }
                >
                  Set up {r.name}
                </button>
              ),
            )}
          {running && bridge.suspend && pcGame && (
            <button className="secondary" onClick={() => void bridge.suspend!(game.id).catch((e) => setError(bridgeError(e)))}>
              {paused ? "▶ Resume" : "⏸ Pause game"}
            </button>
          )}
          <button className="secondary" onClick={() => run(() => bridge.openFolder(game.id))}>
            Open folder
          </button>
          <button className="ghost" onClick={() => run(() => bridge.uninstall(game.id))}>
            Uninstall
          </button>
        </div>
        {canUpload && (
          <p className="notice small">
            <button className="small" disabled={busy} onClick={() => run(() => bridge.uploadInstalled!(game.id))}>
              Upload installed game
            </button>{" "}
            The server still has the installer. Uploading this installed copy means everyone after you gets a ready-to-play download.
          </p>
        )}
        {setupMessage && <p className={setupMessage.error ? "error small" : "muted small"}>{setupMessage.message}</p>}
        <p className="muted small">
          Installed in <code>{installed.installedDir ?? installed.dir}</code>
          {p?.type === "stopped" ? ` · last session ${Math.round(p.seconds / 60)} min` : ""}
        </p>
        {error && <p className="error small">{error}</p>}
        {readyRecomps.map((r) => (
          <RecompSettingsPanel key={r.id} recomp={r} />
        ))}
        {launch.state && <LaunchOptionsPanel launchKey={`lootden:${game.id}`} title={game.title} state={launch.state} onSaved={() => void launch.reload()} />}
      </div>
    );
  }

  return (
    <div className="install panel">
      {loose.length > 0 && bridge.adopt && (
        <p className="notice small">
          Found a copy at <code>{loose[0]}</code>.{" "}
          <button className="small" disabled={busy} onClick={() => run(() => bridge.adopt!(game.id, loose[0]!))}>
            Use this copy
          </button>{" "}
          Installing instead downloads into that folder, reusing any files that are already complete.
        </p>
      )}
      <div className="inline">
        <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Install location" disabled={busy}>
          {[...new Set([target, ...drives.map((d) => (d.path.endsWith("\\") ? `${d.path}Games` : `${d.path.replace(/\/$/, "")}/Games`))])]
            .filter(Boolean)
            .map((dir) => {
              const d = driveFor(dir);
              return (
                <option key={dir} value={dir}>
                  {dir}
                  {d ? ` (${formatBytes(d.freeBytes)} free)` : ""}
                </option>
              );
            })}
        </select>
        <button className="ghost" disabled={busy} onClick={async () => { const dir = await bridge.chooseFolder(); if (dir) setTarget(dir); }}>
          Choose folder…
        </button>
      </div>
      <div className="inline">
        <button
          ref={button}
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              setProgress(null);
              await bridge.setInstallDir(target);
              await bridge.install(game.id, target);
            })
          }
        >
          {busy ? "Installing…" : game.needsSetup ? `Download installer (${formatBytes(game.sizeBytes)})` : `Install (${formatBytes(game.sizeBytes)})`}
        </button>
        {busy && (
          <button className="ghost" onClick={() => bridge.cancel(game.id)}>
            Cancel
          </button>
        )}
      </div>
      {lowSpace && <p className="error small">Only {formatBytes(drive!.freeBytes)} free on that drive.</p>}
      {busy && p && (
        <div className="progress">
          <div className="meter">
            <div style={{ width: `${p.type === "extract" ? 100 : pct}%` }} />
            <span>
              {p.type === "download" && `Downloading ${p.index + 1}/${p.count} · ${formatBytes(p.received)} of ${formatBytes(p.total)}`}
              {p.type === "extract" && `Unpacking ${p.archive}`}
              {p.type === "removed" && "Cleaning up archives"}
              {p.type === "start" && "Starting…"}
              {p.type === "downloaded" && "Downloaded"}
            </span>
          </div>
        </div>
      )}
      {p?.type === "cancelled" && <p className="muted small">Cancelled. Installing again resumes where it stopped.</p>}
      {error && p?.type !== "cancelled" && <p className="error small">{error}</p>}
      <p className="muted small">Archives are unpacked and removed automatically once the download finishes.</p>
    </div>
  );
}

/** A recomp's own settings (from its recomplauncher.json), changed here instead of in its files. */
function RecompSettingsPanel({ recomp }: { recomp: RecompInfo }) {
  const [settings, setSettings] = useState<RecompSettingView[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    void desktop?.recompSettings?.(recomp.id).then(setSettings, () => {});
  }, [recomp.id]);
  if (!settings.length || !desktop?.setRecompSetting) return null;
  const pick = async (id: string, choice: number) => {
    setError("");
    try {
      setSettings(await desktop!.setRecompSetting!(recomp.id, id, choice));
    } catch (e) {
      setError(bridgeError(e));
    }
  };
  return (
    <details className="recomp-settings">
      <summary>{recomp.name} settings</summary>
      {settings.map((s) => (
        <label key={s.id} className={s.disabled ? "muted" : undefined}>
          {s.label}{" "}
          <select value={s.current} disabled={s.disabled} onChange={(e) => void pick(s.id, Number(e.target.value))}>
            {s.current < 0 && <option value={-1}>Custom</option>}
            {s.choices.map((c, i) => (
              <option key={i} value={i}>
                {c}
              </option>
            ))}
          </select>
          {s.help && <span className="muted small"> {s.help}</span>}
        </label>
      ))}
      {error && <p className="error small">{error}</p>}
    </details>
  );
}
