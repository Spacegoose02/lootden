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

/** A game's page: "📺 Stream" picks the best PC (on and free, or woken up), plus a button per PC. */
export function StreamButton({ gameId, title }: { gameId: string; title: string }) {
  const [hosts, setHosts] = useState<StreamHost[]>([]);
  const [status, setStatus] = useState<StreamingStatus | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!desktop?.streamGame || !desktop.streaming) return;
    void desktop.streaming().then((st) => {
      setStatus(st);
      if (st.moonlight) void api.streamHosts(gameId, st.hostname).then(setHosts, () => {});
    }, () => {});
  }, [gameId]);
  if (!status?.moonlight || !hosts.length) return null;

  const start = async (h: StreamHost) => {
    if (!h.addresses.length) throw new Error(`LootDen doesn't know ${h.name}'s address yet`);
    await desktop!.streamGame!(h.addresses[0]!, title);
    setMsg({ text: `Starting ${title} on ${h.name}…` });
  };
  /** Picks the PC, wakes it when it's off and waits (up to two minutes) for it to come on. */
  const streamBest = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const { host, waking } = await api.streamPick(gameId, status.hostname);
      if (!waking) return await start(host);
      setMsg({ text: `Waking ${host.name}… this takes a minute.` });
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const now = (await api.streamHosts(gameId, status.hostname).catch(() => [])).find((x) => x.name === host.name);
        if (now?.online) {
          setHosts((all) => all.map((x) => (x.name === now.name ? now : x)));
          return await start(now);
        }
      }
      setMsg({ text: `${host.name} didn't come on. Check it's plugged in and Wake-on-LAN is on in its BIOS.`, error: true });
    } catch (e) {
      setMsg({ text: bridgeError(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  const best = hosts[0]!;
  return (
    <div className="stream-buttons">
      <button className="primary" disabled={busy} onClick={() => void streamBest()} title={best.busy ? `Every PC is busy (${best.busy})` : undefined}>
        📺 Stream{hosts.length > 1 ? "" : ` from ${best.name}`}
      </button>
      {hosts.length > 1 &&
        hosts.map((h) => (
          <button
            key={h.name}
            className="secondary"
            disabled={busy || !h.addresses.length}
            title={h.busy ?? (h.online ? undefined : h.canWake ? `${h.name} is off: 📺 Stream wakes it` : `${h.name} is off. Wake it from Settings, PCs.`)}
            onClick={() => void start(h).catch((e) => setMsg({ text: bridgeError(e), error: true }))}
          >
            {h.name}
            {h.busy ? " (busy)" : h.online ? "" : " (off)"}
          </button>
        ))}
      {msg && <p className={msg.error ? "error small" : "notice small"}>{msg.text}</p>}
    </div>
  );
}
