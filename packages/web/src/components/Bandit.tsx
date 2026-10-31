import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { HELPER_AVATAR, HELPER_AVATAR_THINKING, HELPER_MAX_MESSAGE, HELPER_NAME, helperSuggestions, type HelperChatMessage, type HelperStatus } from "@lootden/shared";
import { api, askHelper, avatarUrl } from "../api";
import { useAuth } from "../auth";
import { useEscape } from "../escape";
import { HELPER_EVENT } from "../gamepad";
import { useCurrentHelperGame } from "../helperGame";

/** Sent after the person flips their own switch in Profile, so the button comes or goes straight away. */
export const HELPER_CHANGED = "lootden:helper-changed";

type Line = HelperChatMessage & { error?: boolean };

const greeting = (name: string, title: string | null, kid: boolean): Line => ({
  role: "assistant",
  content: title
    ? kid
      ? `Hi ${name}! I'm ${HELPER_NAME} 🦝 Need help with ${title}? Ask me anything!`
      : `Hey ${name}, ${HELPER_NAME} here. Stuck in ${title}, or want some tips? Ask away.`
    : kid
      ? `Hi ${name}! I'm ${HELPER_NAME} 🦝 your gaming buddy. What are we playing?`
      : `Hey ${name}, ${HELPER_NAME} here, your gaming helper. Which game can I help with?`,
});

/**
 * Bandit, the AI gaming helper: a button in the corner (or X on a controller) opens a chat that
 * knows which game page you're on. Hidden when the server has no AI set up, when a parent hasn't
 * switched him on for a kid, or when the person switched him off.
 */
export function Bandit() {
  const { me } = useAuth();
  const user = me?.user;
  const [status, setStatus] = useState<HelperStatus | null>(null);
  const [open, setOpen] = useState(false);
  const game = useCurrentHelperGame();
  const load = useCallback(() => {
    if (!user) return setStatus(null);
    api.helperStatus().then(setStatus, () => setStatus(null));
  }, [user]);
  useEffect(load, [load]);
  useEffect(() => {
    window.addEventListener(HELPER_CHANGED, load);
    return () => window.removeEventListener(HELPER_CHANGED, load);
  }, [load]);

  const available = !!status?.available;
  // The controller's X opens and closes him; the button hints show X only when he's there.
  useEffect(() => {
    document.documentElement.dataset.helper = available ? "on" : "off";
    if (!available) return;
    const toggle = () => setOpen((o) => !o);
    window.addEventListener(HELPER_EVENT, toggle);
    return () => window.removeEventListener(HELPER_EVENT, toggle);
  }, [available]);

  if (!user || !status || !available) return null;
  return (
    <>
      {!open && (
        <button className="bandit-fab" onClick={() => setOpen(true)} aria-label={`Ask ${HELPER_NAME}, your gaming helper`} title={`Ask ${HELPER_NAME} (X on a controller)`}>
          <span className="bandit-box">
            <img src={avatarUrl(HELPER_AVATAR)} alt="" width={44} height={44} />
          </span>
          <span className="bandit-fab-label">{game ? `Help with ${game.title}` : `Ask ${HELPER_NAME}`}</span>
        </button>
      )}
      {open && <BanditChat name={user.displayName} status={status} onStatus={load} onClose={() => setOpen(false)} />}
    </>
  );
}

function BanditChat({ name, status, onStatus, onClose }: { name: string; status: HelperStatus; onStatus: () => void; onClose: () => void }) {
  const game = useCurrentHelperGame();
  const key = game?.key ?? "general";
  // One chat per game, kept while the app is open.
  const chats = useRef(new Map<string, Line[]>());
  const [lines, setLines] = useState<Line[]>(() => chats.current.get(key) ?? [greeting(name, game?.title ?? null, status.kid)]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  useEscape(onClose);
  // A different game's page: its own chat.
  useEffect(() => {
    setLines(chats.current.get(key) ?? [greeting(name, game?.title ?? null, status.kid)]);
    abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    chats.current.set(key, lines);
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [key, lines]);
  useEffect(() => () => abort.current?.abort(), []);

  // With a controller, start on the first suggestion (typing needs the on-screen keyboard); otherwise in the text box.
  useEffect(() => {
    const pad = document.documentElement.dataset.nav === "pad";
    const first = pad ? panel.current?.querySelector<HTMLElement>(".bandit-suggestions button") : null;
    (first ?? input.current)?.focus({ preventScroll: true });
  }, []);

  const send = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const history: Line[] = [...lines.filter((l) => !l.error), { role: "user", content: q }];
    setLines([...lines, { role: "user", content: q }, { role: "assistant", content: "" }]);
    setText("");
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    // Moving to another game's page stops the answer (see above), so the last line is still this one.
    const update = (fn: (last: Line) => Line) => setLines((ls) => [...ls.slice(0, -1), fn(ls[ls.length - 1]!)]);
    try {
      await askHelper(
        { messages: history.map(({ role, content }) => ({ role, content })), game: game?.ref ?? null },
        (piece) => update((last) => ({ ...last, content: last.content + piece })),
        ctl.signal,
      );
    } catch (e) {
      if (!ctl.signal.aborted) update(() => ({ role: "assistant", content: (e as Error).message, error: true }));
    } finally {
      setBusy(false);
      onStatus();
    }
  };

  const fresh = lines.length <= 1;
  const left = status.remaining;
  return (
    <div className="bandit-panel" role="dialog" aria-modal="false" aria-label={`${HELPER_NAME}, your gaming helper`} ref={panel}>
      <header className="bandit-head">
        <span className={`bandit-box${busy ? " thinking" : ""}`}>
          <img src={avatarUrl(busy ? HELPER_AVATAR_THINKING : HELPER_AVATAR)} alt="" width={56} height={56} />
        </span>
        <div className="bandit-title">
          <strong>{HELPER_NAME}</strong>
          <small className="muted">{busy ? "Thinking…" : game ? `Helping with ${game.title}` : "Your gaming helper"}</small>
        </div>
        {left !== null && (
          <span className="pill muted" title="Questions left today">
            {left} left
          </span>
        )}
        {!fresh && (
          <button className="ghost small" onClick={() => setLines([greeting(name, game?.title ?? null, status.kid)])} disabled={busy}>
            New chat
          </button>
        )}
        <button className="ghost small bandit-close" onClick={onClose} aria-label={`Close ${HELPER_NAME}`}>
          ✕
        </button>
      </header>
      <div className="bandit-log" ref={log} aria-live="polite">
        {lines.map((l, i) => (
          <div key={i} className={`bandit-msg ${l.role}${l.error ? " error" : ""}`}>
            {l.role === "assistant" && !l.content && busy && i === lines.length - 1 ? (
              <span className="bandit-dots" aria-label="Thinking">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <Answer text={l.content} />
            )}
          </div>
        ))}
      </div>
      {fresh && (
        <div className="bandit-suggestions" data-nav-zone>
          {helperSuggestions(game?.title ?? null, status.kid).map((s) => (
            <button key={s} className="chip" onClick={() => void send(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        className="bandit-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <textarea
          ref={input}
          rows={2}
          value={text}
          maxLength={HELPER_MAX_MESSAGE}
          placeholder={status.paused ? `${HELPER_NAME} is resting until next month` : left === 0 ? "No questions left today" : `Ask ${HELPER_NAME}…`}
          aria-label={`Ask ${HELPER_NAME}`}
          disabled={status.paused || left === 0}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <button className="primary" disabled={busy || !text.trim() || status.paused || left === 0}>
          Send
        </button>
      </form>
      <p className="bandit-note muted small">{status.kid ? `${HELPER_NAME} is an AI and can get things wrong. Ask a grown-up if you're not sure.` : `${HELPER_NAME} is an AI and can make mistakes.`}</p>
    </div>
  );
}

/** Bandit's words with a little formatting: paragraphs, bullet points and **bold**. */
function Answer({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) blocks.push(<ul key={blocks.length}>{bullets.map((b, i) => <li key={i}>{bold(b)}</li>)}</ul>);
    bullets = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) bullets.push(item[1]!);
    else {
      flush();
      if (line.trim()) blocks.push(<p key={blocks.length}>{bold(line.replace(/^#+\s*/, ""))}</p>);
    }
  }
  flush();
  return <>{blocks}</>;
}

function bold(s: string): ReactNode[] {
  return s.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part));
}

/** Profile: the person's own on/off switch for Bandit, and why he might not be there. */
export function BanditProfileCard() {
  const [status, setStatus] = useState<HelperStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => void api.helperStatus().then(setStatus, () => {}), []);
  if (!status) return null;
  const flip = async (enabled: boolean) => {
    try {
      setStatus(await api.setHelperEnabled(enabled));
      setError("");
      window.dispatchEvent(new Event(HELPER_CHANGED));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const why = !status.configured
    ? `${HELPER_NAME} isn't set up on this server yet. An admin can add an AI key in Settings, ${HELPER_NAME} (AI helper).`
    : !status.allowed
      ? status.kid
        ? `Ask a grown-up to switch ${HELPER_NAME} on for you.`
        : `An admin has switched ${HELPER_NAME} off for you.`
      : status.paused
        ? `${HELPER_NAME} is resting until next month.`
        : null;
  return (
    <section className="panel bandit-card">
      <h2>{HELPER_NAME}, your gaming helper</h2>
      <div className="inline">
        <span className="bandit-box">
          <img src={avatarUrl(HELPER_AVATAR)} alt="" width={64} height={64} />
        </span>
        <p className="muted" style={{ margin: 0 }}>
          An AI raccoon who helps with the game you're playing: tips, getting unstuck, and what to play next. Open him with the button in the corner, or X on a controller.
        </p>
      </div>
      <label className="toggle-row">
        <span>
          <span className="toggle-label">Show {HELPER_NAME}</span>
          {why ? <small className="muted">{why}</small> : status.remaining !== null && <small className="muted">{status.remaining} questions left today</small>}
        </span>
        <span className="switch">
          <input type="checkbox" role="switch" checked={status.enabled} disabled={!status.configured || !status.allowed} onChange={(e) => void flip(e.target.checked)} />
          <span aria-hidden="true" />
        </span>
      </label>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
