import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { compareVersion, effectiveVersion, versionLabel as v, type GameSummary } from "@lootden/shared";
import { formatBytes } from "../api";
import { bridgeError, desktop, useActivity, type InstalledGame, type Progress } from "../desktop";

const REASON_LABEL = { admin: "set by admin", folder: "folder", name: "name", size: "size", content: "files" } as const;

/**
 * What LootDen decided an entry is and why: "Update · name", "Full game · size". The full
 * reason ("64 GB, 98% of Cyberpunk 2077") is in the tooltip and, with detail, beside it.
 */
export function KindBadge({ game, detail = false }: { game: Pick<GameSummary, "kind" | "kindReason">; detail?: boolean }) {
  const r = game.kindReason;
  if (!r) return null;
  const label = game.kind === "dlc" ? "DLC" : game.kind === "update" ? "Update" : "Full game";
  return (
    <span className="kind-reason">
      <span className={`badge kind-${game.kind} conf-${r.confidence}`} title={`${r.note} (${r.confidence} confidence)`}>
        {label} · {REASON_LABEL[r.by]}
        {r.confidence === "low" ? " ?" : ""}
      </span>
      {detail && <span className="muted small">{r.note.replace(/^[^:]+:\s*/, "")}</span>}
    </span>
  );
}

/** "v1.2 → v1.3", "v1.3" or "" for an update or DLC. */
export function versionLabel(u: Pick<GameSummary, "version" | "fromVersion">): string {
  if (u.fromVersion && u.version) return `${v(u.fromVersion)} → ${v(u.version)}`;
  return u.version ? `${v(u.version)}` : "";
}

/** Why an update doesn't fit the copy on this PC, or null. Mirrors the app's own check. */
export function versionProblem(u: Pick<GameSummary, "kind" | "version" | "fromVersion">, local: InstalledGame): string | null {
  if (u.kind !== "update") return null;
  const { version: have, fromExe } = effectiveVersion(local, u);
  if (!have) return null;
  if (u.version && compareVersion(u.version, have) <= 0) return fromExe ? `Already on ${v(have)}: the game was updated outside LootDen` : `This PC already has ${v(have)}`;
  if (u.fromVersion && compareVersion(have, u.fromVersion) !== 0) return `Made for ${v(u.fromVersion)}; this PC has ${v(have)}${fromExe ? " (updated outside LootDen)" : ""}`;
  return null;
}

/**
 * What can be done with one update or DLC on this computer: apply it to the installed game,
 * undo it, or what's missing first (the game, the app, the game on the server).
 */
export function UpdateActions({
  update,
  baseTitle,
  installed,
  onChange,
}: {
  update: GameSummary;
  baseTitle: string | null;
  /** Games installed on this PC, from the desktop app; null outside it. */
  installed: InstalledGame[] | null;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [message, setMessage] = useState("");
  // The app applies the update, not this page: when you come back to the page, this is how it
  // knows the update is still going (and when it finishes).
  const job = useActivity().find((a) => a.id === update.id) ?? null;
  const working = busy || !!job;

  useEffect(
    () =>
      desktop?.onProgress((p) => {
        if (p.gameId !== update.id) return;
        setProgress(p);
        if (p.type === "prepare") {
          setMessage(p.message);
          // Finished while you were on another page: show the result and the game's new version.
          if (p.done) onChange();
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [update.id],
  );

  if (!update.baseGameId) {
    return <p className="muted small">Update only: its game isn't on the server, so it can't be installed on its own.</p>;
  }
  const command = `lootden apply ${update.id}`;
  if (!desktop || !installed) {
    return (
      <p className="muted small">
        Apply it from the LootDen app, or run <code>{command}</code>.
      </p>
    );
  }
  if (!desktop.applyUpdate) return <p className="muted small">Update the LootDen app to apply updates from here.</p>;
  const bridge = desktop;
  const local = installed.find((g) => g.gameId === update.baseGameId);
  if (!local) {
    return (
      <p className="muted small">
        <Link to={`/games/${update.baseGameId}`}>Install {baseTitle ?? "the game"}</Link> first, then apply this.
      </p>
    );
  }
  const applied = local.updates?.find((u) => u.id === update.id);
  const latest = local.updates?.[local.updates.length - 1];
  const problem = applied ? null : versionProblem(update, local);
  const have = effectiveVersion(local, update).version;

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      const why = bridgeError(e);
      if (why !== "Cancelled") setError(why);
    } finally {
      setBusy(false);
      setProgress(null);
      onChange();
    }
  };

  const p = progress;
  // After coming back to the page there's no live event yet; the app's own record has the step.
  const received = p?.type === "download" ? p.received : job?.received ?? null;
  const total = p?.type === "download" ? p.total : job?.total ?? null;
  const pct = received !== null && total ? (received / Math.max(1, total)) * 100 : 0;
  const status = message || (job && !busy && received === null && p?.type !== "extract" ? job.message : "");
  return (
    <div className="pkg-actions">
      {applied ? (
        <div className="inline">
          <span className="badge badge-kid">Applied {new Date(applied.appliedAt).toLocaleDateString()}</span>
          {applied.mode === "files" && latest?.id === applied.id && bridge.undoUpdate && (
            <button className="button small" disabled={working} onClick={() => run(() => bridge.undoUpdate!(update.id))}>
              Undo
            </button>
          )}
        </div>
      ) : (
        <div className="inline">
          <button className={`button small${problem ? "" : " primary"}`} disabled={working} onClick={() => run(() => bridge.applyUpdate!(update.id))}>
            {working ? "Applying…" : problem ? "Apply anyway…" : update.kind === "dlc" ? "Add to game" : "Apply update"}
          </button>
          {working && job?.cancellable && (
            <button className="button small ghost" onClick={() => void bridge.cancel(update.id)}>
              Cancel
            </button>
          )}
          <span className="muted small">
            {problem ?? `To ${local.title}${have ? ` (${v(have)})` : ""} · ${formatBytes(update.sizeBytes)}`}
          </span>
        </div>
      )}
      {working && received !== null && total !== null && (
        <div className="meter">
          <div style={{ width: `${pct}%` }} />
          <span>
            Downloading · {formatBytes(received)} of {formatBytes(total)}
          </span>
        </div>
      )}
      {working && p?.type === "extract" && <p className="muted small">Unpacking {p.archive}</p>}
      {working && <p className="muted small">It keeps going if you leave this page.</p>}
      {/* A failure comes back as both the last status line and the thrown error; show it once. */}
      {status && !error && <p className={`small${p?.type === "prepare" && p.error ? " error" : " muted"}`}>{status}</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** Games installed on this PC (desktop app only), refreshed on demand. */
export function useInstalled(): [InstalledGame[] | null, () => void] {
  const [installed, setInstalled] = useState<InstalledGame[] | null>(null);
  const refresh = () => {
    if (desktop) void desktop.installed().then(setInstalled, () => setInstalled([]));
  };
  useEffect(refresh, []);
  return [installed, refresh];
}
