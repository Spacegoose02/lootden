import { useEffect, useState } from "react";
import { api } from "../api";

let cached: Promise<{ ready: boolean; buttons: boolean }> | null = null;
/** Whether Dendrop is linked; asked once per page load. */
export function useChatReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    cached ??= api.chatStatus().catch(() => ({ ready: false, buttons: false }));
    void cached.then((s) => setReady(s.ready));
  }, []);
  return ready;
}

/**
 * Share to chat and Looking for a group: post a game to the family's Dendrop chat. Shown only
 * once an admin has linked Dendrop under Settings, Chat.
 */
export function ChatButtons({ gameId, lfg = true, compact = false }: { gameId: string; lfg?: boolean; compact?: boolean }) {
  const ready = useChatReady();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!ready) return null;
  const run = async (what: "share" | "lfg") => {
    setBusy(true);
    try {
      if (what === "share") await api.shareToChat(gameId);
      else await api.lookingForGroup(gameId);
      setMsg({ text: what === "share" ? "Shared to chat." : "Posted! Everyone who's in can click I'm in." });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className={`button${compact ? " small" : ""}`} disabled={busy} onClick={() => void run("share")} title="Post this game to the family chat">
        💬 Share to chat
      </button>
      {lfg && (
        <button className={`button${compact ? " small" : ""}`} disabled={busy} onClick={() => void run("lfg")} title="Ask the family chat who wants to play">
          🙋 Who wants to play?
        </button>
      )}
      {msg && (
        <span className={msg.error ? "error small" : "muted small"} role="status">
          {msg.text}
        </span>
      )}
    </>
  );
}
