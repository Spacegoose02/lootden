import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { compareVersion, effectiveVersion, versionLabel as v, type GameSummary } from "@lootden/shared";
import { formatBytes } from "../api";
import { bridgeError, desktop, type InstalledGame, type Progress } from "../desktop";

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

  useEffect(
    () =>
      desktop?.onProgress((p) => {
        if (p.gameId !== update.id) return;
        setProgress(p);
        if (p.type === "prepare") setMessage(p.message);
      }),
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
      setError(bridgeError(e));
    } finally {
      setBusy(false);
      setProgress(null);
      onChange();
    }
  };

  const p = progress;
  const pct = p?.type === "download" ? (p.received / Math.max(1, p.total)) * 100 : 0;
  return (
    <div className="pkg-actions">
      {applied ? (
        <div className="inline">
          <span className="badge badge-kid">Applied {new Date(applied.appliedAt).toLocaleDateString()}</span>
          {applied.mode === "files" && latest?.id === applied.id && bridge.undoUpdate && (
            <button className="button small" disabled={busy} onClick={() => run(() => bridge.undoUpdate!(update.id))}>
              Undo
            </button>
          )}
        </div>
      ) : (
        <div className="inline">
          <button className={`button small${problem ? "" : " primary"}`} disabled={busy} onClick={() => run(() => bridge.applyUpdate!(update.id))}>
            {busy ? "Applying…" : problem ? "Apply anyway…" : update.kind === "dlc" ? "Add to game" : "Apply update"}
          </button>
          <span className="muted small">
            {problem ?? `To ${local.title}${have ? ` (${v(have)})` : ""} · ${formatBytes(update.sizeBytes)}`}
          </span>
        </div>
      )}
      {busy && p?.type === "download" && (
        <div className="meter">
          <div style={{ width: `${pct}%` }} />
          <span>
            Downloading · {formatBytes(p.received)} of {formatBytes(p.total)}
          </span>
        </div>
      )}
      {busy && p?.type === "extract" && <p className="muted small">Unpacking {p.archive}</p>}
      {/* A failure comes back as both the last status line and the thrown error; show it once. */}
      {message && !error && <p className={`small${p?.type === "prepare" && p.error ? " error" : " muted"}`}>{message}</p>}
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
