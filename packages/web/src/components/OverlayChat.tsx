import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

type Line = Awaited<ReturnType<typeof api.familyChat>>[number];

/** Quick lines that work with a gamepad, no keyboard needed. */
const QUICK = ["On my way!", "5 more minutes", "Come play with me?", "GG! 🎉", "Can't talk, in a game"];

/**
 * The family chat in the in-game menu: the last few messages from Dendrop's family channel,
 * and quick replies. Kid profiles read along; they send from Dendrop, where their chat rules apply.
 */
export function OverlayChat() {
  const { me } = useAuth();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const load = () => api.familyChat().then(setLines, () => setLines(null));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [lines]);
  if (!lines) return null;
  const canSend = !!me?.user && !me.user.kidMode;
  const send = async (t: string) => {
    if (!t.trim()) return;
    setBusy(true);
    setNote("");
    try {
      await api.sayInFamily(t);
      setText("");
      await load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="overlay-chat" aria-label="Family chat">
      <h3>Family chat</h3>
      <div className="overlay-chat-lines">
        {lines.length === 0 && <p className="muted small">Nothing said yet.</p>}
        {lines.slice(-8).map((l) => (
          <p key={l.id} className={l.mine ? "mine" : ""}>
            <strong>{l.from}</strong> {l.text}
            <time className="muted small"> {new Date(l.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
          </p>
        ))}
        <div ref={end} />
      </div>
      {canSend && (
        <>
          <div className="inline wrap">
            {QUICK.map((q) => (
              <button key={q} className="secondary small" disabled={busy} onClick={() => void send(q)}>
                {q}
              </button>
            ))}
          </div>
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Say something to the family" aria-label="Message" />
            <button className="primary small" disabled={busy || !text.trim()}>
              Send
            </button>
          </form>
        </>
      )}
      {note && <p className="error small">{note}</p>}
    </section>
  );
}
