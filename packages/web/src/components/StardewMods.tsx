import { useEffect, useMemo, useRef, useState } from "react";
import { compareStardewMods, STARDEW_NEXUS_URL, stardewNexusUrl, type StardewModDiff, type StardewModSet, type StardewMod, type StardewProblem, type StardewSyncResult } from "@lootden/shared";
import { api, formatBytes } from "../api";
import { bridgeError, desktop, type StardewModsLocal } from "../desktop";

const STATE: Record<StardewModDiff["state"], { label: string; className: string }> = {
  match: { label: "Matches", className: "badge badge-muted" },
  missing: { label: "Missing", className: "badge truck-fit-outdated" },
  outdated: { label: "Older version", className: "badge truck-fit-outdated" },
  newer: { label: "Newer version", className: "badge truck-fit-newer" },
  extra: { label: "Not in the set", className: "badge truck-fit-newer" },
};

function diffLine(d: StardewModDiff): string {
  if (d.state === "missing") return `${d.name} ${d.setVersion ?? ""} isn't on`;
  if (d.state === "extra") return `${d.name} ${d.pcVersion ?? ""} is on but isn't in the set`;
  return `${d.name} is ${d.pcVersion} (the set has ${d.setVersion})`;
}

function problemLine(p: StardewProblem): string {
  const what = p.needsName ?? p.needs;
  if (p.kind === "off") return `${p.modName} needs ${what}, which is switched off.`;
  if (p.kind === "too-old") return `${p.modName} needs ${what} ${p.minimumVersion} or newer; the set has ${p.haveVersion}.`;
  return `${p.modName} needs ${what}${p.minimumVersion ? ` (${p.minimumVersion} or newer)` : ""}, which isn't in the set.`;
}

function syncLine(r: StardewSyncResult): string {
  const parts = [
    r.added.length && `added ${r.added.join(", ")}`,
    r.updated.length && `updated ${r.updated.join(", ")}`,
    r.switchedOn.length && `switched on ${r.switchedOn.join(", ")}`,
    r.switchedOff.length && `switched off ${r.switchedOff.join(", ")}`,
    r.extrasOff.length && `switched off mods not in the set: ${r.extrasOff.join(", ")}`,
  ].filter(Boolean);
  const failed = r.failed.length ? ` Couldn't get ${r.failed.map((f) => `${f.name} (${f.error})`).join(", ")}.` : "";
  return (parts.length ? `Synced: ${parts.join("; ")}.` : "This PC already matched the set.") + failed;
}

/**
 * Stardew Valley's shared mod set: one list of SMAPI mods for the whole household, switched on
 * or off by an admin, with what the mods need that the set lacks; this PC's Mods folder and
 * syncing it; and how every PC compares, so co-op players have the same mods.
 */
export function StardewModsPanel({ admin }: { admin: boolean }) {
  const [set, setSet] = useState<StardewModSet | null>(null);
  const [local, setLocal] = useState<StardewModsLocal | null>(null);
  const [busy, setBusy] = useState<number | string | null>(null);
  const [line, setLine] = useState("");
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const canLocal = !!desktop?.stardewModsLocal;

  const loadSet = () => api.stardewMods().then(setSet, (e: Error) => (setSet({ mods: [], problems: [], pcs: [] }), setError(e.message)));
  const loadLocal = () => {
    if (canLocal) void desktop!.stardewModsLocal!().then(setLocal, (e) => setError(bridgeError(e)));
  };
  useEffect(() => {
    void loadSet();
    loadLocal();
  }, []);
  useEffect(
    () =>
      desktop?.onProgress((p) => {
        if (p.type !== "stardewMods") return;
        setLine(p.line);
        if (p.error) setError(p.line);
        if (p.done) {
          loadLocal();
          void loadSet();
        }
      }),
    [],
  );
  useEffect(() => {
    const again = () => document.visibilityState === "visible" && (loadLocal(), void loadSet());
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, []);

  const here = useMemo(() => (set && local?.gameDir ? compareStardewMods(set.mods, local.mods) : null), [set, local]);
  const differs = here?.filter((d) => d.state !== "match") ?? [];
  const onCount = set?.mods.filter((m) => m.enabled).length ?? 0;

  const run = async (key: number | string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      loadLocal();
      await loadSet();
    } catch (e) {
      setError(bridgeError(e));
    } finally {
      setBusy(null);
    }
  };
  const sync = () => run("sync", async () => setLine(syncLine(await desktop!.syncStardewMods!())));
  const toggle = (m: StardewMod) => run(m.id, () => api.updateStardewMod(m.id, { enabled: !m.enabled }));
  const remove = (m: StardewMod) => {
    if (!window.confirm(`Delete ${m.title} from the shared set? Each PC switches it off at its next sync.`)) return;
    void run(`del-${m.id}`, () => api.deleteStardewMod(m.id));
  };
  const addFile = () =>
    desktop?.addStardewModFile ? void run("file", () => desktop!.addStardewModFile!()) : file.current?.click();
  const uploadPicked = (f: File | undefined) => {
    if (f) void run("file", async () => setLine(`${(await api.uploadStardewMod(f)).title} is in the shared set`));
    if (file.current) file.current.value = "";
  };
  const browse = () => (desktop?.openBrowser ? desktop.openBrowser(STARDEW_NEXUS_URL).catch((e) => setError(bridgeError(e))) : window.open(STARDEW_NEXUS_URL, "_blank", "noreferrer"));
  const option = (patch: { autoSync?: boolean; strict?: boolean }) =>
    void desktop!.stardewModOptions!(patch).then((o) => setLocal((l) => (l ? { ...l, ...o } : l)), (e) => setError(bridgeError(e)));

  return (
    <section className="row truck-mods stardew-mods">
      <div className="inline wrap" style={{ justifyContent: "space-between" }}>
        <h2>Shared Stardew mods</h2>
        <span className="inline wrap">
          <button className="small" onClick={() => void browse()}>
            Get mods on Nexus
          </button>
          <button className="ghost small" disabled={busy !== null} onClick={addFile}>
            {busy === "file" ? "Adding…" : "Add a mod zip…"}
          </button>
          <input ref={file} type="file" accept=".zip" hidden onChange={(e) => uploadPicked(e.target.files?.[0])} />
          {desktop?.syncStardewMods && local?.gameDir && (
            <button className="small" disabled={busy !== null} onClick={() => void sync()}>
              {busy === "sync" ? "Syncing…" : "Sync this PC now"}
            </button>
          )}
          {desktop?.openStardewModFolder && local?.gameDir && (
            <button className="ghost small" onClick={() => void desktop!.openStardewModFolder!().catch((e) => setError(bridgeError(e)))}>
              Open Mods folder
            </button>
          )}
        </span>
      </div>
      <p className="muted small">
        One mod set for every PC, so co-op always has matching mods. Each PC's Mods folder is made to match it before Stardew starts (or with Sync this PC now): mods are added and updated, and mods
        switched off are renamed with a dot so SMAPI skips them; nothing is deleted. {admin ? "You can switch mods on and off." : "An admin switches mods on and off; ones you add wait for them."}
        {desktop?.openBrowser ? " Mod zips downloaded from Nexus in LootDen's browser are added to the set." : ""}
      </p>

      {line && <p className="muted small truck-line">{line}</p>}
      {error && <p className="error small">{error}</p>}

      {set && set.problems.length > 0 && (
        <div className="notice warning small">
          <strong>Some mods that are on won't load:</strong>
          <ul>
            {set.problems.map((p) => (
              <li key={`${p.modId}-${p.modName}-${p.needs}`}>{problemLine(p)}</li>
            ))}
          </ul>
        </div>
      )}

      {canLocal && local && (
        <>
          <h3 className="small">
            This PC
            {here && (differs.length ? <span className="badge truck-fit-outdated" style={{ marginLeft: "0.5rem" }}>{differs.length} different</span> : <span className="badge badge-muted" style={{ marginLeft: "0.5rem" }}>Matches the set</span>)}
          </h3>
          <p className="muted small">
            {local.gameDir ? (
              <>
                Mods folder: <code>{local.modsDir}</code>{" "}
              </>
            ) : (
              "LootDen couldn't find Stardew Valley on this PC. "
            )}
            {desktop?.pickStardewFolder && (
              <>
                <button className="ghost small" onClick={() => void desktop!.pickStardewFolder!().then(loadLocal, (e) => setError(bridgeError(e)))}>
                  {local.gameDir ? "Change folder" : "Pick the game's folder"}
                </button>
                {local.custom && (
                  <button className="ghost small" onClick={() => void desktop!.pickStardewFolder!(true).then(loadLocal, (e) => setError(bridgeError(e)))}>
                    Find it again
                  </button>
                )}
              </>
            )}
          </p>
          {local.gameDir && desktop?.stardewModOptions && (
            <div className="inline wrap small">
              <label className="inline">
                <input type="checkbox" checked={local.autoSync} onChange={(e) => option({ autoSync: e.target.checked })} /> Sync before Stardew starts
              </label>
              <label className="inline" title="Mods put in the Mods folder by hand that aren't in the set are renamed with a dot, so this PC loads exactly the set">
                <input type="checkbox" checked={local.strict} onChange={(e) => option({ strict: e.target.checked })} /> Switch off mods that aren't in the set
              </label>
            </div>
          )}
          {differs.length > 0 && (
            <ul className="pkg-list truck-mod-list">
              {differs.map((d) => (
                <li key={d.uniqueId}>
                  <div className="pkg-title">
                    <strong>{d.name}</strong>
                    <span className={STATE[d.state].className}>{STATE[d.state].label}</span>
                  </div>
                  <div className="muted small">{diffLine(d)}</div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <h3 className="small">
        The set{set ? ` (${onCount} on of ${set.mods.length})` : ""}
      </h3>
      {set && !set.mods.length && <p className="muted small">No mods yet. Add a mod's zip, or download one from Nexus in LootDen's browser.</p>}
      {set && set.mods.length > 0 && (
        <ul className="pkg-list truck-mod-list">
          {set.mods.map((m) => {
            const page = m.sourceUrl ?? stardewNexusUrl(m.mods.flatMap((x) => x.updateKeys));
            return (
              <li key={m.id} className={m.enabled ? "" : "muted"}>
                <div className="pkg-title">
                  {admin ? (
                    <label className="inline" title={m.enabled ? "On for every PC; untick to switch it off" : "Off; tick to switch it on for every PC"}>
                      <input type="checkbox" checked={m.enabled} disabled={busy !== null} onChange={() => void toggle(m)} />
                      <strong>{m.title}</strong>
                    </label>
                  ) : (
                    <strong>{m.title}</strong>
                  )}
                  {!admin && <span className={m.enabled ? "badge badge-muted" : "badge truck-fit-newer"}>{m.enabled ? "On" : "Off"}</span>}
                </div>
                <div className="small">
                  {m.mods.map((x) => (
                    <div key={x.uniqueId} className="muted">
                      {x.name} {x.version}
                      {x.author ? ` · by ${x.author}` : ""}
                      {x.contentPackFor ? ` · content pack for ${x.contentPackFor.uniqueId}` : ""}
                    </div>
                  ))}
                </div>
                <div className="inline wrap small">
                  <span className="muted">
                    {formatBytes(m.sizeBytes)} · Mods/{m.folder}
                    {m.addedBy ? ` · added by ${m.addedBy}` : ""} · {new Date(m.updatedAt).toLocaleDateString()}
                  </span>
                  {page && (
                    <a href={page} target="_blank" rel="noreferrer">
                      Mod page
                    </a>
                  )}
                  {!canLocal && (
                    <a className="button ghost small" href={api.stardewModFileUrl(m.id)}>
                      Download
                    </a>
                  )}
                  {m.canManage && (
                    <button className="ghost small" disabled={busy !== null} onClick={() => remove(m)}>
                      Delete
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {set && set.pcs.length > 0 && (
        <>
          <h3 className="small">PCs</h3>
          <ul className="pkg-list truck-mod-list">
            {set.pcs.map((pc) => (
              <li key={pc.device}>
                <div className="pkg-title">
                  <strong>{pc.device}</strong>
                  {pc.user && <span className="muted small">{pc.user}</span>}
                  {pc.differences.length ? <span className="badge truck-fit-outdated">{pc.differences.length} different</span> : <span className="badge badge-muted">Matches the set</span>}
                </div>
                <div className="muted small">
                  {pc.mods.length} mods on · last checked {new Date(pc.reportedAt).toLocaleString()}
                  {admin && (
                    <>
                      {" "}
                      <button className="ghost small" onClick={() => void run(`pc-${pc.device}`, () => api.forgetStardewPc(pc.device))}>
                        Forget
                      </button>
                    </>
                  )}
                </div>
                {pc.differences.length > 0 && (
                  <ul className="small">
                    {pc.differences.map((d) => (
                      <li key={d.uniqueId}>{diffLine(d)}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
