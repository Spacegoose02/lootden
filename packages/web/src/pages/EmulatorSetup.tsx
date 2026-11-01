import { useEffect, useRef, useState } from "react";
import { platformFor, RECOMPS, type EmulatorInfo, type RecompInfo } from "@lootden/shared";
import { api, formatBytes, type EmulationOverview } from "../api";
import { useAuth } from "../auth";
import { bridgeError, desktop, type EmulatorSetup as Setup, type RecompSetup } from "../desktop";
import { connectedPads } from "../gamepad";

/**
 * Emulators and BIOS files. In the desktop app: set up each emulator from its official
 * releases and put BIOS files in place. Admins: keep BIOS files on the server for every PC.
 */
export function EmulatorSetup() {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const [data, setData] = useState<EmulationOverview | null>(null);
  const [local, setLocal] = useState<{ toolsDir: string; emulators: Setup[] } | null>(null);
  const [recomps, setRecomps] = useState<RecompSetup[] | null>(null);
  const [recompList, setRecompList] = useState<{ builtIn: RecompInfo[]; added: RecompInfo[] }>({ builtIn: RECOMPS, added: [] });
  const [updates, setUpdates] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const canSetUp = Boolean(desktop?.emulators);

  const load = async () => {
    setData(await api.emulation());
    if (desktop?.emulators) setLocal(await desktop.emulators());
    if (desktop?.recomps) setRecomps((await desktop.recomps()).recomps);
    setRecompList(await api.recomps().catch(() => ({ builtIn: RECOMPS, added: [] })));
  };
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
    // Newer releases of the recomps set up here, checked on GitHub once per visit.
    void desktop?.recompUpdates?.().then((list) => setUpdates(Object.fromEntries(list.map((u) => [u.id, u.latest]))), () => {});
    return desktop?.onProgress((p) => {
      if (p.gameId.startsWith("emu:") && p.type === "prepare") setStatus((s) => ({ ...s, [p.gameId.slice(4)]: p.message }));
      if (p.gameId.startsWith("recomp:") && p.type === "prepare") setStatus((s) => ({ ...s, [p.gameId]: p.message }));
    });
  }, []);

  const run = async (key: string, fn: () => Promise<string | void>) => {
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
      setBusy(null);
    }
  };

  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;

  return (
    <div className="emulator-setup">
      <h1>Emulators and BIOS</h1>
      <ControllerPanel />
      {!canSetUp && (
        <p className="notice">
          Emulators are set up on each PC from the LootDen desktop app. Open this page in the app to download them and add BIOS files.
        </p>
      )}
      {canSetUp && (
        <div className="inline">
          <button
            className="primary"
            disabled={!!busy || data.bios.length === 0}
            onClick={() =>
              run("server", async () => {
                const r = await desktop!.biosFromServer!();
                return r.added.length ? `Added ${r.added.join(", ")} from the server.` : "Nothing new on the server.";
              })
            }
          >
            Get BIOS files from the server
          </button>
          <button onClick={() => desktop!.openTools!()}>Open the emulators folder</button>
          <span className="muted small">
            {data.bios.length} on the server · stored in <code>{local?.toolsDir}</code>
          </span>
        </div>
      )}
      {message && <p className="notice">{message}</p>}
      {error && <p className="error">{error}</p>}

      <div className="emulator-list">
        {data.emulators.map((e) => (
          <EmulatorCard
            key={e.id}
            info={e}
            setup={local?.emulators.find((x) => x.id === e.id)}
            canSetUp={canSetUp}
            busy={busy}
            status={status[e.id]}
            onInstall={() => run(e.id, async () => `${e.name} ${(await desktop!.installEmulator!(e.id)).version} is ready.`)}
            onAddBios={() =>
              run(`bios:${e.id}`, async () => {
                const added = await desktop!.addBios!(e.id);
                return added.length ? `Added: ${added.join(", ")}.` : undefined;
              })
            }
          />
        ))}
      </div>

      <h2>Recomps</h2>
      <p className="muted small">
        Native PC versions of console games, rebuilt by their developers from the original game. They play the copy in your library instead of an emulator, with
        widescreen, high frame rates and mods where the recomp has them. Each one downloads from its developer's GitHub releases, checked against GitHub's
        checksum. Once it's set up, the game's page has a Play with button for it.
      </p>
      {!desktop?.recomps && <p className="notice">Recomps are set up on each PC from the LootDen desktop app (update it if this message stays in the app).</p>}
      <div className="emulator-list">
        {[...recompList.builtIn, ...recompList.added].map((r) => (
          <RecompCard
            key={r.id}
            info={r}
            latest={updates[r.id]}
            isAdmin={isAdmin}
            onDelete={() =>
              confirm(`Take ${r.name} off the list for everyone? PCs that set it up keep it until they remove it.`) &&
              run(`recomp-del:${r.id}`, async () => {
                await api.removeRecomp(r.id);
                return `${r.name} is off the list.`;
              })
            }
            setup={recomps?.find((x) => x.id === r.id)}
            canSetUp={Boolean(desktop?.recomps)}
            busy={busy}
            status={status[`recomp:${r.id}`]}
            onInstall={() =>
              run(`recomp:${r.id}`, async () => {
                const x = await desktop!.installRecomp!(r.id);
                setUpdates(({ [r.id]: _done, ...rest }) => rest);
                return x.updated ? `${r.name} ${x.version} is ready.` : `${r.name} ${x.version} is already the latest.`;
              })
            }
            onRemove={() =>
              confirm(`Remove ${r.name} from this PC? Its saves stay, for when you set it up again.`) &&
              run(`recomp-rm:${r.id}`, async () => {
                await desktop!.removeRecomp!(r.id);
                return `Removed ${r.name}. Its saves are still in the recomps folder.`;
              })
            }
          />
        ))}
      </div>

      {isAdmin && <AddRecomp platforms={data.platforms.filter((p) => p.id !== "pc").map((p) => ({ id: p.id, name: p.name }))} onAdded={load} />}

      {isAdmin && <Ps2BrowserPanel data={data} onChange={load} />}
      {isAdmin && <ServerBios data={data} onChange={load} />}
    </div>
  );
}

/** The admin's switch for PS2 games in the browser (TabStationToo), which needs a fast PC. */
function Ps2BrowserPanel({ data, onChange }: { data: EmulationOverview; onChange: () => Promise<void> }) {
  const s = data.ps2Browser;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = async (on: boolean) => {
    setBusy(true);
    setError("");
    try {
      await api.setPs2Browser(on);
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <h2>PS2 in the browser (experimental)</h2>
      <label className="check">
        <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        Let players play PS2 games in the browser
      </label>
      <p className="muted small">
        Runs PCSX2 in the browser through <a href="https://github.com/TabStationToo/TabStationToo" target="_blank" rel="noreferrer">TabStationToo</a> (GPL-3.0),
        streaming the disc from this server. It needs a fast PC with Chrome or Edge, doesn't work on phones, and keeps memory cards in each browser. Turn it off if
        it's too demanding for your PCs; the desktop app still plays PS2 games in PCSX2.
      </p>
      {s.enabled && (
        <p className="muted small">
          {s.available ? `Ready, with ${s.bios} from the BIOS files below.` : s.reason}
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function EmulatorCard(props: {
  info: EmulatorInfo;
  setup: Setup | undefined;
  canSetUp: boolean;
  busy: string | null;
  status: string | undefined;
  onInstall: () => void;
  onAddBios: () => void;
}) {
  const { info, setup } = props;
  const installed = setup?.installed;
  return (
    <section className="panel emulator-card">
      <div className="inline" style={{ justifyContent: "space-between" }}>
        <div>
          <h2>{info.name}</h2>
          <p className="muted small">
            {info.platforms.map((p) => platformFor(p).short).join(", ")} ·{" "}
            <a href={info.homepage} target="_blank" rel="noreferrer">
              {new URL(info.homepage).hostname}
            </a>
          </p>
        </div>
        {props.canSetUp && (
          <div className="inline">
            {installed && <span className="badge">Version {installed.version}</span>}
            <button className={installed ? "" : "primary"} disabled={!!props.busy} onClick={props.onInstall}>
              {props.busy === info.id ? "Working…" : installed ? "Update" : "Set up"}
            </button>
          </div>
        )}
      </div>
      {props.busy === info.id && props.status && <p className="small">{props.status}</p>}
      {info.note && <p className="muted small">{info.note}</p>}
      {info.bios.length > 0 && (
        <>
          <ul className="bios-list">
            {info.bios.map((b) => {
              const present = setup?.bios.find((x) => x.id === b.id)?.present;
              return (
                <li key={b.id}>
                  <span className={present ? "ok" : b.required ? "missing" : "muted"}>{present ? "✓" : b.required ? "✗" : "○"}</span> {b.label}
                  {b.platform ? ` (${platformFor(b.platform).short})` : ""}
                  <span className="muted small">
                    {" "}
                    {present && present !== "installed" ? present : `e.g. ${b.examples.join(", ")}`}
                    {b.autoFetch && !present ? ", downloaded with the emulator" : ""}
                  </span>
                  {b.officialUrl && (
                    <>
                      {" "}
                      <a href={b.officialUrl} target="_blank" rel="noreferrer" className="small">
                        Official download
                      </a>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {props.canSetUp && (
            <button disabled={!!props.busy} onClick={props.onAddBios}>
              Add a BIOS file from this PC
            </button>
          )}
        </>
      )}
    </section>
  );
}

function RecompCard(props: {
  info: RecompInfo;
  latest: string | undefined;
  isAdmin: boolean;
  onDelete: () => void;
  setup: RecompSetup | undefined;
  canSetUp: boolean;
  busy: string | null;
  status: string | undefined;
  onInstall: () => void;
  onRemove: () => void;
}) {
  const { info, setup } = props;
  const installed = setup?.installed;
  const working = props.busy === `recomp:${info.id}`;
  return (
    <section className="panel emulator-card">
      <div className="inline" style={{ justifyContent: "space-between" }}>
        <div>
          <h2>{info.name}</h2>
          <p className="muted small">
            {info.game} ({platformFor(info.platform).short}) ·{" "}
            <a href={`https://github.com/${info.repo}`} target="_blank" rel="noreferrer">
              github.com/{info.repo}
            </a>
          </p>
        </div>
        {props.canSetUp && (
          <div className="inline">
            {installed && <span className="badge">Version {installed.version}</span>}
            <button className={installed && !props.latest ? "" : "primary"} disabled={!!props.busy} onClick={props.onInstall}>
              {working ? "Working…" : installed ? (props.latest ? `Update to ${props.latest}` : "Update") : "Set up"}
            </button>
            {installed && (
              <button className="ghost" disabled={!!props.busy} onClick={props.onRemove}>
                Remove
              </button>
            )}
          </div>
        )}
      </div>
      {working && props.status && <p className="small">{props.status}</p>}
      {info.note && <p className="muted small">{info.note}</p>}
      {info.custom && (
        <p className="muted small">
          Added by an admin · plays {info.titles.join(", ")}
          {props.isAdmin && (
            <>
              {" "}
              <button className="small ghost" disabled={!!props.busy} onClick={props.onDelete}>
                Take off the list
              </button>
            </>
          )}
        </p>
      )}
    </section>
  );
}

/** Admin: a recomp LootDen doesn't know yet, from its GitHub link. */
function AddRecomp({ platforms, onAdded }: { platforms: Array<{ id: string; name: string }>; onAdded: () => Promise<void> }) {
  const [repo, setRepo] = useState("");
  const [platform, setPlatform] = useState("");
  const [title, setTitle] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    setError("");
    try {
      await api.addRecomp({ repo, platform, titles: [title], game: title, name: name || undefined });
      setRepo("");
      setTitle("");
      setName("");
      await onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <h2>Add a recomp</h2>
      <p className="muted small">
        For a recomp LootDen doesn't list yet. Paste its GitHub link and name the game it plays as it appears in your library; that game's page then offers it.
        PCs download it from the developer's releases. Recomps that ship a <code>recomplauncher.json</code> are handed the game file and get their settings on
        the game's page; others start as they are and ask for the game themselves.
      </p>
      <div className="inline">
        <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/owner/name" aria-label="GitHub link" />
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Console">
          <option value="">Console…</option>
          {platforms.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Game title, e.g. NBA Street Vol. 2" aria-label="Game title" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Recomp name" />
        <button className="primary" disabled={busy || !repo || !platform || !title} onClick={() => void add()}>
          Add
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** Admin: BIOS files dumped from your own consoles, kept on the server for every PC in the house. */
function ServerBios({ data, onChange }: { data: EmulationOverview; onChange: () => Promise<void> }) {
  const file = useRef<HTMLInputElement>(null);
  const [emulator, setEmulator] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <h2>BIOS files on the server</h2>
      <p className="muted small">
        Upload BIOS and firmware files dumped from your own consoles once, and every PC can fetch them with "Get BIOS files from the server". They're only
        shared with signed-in players.
      </p>
      <div className="inline">
        <select value={emulator} onChange={(e) => setEmulator(e.target.value)} aria-label="Emulator">
          <option value="">Work out the emulator from the file name</option>
          {data.emulators.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <button className="primary" disabled={busy} onClick={() => file.current?.click()}>
          Upload BIOS files
        </button>
        <input
          ref={file}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            void act(async () => {
              for (const f of files) await api.uploadBios(f, emulator || undefined);
            });
          }}
        />
      </div>
      {error && <p className="error">{error}</p>}
      {data.bios.length > 0 && (
        <table className="table">
          <tbody>
            {data.bios.map((b) => (
              <tr key={b.name}>
                <td>{b.name}</td>
                <td className="muted">{data.emulators.find((e) => e.id === b.emulator)?.name}</td>
                <td className="num">{formatBytes(b.size)}</td>
                <td className="muted small">SHA-1 {b.sha1.slice(0, 10)}</td>
                <td className="actions">
                  <button className="danger" disabled={busy} onClick={() => confirm(`Delete ${b.name}?`) && act(() => api.deleteBios(b.name))}>
                    Delete
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

/** Which controllers LootDen sees, and how they work in the emulators. */
function ControllerPanel() {
  const [pads, setPads] = useState<string[]>(() => connectedPads().map((p) => p.id));
  useEffect(() => {
    const t = setInterval(() => setPads(connectedPads().map((p) => p.id)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <section className="panel controller-panel">
      <h2>Controller</h2>
      {pads.length ? (
        <p>
          <span className="ok">✓</span> {pads.map((p) => p.replace(/\s*\(.*\)\s*$/, "")).join(", ")}
        </p>
      ) : (
        <p className="muted">No controller seen yet. Plug one in (or turn it on) and press any button.</p>
      )}
      <p className="muted small">
        The first controller is player 1 in every emulator: LootDen sets it up in DuckStation and PCSX2 unless you already bound one there, and RetroArch picks it up
        by itself. In RetroArch, Select + Start quits back to LootDen and L3 + R3 opens the menu. In the browser player, click the game once so it gets the controller;
        its own Controls menu remaps buttons. RPCS3 and xemu use their own input settings the first time.
      </p>
    </section>
  );
}
