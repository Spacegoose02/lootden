import { useEffect, useRef, useState } from "react";
import { api, formatBytes } from "../api";

type Target = { name: string; online: boolean; lastUser: string | null; freeBytes: number };

/**
 * Send to PC on a game's page: pick one of the household's PCs and the LootDen app there
 * downloads and installs the game by itself, now or when the PC next comes on.
 */
export function SendToPcButton({ gameId, title, sizeBytes }: { gameId: string; title: string; sizeBytes: number }) {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => void api.pcTargets().then(setTargets, () => setTargets([])), []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  if (!targets?.length) return null;

  const send = async (t: Target) => {
    try {
      await api.sendToPc(t.name, gameId);
      setNote({ text: t.online ? `Sent! ${title} is downloading on ${t.name}.` : `Sent! ${title} downloads when ${t.name} is next on.` });
      setOpen(false);
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    }
  };

  return (
    <div className="shelf-button" ref={box}>
      <button className="secondary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        🖥️ Send to PC
      </button>
      {open && (
        <div className="shelf-menu panel" role="menu">
          {targets.map((t) => {
            const tight = t.freeBytes > 0 && t.freeBytes < sizeBytes * 1.5;
            return (
              <button key={t.name} role="menuitem" className="menu-item" onClick={() => void send(t)}>
                <span>
                  {t.online ? "🟢" : "⚪"} <strong>{t.name}</strong>
                  {t.lastUser && <small className="muted"> · {t.lastUser}</small>}
                </span>
                {t.freeBytes > 0 && <small className={tight ? "warn-text" : "muted"}>{formatBytes(t.freeBytes)} free</small>}
              </button>
            );
          })}
        </div>
      )}
      {note && (
        <p className={note.error ? "error small" : "notice small"} role="status">
          {note.text}
        </p>
      )}
    </div>
  );
}
