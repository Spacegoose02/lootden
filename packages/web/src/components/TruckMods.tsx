import { useEffect, useMemo, useState } from "react";
import { TRUCK_GAMES, truckModFit, type InstalledTruckMod, type TruckGame, type TruckMod, type TruckModFile, type TruckModFit } from "@lootden/shared";
import { api, formatBytes } from "../api";
import { bridgeError, desktop, type TruckModsLocal } from "../desktop";

const FIT: Record<TruckModFit, { label: string; className: string; hint: string }> = {
  ok: { label: "Fits", className: "badge truck-fit-ok", hint: "Made for this version of the game" },
  outdated: { label: "Outdated", className: "badge truck-fit-outdated", hint: "Made for an older version of the game; look for an update" },
  newer: { label: "Needs newer game", className: "badge truck-fit-newer", hint: "Made for a newer version of the game than this PC has" },
  unknown: { label: "Unknown", className: "badge badge-muted", hint: "The mod doesn't say which game versions it's for, or LootDen couldn't read it" },
};

const forList = (v: string[]) => v.map((x) => x.replace(/\.\*$/, "")).join(", ");

function FitBadge({ fit, versions }: { fit: TruckModFit; versions: string[] }) {
  const f = FIT[fit];
  return (
    <span className={f.className} title={versions.length ? `${f.hint}. Made for ${forList(versions)}` : f.hint}>
      {f.label}
      {fit !== "ok" && versions.length > 0 ? ` (${forList(versions)})` : ""}
    </span>
  );
}

/**
 * Mods for American Truck Simulator or Euro Truck Simulator 2: what's in the mod folder on this
 * PC and whether each mod fits the game's version, mods kept on the server for every PC (with
 * updates), and getting more from TruckyMods in LootDen's browser, which installs and shares them.
 */
export function TruckModsPanel({ game }: { game: TruckGame }) {
  const info = TRUCK_GAMES[game];
  const [shared, setShared] = useState<TruckMod[] | null>(null);
  const [local, setLocal] = useState<TruckModsLocal | null>(null);
  const [busy, setBusy] = useState<number | string | null>(null);
  const [line, setLine] = useState("");
  const [error, setError] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const canLocal = !!desktop?.truckModsLocal;

  const loadShared = () => api.truckMods(game).then(setShared, (e: Error) => (setShared([]), setError(e.message)));
  const loadLocal = () => {
    if (canLocal) void desktop!.truckModsLocal!(game).then(setLocal, (e) => setError(bridgeError(e)));
  };
  useEffect(() => {
    setShared(null);
    setLocal(null);
    void loadShared();
    loadLocal();
  }, [game]);
  // Mods added in the browser (or another tab) show up when they're in.
  useEffect(
    () =>
      desktop?.onProgress((p) => {
        if (p.type !== "truckMods" || p.game !== game) return;
        setLine(p.line);
        if (p.error) setError(p.line);
        if (p.done) {
          loadLocal();
          void loadShared();
        }
      }),
    [game],
  );
  // Back from the browser: look again.
  useEffect(() => {
    const again = () => document.visibilityState === "visible" && (loadLocal(), void loadShared());
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [game]);

  const installedByServer = useMemo(() => new Map((local?.installed ?? []).filter((m) => m.serverId !== null).map((m) => [m.serverId!, m])), [local]);
  const installedByKey = useMemo(() => new Map((local?.installed ?? []).map((m) => [m.serverId !== null ? `server:${m.serverId}` : `file:${m.files[0] ?? ""}`, m])), [local]);
  const gameVersion = local?.gameVersion ?? null;
  const files = local?.files ?? [];
  const outdated = files.filter((f) => f.fit === "outdated").length;
  const newer = files.filter((f) => f.fit === "newer").length;
  const shown = onlyProblems ? files.filter((f) => f.fit === "outdated" || f.fit === "newer") : files;
  const updates = (shared ?? []).filter((m) => {
    const here = installedByServer.get(m.id);
    return here && m.updatedAt > here.installedAt;
  });

  const run = async (key: number | string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      loadLocal();
      void loadShared();
    } catch (e) {
      setError(bridgeError(e));
    } finally {
      setBusy(null);
      setLine("");
    }
  };
  const install = (m: TruckMod) => run(m.id, () => desktop!.installTruckMod!(game, m.id));
  const removeLocal = (key: string) => run(key, () => desktop!.removeTruckMod!(game, key));
  const removeShared = (m: TruckMod) => {
    if (!window.confirm(`Delete ${m.title} from the server? PCs that have it keep their copy.`)) return;
    void run(`del-${m.id}`, () => api.deleteTruckMod(m.id));
  };
  const browse = () => (desktop?.openBrowser ? desktop.openBrowser(info.truckyModsUrl).catch((e) => setError(bridgeError(e))) : window.open(info.truckyModsUrl, "_blank", "noreferrer"));

  return (
    <section className="row truck-mods">
      <div className="inline wrap" style={{ justifyContent: "space-between" }}>
        <h2>{info.short} mods</h2>
        <span className="inline wrap">
          <button className="small" onClick={() => void browse()}>
            Get mods on TruckyMods
          </button>
          {desktop?.addTruckModFile && (
            <button className="ghost small" disabled={busy !== null} onClick={() => void run("file", () => desktop!.addTruckModFile!(game, true))}>
              Add a mod file…
            </button>
          )}
          {desktop?.openTruckModFolder && (
            <button className="ghost small" onClick={() => void desktop!.openTruckModFolder!(game).catch((e) => setError(bridgeError(e)))}>
              Open mod folder
            </button>
          )}
        </span>
      </div>
      <p className="muted small">
        {desktop?.openBrowser
          ? "Download a mod in LootDen's browser (Manual Download on TruckyMods, or any .scs file) and it goes straight into the game's mod folder and onto the server for your other PCs. Turn it on in the game's Mod Manager."
          : "Open LootDen's desktop app to download mods straight into the game's mod folder. Mods kept on the server are below."}
      </p>

      {local && (
        <p className="muted small">
          Mod folder: <code>{local.folder}</code>{" "}
          {desktop?.pickTruckModFolder && (
            <>
              <button className="ghost small" onClick={() => void desktop!.pickTruckModFolder!(game).then(loadLocal, (e) => setError(bridgeError(e)))}>
                Change
              </button>
              {local.custom && (
                <>
                  {" · "}
                  <button className="ghost small" onClick={() => void desktop!.pickTruckModFolder!(game, true).then(loadLocal, (e) => setError(bridgeError(e)))}>
                    Use the usual one
                  </button>
                </>
              )}
            </>
          )}
          <br />
          {gameVersion ? `${info.name} ${gameVersion} on this PC.` : `Start ${info.name} once on this PC so LootDen can tell its version and spot outdated mods.`}
        </p>
      )}

      {line && <p className="muted small truck-line">{line}</p>}
      {error && <p className="error small">{error}</p>}

      {canLocal && local && (
        <>
          <div className="inline wrap" style={{ justifyContent: "space-between" }}>
            <h3 className="small">
              In the mod folder ({files.length})
              {outdated > 0 && <span className="badge truck-fit-outdated" style={{ marginLeft: "0.5rem" }}>{outdated} outdated</span>}
              {newer > 0 && <span className="badge truck-fit-newer" style={{ marginLeft: "0.5rem" }}>{newer} need a newer game</span>}
            </h3>
            {(outdated > 0 || newer > 0) && (
              <label className="inline small">
                <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Only ones that don't fit
              </label>
            )}
          </div>
          {!files.length && <p className="muted small">No mods yet.</p>}
          {shown.length > 0 && (
            <ul className="pkg-list truck-mod-list">
              {shown.map((f) => (
                <LocalRow key={f.file} f={f} mod={f.installedKey ? installedByKey.get(f.installedKey) : undefined} busy={busy === f.installedKey} onRemove={removeLocal} />
              ))}
            </ul>
          )}
        </>
      )}

      <h3 className="small">
        On the server for every PC{shared ? ` (${shared.length})` : ""}
        {updates.length > 0 && <span className="badge truck-fit-newer" style={{ marginLeft: "0.5rem" }}>{updates.length} updated</span>}
      </h3>
      {shared && !shared.length && <p className="muted small">Nothing yet. Mods downloaded in LootDen's browser land here.</p>}
      {shared && shared.length > 0 && (
        <ul className="pkg-list truck-mod-list">
          {shared.map((m) => {
            const here = installedByServer.get(m.id);
            const updated = !!here && m.updatedAt > here.installedAt;
            return (
              <li key={m.id}>
                <div className="pkg-title">
                  <strong>{m.title}</strong>
                  {m.modVersion && <span className="muted small">v{m.modVersion}</span>}
                  <FitBadge fit={truckModFit(m.compatibleVersions, gameVersion)} versions={m.compatibleVersions} />
                  {here && !updated && <span className="badge badge-muted">On this PC</span>}
                  {updated && <span className="badge truck-fit-newer">Newer on the server</span>}
                </div>
                <div className="inline wrap small">
                  <span className="muted">
                    {formatBytes(m.sizeBytes)} · {m.fileName}
                    {m.addedBy ? ` · added by ${m.addedBy}` : ""} · {new Date(m.updatedAt).toLocaleDateString()}
                  </span>
                  {m.sourceUrl && (
                    <a href={m.sourceUrl} target="_blank" rel="noreferrer">
                      Mod page
                    </a>
                  )}
                  {desktop?.installTruckMod ? (
                    (!here || updated) && (
                      <button className="small" disabled={busy !== null} onClick={() => void install(m)}>
                        {busy === m.id ? "Adding…" : updated ? "Update" : "Add to this PC"}
                      </button>
                    )
                  ) : (
                    <a className="button ghost small" href={api.truckModFileUrl(m.id)}>
                      Download
                    </a>
                  )}
                  {m.canDelete && (
                    <button className="ghost small" disabled={busy !== null} onClick={() => removeShared(m)}>
                      Delete
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function LocalRow({ f, mod, busy, onRemove }: { f: TruckModFile; mod: InstalledTruckMod | undefined; busy: boolean; onRemove: (key: string) => void }) {
  const versions = f.manifest?.compatibleVersions ?? [];
  return (
    <li>
      <div className="pkg-title">
        <strong>{mod?.title ?? f.manifest?.name ?? f.file}</strong>
        {f.manifest?.version && <span className="muted small">v{f.manifest.version}</span>}
        <FitBadge fit={f.fit} versions={versions} />
        {mod && <span className="badge badge-muted">{mod.serverId !== null ? "Added by LootDen, shared" : "Added by LootDen"}</span>}
      </div>
      <div className="inline wrap small">
        <span className="muted">
          {f.file} · {formatBytes(f.sizeBytes)}
          {f.manifest?.author ? ` · by ${f.manifest.author}` : ""}
        </span>
        {mod?.sourceUrl && (
          <a href={mod.sourceUrl} target="_blank" rel="noreferrer">
            Mod page
          </a>
        )}
        {f.installedKey && (
          <button className="ghost small" disabled={busy} onClick={() => onRemove(f.installedKey!)}>
            {busy ? "Removing…" : "Remove"}
          </button>
        )}
      </div>
    </li>
  );
}
