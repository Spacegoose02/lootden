import { useEffect, useState } from "react";
import { bindingSetReady, TEKNOPARROT_DOWNLOAD, type ArcadeBindingSet, type ArcadeLobby, type GameDetail } from "@lootden/shared";
import { api } from "../api";
import { bridgeError, desktop, type ArcadeBindingView, type ArcadeLocal } from "../desktop";

/** Whether a saved setup's devices are all plugged in now (the same rule the app uses to pick one). */
const ready = (b: ArcadeBindingView, local: ArcadeLocal) => bindingSetReady({ ...b, buttons: {} } as ArcadeBindingSet, local.connected);

/**
 * Where TeknoParrot is on this PC. LootDen sets it up itself (from TeknoParrot's own update
 * service, with Microsoft's runtimes it needs), or the player points it at their own copy.
 */
export function TeknoParrotStatus({ local, onChange }: { local: ArcadeLocal; onChange: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "install" | "runtimes">(local.tpBusy ? "install" : "");
  const [status, setStatus] = useState("");
  useEffect(() => desktop?.onProgress((p) => p.gameId === "emu:teknoparrot" && p.type === "prepare" && setStatus(p.message)), []);
  if (!local.supported) return <p className="muted small">TeknoParrot runs on Windows only, so arcade games play on the Windows PCs.</p>;
  const canInstall = Boolean(desktop?.arcadeInstall);
  const missing = (local.prerequisites ?? []).filter((p) => !p.installed);
  const run = (kind: "install" | "runtimes", fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError("");
    setStatus("");
    fn().then(
      () => {
        setBusy("");
        onChange();
      },
      (e) => {
        setBusy("");
        setError(bridgeError(e));
      },
    );
  };
  return (
    <div>
      {local.tpDir ? (
        <p className="small">
          TeknoParrot{local.tpManaged ? ` ${local.tpManaged}, set up by LootDen` : ""}: <code>{local.tpDir}</code>
        </p>
      ) : canInstall ? (
        <p className="notice">TeknoParrot isn't on this PC yet. LootDen sets it up the first time an arcade game starts, or now with the button below.</p>
      ) : (
        <p className="notice">
          LootDen didn't find TeknoParrot on this PC. Install it with its own installer from{" "}
          <a href={TEKNOPARROT_DOWNLOAD} target="_blank" rel="noreferrer">
            teknoparrot.com
          </a>
          , run it once so it fetches its parts, then show LootDen its folder.
        </p>
      )}
      {local.tpDir && missing.length > 0 && (
        <p className="notice">
          TeknoParrot needs {missing.map((p) => p.name).join(", ")}, which {missing.length === 1 ? "isn't" : "aren't"} on this PC.
          {desktop?.arcadeInstallRuntimes ? " LootDen installs them from Microsoft; Windows asks for permission once." : ""}
        </p>
      )}
      <div className="inline">
        {canInstall && (!local.tpDir || local.tpManaged) && (
          <button className={local.tpDir ? "" : "primary"} disabled={Boolean(busy)} onClick={() => run("install", () => desktop!.arcadeInstall!())}>
            {busy === "install" ? "Setting up TeknoParrot…" : local.tpDir ? "Update TeknoParrot" : "Install TeknoParrot"}
          </button>
        )}
        {local.tpDir && missing.length > 0 && desktop?.arcadeInstallRuntimes && (
          <button disabled={Boolean(busy)} onClick={() => run("runtimes", () => desktop!.arcadeInstallRuntimes!())}>
            {busy === "runtimes" ? "Installing runtimes…" : "Install missing runtimes"}
          </button>
        )}
        <button
          disabled={Boolean(busy)}
          onClick={() =>
            desktop!.arcadeLocate!().then(
              () => onChange(),
              (e) => setError(bridgeError(e)),
            )
          }
        >
          {local.tpDir ? "Use another TeknoParrot folder" : "Use a TeknoParrot I already have"}
        </button>
        {local.tpDir && (
          <button disabled={Boolean(busy)} onClick={() => void desktop!.arcadeOpenTeknoParrot!()}>
            Open TeknoParrot
          </button>
        )}
      </div>
      {busy && status && <p className="muted small">{status}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** The Arcade card on Emulators and BIOS: TeknoParrot here and every controller setup saved on this PC. */
export function ArcadeSetupPanel() {
  const [local, setLocal] = useState<ArcadeLocal | null>(null);
  const [error, setError] = useState("");
  const load = () => desktop?.arcade?.().then(setLocal, (e) => setError(bridgeError(e)));
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="panel">
      <h2>Arcade (TeknoParrot)</h2>
      <p className="muted small">
        Arcade games such as Daytona Championship USA play through TeknoParrot. LootDen starts each one straight into its TeknoParrot profile, so TeknoParrot's
        window never shows, and uses the controller setup saved on this PC for whatever wheel or pad is plugged in. Put the games in{" "}
        <code>Emulation/arcade/&lt;game folder&gt;</code>; a folder named after its TeknoParrot profile (<code>Daytona3.teknoparrot</code>) is always recognised.
      </p>
      {!desktop?.arcade ? (
        <p className="notice">Arcade games are set up on each PC from the LootDen desktop app (update it if this message stays in the app).</p>
      ) : !local ? (
        error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>
      ) : (
        <>
          <TeknoParrotStatus local={local} onChange={() => void load()} />
          {local.bindings.length > 0 && (
            <>
              <h3>Controller setups on this PC</h3>
              <ul className="pkg-list">
                {local.bindings.map((b) => (
                  <li key={b.id}>
                    <div className="pkg-title">
                      <strong>{b.name}</strong>
                      <span className="muted small">{b.profile}</span>
                      <span className="muted small">{ready(b, local) ? "plugged in" : "not plugged in"}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

/**
 * An arcade game's page in the desktop app: its TeknoParrot profile, the controller setups
 * saved on this PC (the one for what's plugged in is used), and linked races with other PCs.
 */
export function ArcadePanel({ game }: { game: GameDetail }) {
  const [local, setLocal] = useState<ArcadeLocal | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const load = () => desktop?.arcade?.(game.id).then(setLocal, (e) => setError(bridgeError(e)));
  useEffect(() => {
    setLocal(null);
    void load();
  }, [game.id]);

  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setError("");
    setMessage("");
    try {
      const m = await fn();
      if (m) setMessage(m);
      await load();
    } catch (e) {
      setError(bridgeError(e));
    } finally {
      setBusy("");
    }
  };

  if (!desktop?.arcade) {
    return (
      <section className="panel">
        <h2>Arcade</h2>
        <p className="muted small">An arcade game: it plays through TeknoParrot from the LootDen desktop app on a Windows PC, with your wheel or controller.</p>
      </section>
    );
  }
  if (!local) return error ? <p className="error">{error}</p> : null;

  return (
    <section className="panel arcade-panel">
      <h2>Arcade</h2>
      <TeknoParrotStatus local={local} onChange={() => void load()} />
      {local.supported && local.tpDir && local.installed === false && <p className="muted small">Install it on this PC to set up its controls and races.</p>}
      {local.supported && local.tpDir && local.installed && (
        <>
          <label className="inline">
            TeknoParrot profile
            <select
              value={local.profilePicked ? (local.profile ?? "") : ""}
              disabled={!!busy}
              onChange={(e) => void act("profile", () => desktop!.arcadeSetProfile!(game.id, e.target.value || null).then(() => undefined))}
            >
              <option value="">{local.profile && !local.profilePicked ? `Automatic (${local.profile})` : "Pick one…"}</option>
              {(local.profiles ?? []).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          {!local.profile && <p className="notice">LootDen couldn't tell which TeknoParrot profile this is. Pick it above.</p>}

          {local.profile && (
            <>
              <h3>Controls on this PC</h3>
              <p className="muted small">
                Each setup is saved for the devices it uses. When you press Play, LootDen uses the one whose wheel, pedals and shifter are all plugged in, the one
                with the most devices first, so swapping wheels needs nothing from you.
              </p>
              {local.bindings.length === 0 ? (
                <p className="muted small">No setups yet. Bind your wheel or controller once in TeknoParrot and LootDen keeps them for that device.</p>
              ) : (
                <ul className="pkg-list">
                  {local.bindings.map((b) => (
                    <li key={b.id}>
                      <div className="pkg-title">
                        <strong>{b.name}</strong>
                        {local.active === b.id && <span className="badge">used now</span>}
                        {local.pinned === b.id && <span className="badge">pinned</span>}
                        <span className="muted small">
                          {b.devices.map((d) => d.name).join(", ")} · {ready(b, local) ? "plugged in" : "not plugged in"}
                          {b.inputApi ? ` · ${b.inputApi}` : ""}
                        </span>
                      </div>
                      <div className="inline">
                        <button
                          className="secondary"
                          disabled={!!busy}
                          onClick={() => void act(`pin:${b.id}`, () => desktop!.arcadePin!(game.id, local.pinned === b.id ? null : b.id).then(() => undefined))}
                        >
                          {local.pinned === b.id ? "Unpin" : "Always use this one"}
                        </button>
                        <button
                          className="secondary"
                          disabled={!!busy}
                          onClick={() => {
                            const name = window.prompt("Name this setup", b.name);
                            if (name) void act(`rename:${b.id}`, () => desktop!.arcadeRenameBinding!(b.id, name).then(() => undefined));
                          }}
                        >
                          Rename
                        </button>
                        <button className="secondary" disabled={!!busy} onClick={() => void act(`rm:${b.id}`, () => desktop!.arcadeRemoveBinding!(b.id).then(() => undefined))}>
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="inline">
                <button
                  className="primary"
                  disabled={!!busy}
                  onClick={() =>
                    void act("controls", async () => {
                      setMessage("TeknoParrot is open. Choose this game, set its controls, then close TeknoParrot and LootDen saves them for that wheel or pad.");
                      const r = await desktop!.arcadeSetControls!(game.id);
                      return `Saved the controls as "${r.name}".`;
                    })
                  }
                >
                  {busy === "controls" ? "Waiting for TeknoParrot to close…" : "Set controls in TeknoParrot"}
                </button>
                <button
                  disabled={!!busy}
                  onClick={() => void act("capture", async () => `Saved the controls as "${(await desktop!.arcadeCapture!(game.id)).name}".`)}
                  title="Saves the controls already in this game's TeknoParrot profile"
                >
                  Save the current controls
                </button>
              </div>
            </>
          )}
          {local.profile && <LinkedRace game={game} local={local} busy={busy} act={act} />}
        </>
      )}
      {message && <p className="notice">{message}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** Racing other PCs: each joins the race on the server and gets a cabinet number, then everyone starts. */
function LinkedRace({ game, local, busy, act }: { game: GameDetail; local: ArcadeLocal; busy: string; act: (key: string, fn: () => Promise<string | void>) => Promise<void> }) {
  const [lobby, setLobby] = useState<ArcadeLobby | null>(null);
  const [error, setError] = useState("");
  const me = lobby?.members.find((m) => m.device.toLowerCase() === local.device.toLowerCase());
  const joined = Boolean(me);

  useEffect(() => {
    let live = true;
    const refresh = () =>
      // While in the race, asking again keeps this PC's place; otherwise just look.
      (joined ? api.arcadeJoin(game.id, local.device, local.address) : api.arcadeLobby(game.id)).then(
        (l) => live && setLobby(l),
        (e: Error) => live && setError(e.message),
      );
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [game.id, joined]);

  const link = local.known?.link;
  const others = lobby?.members.filter((m) => m !== me) ?? [];
  return (
    <>
      <h3>Linked race</h3>
      <p className="muted small">
        {link
          ? `${local.known!.title} links up to ${link.maxCabinets} PCs on your home network, like linked cabinets. Join on each PC, then start together.`
          : "Join on each PC that's racing, then start together. Whether a game links depends on the game."}
      </p>
      {lobby && lobby.members.length > 0 && (
        <ul className="pkg-list">
          {lobby.members.map((m) => (
            <li key={m.device}>
              <div className="pkg-title">
                <strong>Cabinet {m.cabinet}</strong>
                <span>{m.device}</span>
                <span className="muted small">
                  {m.name}
                  {m.address ? ` · ${m.address}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="inline">
        {!joined ? (
          <button disabled={!!busy} onClick={() => void api.arcadeJoin(game.id, local.device, local.address).then(setLobby, (e: Error) => setError(e.message))}>
            Join the race on this PC
          </button>
        ) : (
          <>
            <button
              className="primary"
              disabled={!!busy || !others.length}
              title={others.length ? "" : "Waiting for another PC to join"}
              onClick={() =>
                void act("race", async () => {
                  const r = await desktop!.arcadePlay!(game.id, { cabinet: me!.cabinet, total: lobby!.members.length });
                  if (!r) return;
                  const fields = r.linkFields?.length ? ` Set in TeknoParrot: ${r.linkFields.join(", ")}.` : "";
                  return `Racing as cabinet ${me!.cabinet} of ${lobby!.members.length}.${fields}`;
                })
              }
            >
              Start as cabinet {me!.cabinet}
            </button>
            <button className="secondary" onClick={() => void api.arcadeLeave(game.id, local.device).then(setLobby, (e: Error) => setError(e.message))}>
              Leave the race
            </button>
          </>
        )}
      </div>
      {joined && link && (
        <div className="small">
          <p>The first time on each PC, set its cabinet number in the game itself:</p>
          <ol>
            {link.testMenu.map((s) => (
              <li key={s}>{s.replace("this PC's number", `${me!.cabinet}`).replace("the number of PCs racing", `${lobby!.members.length}`)}</li>
            ))}
          </ol>
          <p className="muted small">Bind Test in TeknoParrot's controls (a spare button works) to reach the test menu. The PCs need to be on the same network.</p>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
