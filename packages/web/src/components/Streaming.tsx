import { useEffect, useState } from "react";
import type { StreamHost } from "@lootden/shared";
import { api } from "../api";
import { bridgeError, desktop, type StreamingStatus } from "../desktop";

/**
 * Profile, This computer: game streaming. On the gaming PC, link Sunshine and LootDen keeps its
 * games in Sunshine; on a TV PC or laptop with Moonlight, game pages get a Stream button.
 */
export function StreamingSetup() {
  const [s, setS] = useState<StreamingStatus | null>(null);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void desktop?.streaming?.().then(setS, () => {}), []);
  if (!desktop?.streaming || !s) return null;

  const run = async (fn: () => Promise<StreamingStatus & { added?: string[] }>, done: (r: { added?: string[] }) => string) => {
    setBusy(true);
    try {
      const r = await fn();
      setS(r);
      setMsg({ text: done(r) });
    } catch (e) {
      setMsg({ text: bridgeError(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  const added = (r: { added?: string[] }) => (r.added?.length ? `Added ${r.added.length} game${r.added.length === 1 ? "" : "s"} to Sunshine` : "Sunshine already has every game on this PC");

  return (
    <div className="store-scan">
      <h3>📺 Stream games to the TV</h3>
      <p className="muted small">
        Play games from this PC on a TV, laptop or tablet: <strong>Sunshine</strong> on the PC that runs the games, <strong>Moonlight</strong> on the screen you play on. Pair Moonlight with Sunshine
        once (in Moonlight), and LootDen does the rest. Games streamed this way still count toward play time.
      </p>
      <p className="small">
        {s.sunshine ? "✅ Sunshine is installed here" : "Sunshine isn't installed here"} · {s.moonlight ? "✅ Moonlight is installed here" : "Moonlight isn't installed here"}
      </p>
      {s.sunshine && !s.linked && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => desktop!.linkSunshine!(user, pass), added);
          }}
        >
          <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Sunshine username" autoComplete="off" aria-label="Sunshine username" />
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Sunshine password" autoComplete="off" aria-label="Sunshine password" />
          <button className="button primary" disabled={busy || !user.trim() || !pass}>
            Add my games to Sunshine
          </button>
        </form>
      )}
      {s.linked && (
        <p>
          {s.streamGames} game{s.streamGames === 1 ? "" : "s"} ready to stream from {s.hostname}.{" "}
          <button className="button small" disabled={busy} onClick={() => void run(() => desktop!.syncSunshine!(), added)}>
            Add new games
          </button>{" "}
          <button className="button small ghost" disabled={busy} onClick={() => void run(() => desktop!.unlinkSunshine!(), () => "Unlinked Sunshine (its apps stay)")}>
            Unlink
          </button>
        </p>
      )}
      {!s.sunshine && !s.moonlight && (
        <p className="muted small">
          Get them free from <a href="https://app.lizardbyte.dev/Sunshine/" target="_blank" rel="noreferrer">lizardbyte.dev</a> and{" "}
          <a href="https://moonlight-stream.org" target="_blank" rel="noreferrer">moonlight-stream.org</a>.
        </p>
      )}
      {msg && <p className={msg.error ? "error small" : "notice small"}>{msg.text}</p>}
    </div>
  );
}

/** A game's page: "Stream from DEN-PC" when another PC streams it and this one has Moonlight. */
export function StreamButton({ gameId, title }: { gameId: string; title: string }) {
  const [hosts, setHosts] = useState<StreamHost[]>([]);
  const [status, setStatus] = useState<StreamingStatus | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    if (!desktop?.streamGame || !desktop.streaming) return;
    void desktop.streaming().then((st) => {
      setStatus(st);
      if (st.moonlight) void api.streamHosts(gameId, st.hostname).then(setHosts, () => {});
    }, () => {});
  }, [gameId]);
  if (!status?.moonlight || !hosts.length) return null;
  return (
    <div className="stream-buttons">
      {hosts.map((h) => (
        <button
          key={h.name}
          className="secondary"
          disabled={!h.addresses.length}
          title={h.online ? undefined : `${h.name} is off. Wake it from Settings, PCs.`}
          onClick={() =>
            void desktop!.streamGame!(h.addresses[0]!, title).then(
              () => setMsg({ text: `Starting ${title} on ${h.name}…` }),
              (e) => setMsg({ text: bridgeError(e), error: true }),
            )
          }
        >
          📺 Stream from {h.name}
          {h.online ? "" : " (off)"}
        </button>
      ))}
      {msg && <p className={msg.error ? "error small" : "notice small"}>{msg.text}</p>}
    </div>
  );
}
