import { useEffect, useState } from "react";
import { api } from "../api";
import { pushSubscription, pushWorks, turnOffPush, turnOnPush } from "../pwa";

/** Profile: notifications on this phone or PC, through the installed app or the browser. */
export function PushToggle({ admin }: { admin: boolean }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [devices, setDevices] = useState(0);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setOn(!!(await pushSubscription().catch(() => null)));
    setDevices((await api.pushInfo().catch(() => ({ devices: 0 }))).devices);
  };
  useEffect(() => void load(), []);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      await load();
      setNote({ text: done });
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <h2>Notifications</h2>
      <p className="muted small">
        {admin ? "The alerts the bell shows (new games, finished downloads, requests and asks for more time)" : "When a game request or an ask for more time is answered"}, on
        this device even when LootDen isn't open. On a phone, install LootDen first: Add to Home Screen, or Install app in the browser's menu.
      </p>
      {!pushWorks() ? (
        <p className="muted small">This browser can't get notifications{window.isSecureContext ? "" : " (LootDen needs https)"}.</p>
      ) : (
        <div className="inline wrap">
          {on ? (
            <>
              <button className="secondary" disabled={busy} onClick={() => void act(() => api.pushTest(), "Sent a test notification.")}>
                Send a test
              </button>
              <button className="ghost" disabled={busy} onClick={() => void act(turnOffPush, "Notifications are off on this device.")}>
                Turn off here
              </button>
            </>
          ) : (
            <button className="primary" disabled={busy || on === null} onClick={() => void act(turnOnPush, "Notifications are on for this device.")}>
              Turn on notifications here
            </button>
          )}
          <span className="muted small">
            {devices} {devices === 1 ? "device" : "devices"} on
          </span>
        </div>
      )}
      {note && <p className={note.error ? "error small" : "muted small"}>{note.text}</p>}
    </section>
  );
}
