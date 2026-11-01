import { useEffect, useState } from "react";
import { playedFor, type PcInfo } from "@lootden/shared";
import { api, formatBytes } from "../api";
import { useLive } from "../live";
import { Card, Pill } from "./SettingsUi";

type Msg = (m: string, error?: boolean) => void;

const ago = (iso: string) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hours ago`;
  return `${Math.round(mins / 1440)} days ago`;
};

/**
 * Settings, PCs: every PC the desktop app runs on, whether it's on, what runs there, how full
 * its drives are, and a Wake button (Wake-on-LAN) for the ones that are off.
 */
export function PcsSection({ say }: { say: Msg }) {
  const [pcs, setPcs] = useState<PcInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mac, setMac] = useState<Record<string, string>>({});
  const load = () => api.pcs().then(setPcs, (e: Error) => say(e.message, true));
  useLive("playing", () => void load());
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, []);

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      say(done);
      await load();
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  if (!pcs) return <p className="muted">Loading…</p>;
  return (
    <>
      <Card
        title="PCs in the house"
        description={
          <>
            Every PC with the LootDen app shows up here once someone opens the app on it. <strong>Wake</strong> switches a PC on over the network (Wake-on-LAN): turn on “Wake on Magic Packet” in the
            PC's network card settings, and run the LootDen server with host networking (<code>network_mode: host</code>) so the packet reaches your home network.
          </>
        }
      />
      {!pcs.length && <p className="muted">No PCs yet. Open the LootDen app on a PC and it appears here within a minute.</p>}
      {pcs.map((pc) => (
        <Card
          key={pc.name}
          title={pc.name}
          status={pc.online ? <Pill tone="good">On</Pill> : <Pill tone="muted">Off · seen {ago(pc.lastSeenAt)}</Pill>}
          description={[pc.lastUser && `Last signed in: ${pc.lastUser}`, pc.platform && (pc.platform === "win32" ? "Windows" : pc.platform === "linux" ? "Linux" : pc.platform), pc.appVersion && `app ${pc.appVersion}`].filter(Boolean).join(" · ")}
          actions={
            <>
              {!pc.online && (
                <button className="button primary" disabled={busy !== null || !pc.macs.length} onClick={() => void run(`wake:${pc.name}`, () => api.wakePc(pc.name), `Sent the wake-up signal to ${pc.name}. It takes a minute to start.`)}>
                  Wake
                </button>
              )}
              <button
                className="button ghost"
                disabled={busy !== null}
                onClick={() => {
                  if (confirm(`Forget ${pc.name}? It comes back the next time the app runs there.`)) void run(`forget:${pc.name}`, () => api.forgetPc(pc.name), `Forgot ${pc.name}`);
                }}
              >
                Forget
              </button>
            </>
          }
        >
          {pc.playing.length > 0 && (
            <p>
              🎮 {pc.playing.map((g) => `${g.name}: ${g.title} (${playedFor(g.startedAt)})`).join(", ")}
            </p>
          )}
          {pc.disks.length > 0 && (
            <ul className="pc-disks">
              {pc.disks.map((d) => {
                const used = 1 - d.freeBytes / d.totalBytes;
                return (
                  <li key={d.path}>
                    <span>{d.path}</span>
                    <span className="pc-disk-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)} aria-label={`${d.path} used`}>
                      <span style={{ width: `${Math.round(used * 100)}%` }} className={used > 0.9 ? "full" : ""} />
                    </span>
                    <span className="muted small">
                      {formatBytes(d.freeBytes)} free of {formatBytes(d.totalBytes)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="muted small">
            {pc.sunshine && "Sunshine (streams games to other screens) · "}
            {pc.moonlight && "Moonlight (plays games streamed from another PC) · "}
            {pc.macs.length ? `Network card ${pc.macs[0]}` : "Network card not known yet"}
            {pc.addresses.length ? ` · ${pc.addresses.join(", ")}` : ""}
          </p>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(`mac:${pc.name}`, () => api.setPcMac(pc.name, mac[pc.name] ?? ""), "Saved the network card");
            }}
          >
            <input placeholder="Wake a different network card: aa:bb:cc:dd:ee:ff" value={mac[pc.name] ?? ""} onChange={(e) => setMac({ ...mac, [pc.name]: e.target.value })} aria-label={`MAC address for ${pc.name}`} />
            <button className="button" disabled={busy !== null || !(mac[pc.name] ?? "").trim()}>
              Save
            </button>
          </form>
        </Card>
      ))}
    </>
  );
}
