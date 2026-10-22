import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AddonView } from "@lootden/shared";
import { api } from "../api";
import { Card, Field, Pill, Toggle } from "./SettingsUi";

/** Profile: connect store accounts (Steam, GOG, Epic...) so their games show in the Library. */
export function GameLibraries({ admin }: { admin: boolean }) {
  const [list, setList] = useState<AddonView[] | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    api.addons().then(setList, (e: Error) => setMsg({ text: e.message, error: true }));
  }, []);
  if (!list) return msg ? <p className="error">{msg.text}</p> : null;
  const shown = list.filter((a) => a.enabled || admin);
  return (
    <section className="panel game-libraries">
      <h2>Game libraries</h2>
      <p className="muted small">
        Connect your accounts on other stores and their games show up under <Link to="/library?tab=stores">Library, Other stores</Link>, next to what's on this server. Only you see your accounts and games.
      </p>
      {msg && <p className={msg.error ? "error" : "ok"}>{msg.text}</p>}
      {shown.length === 0 && <p className="muted">No library add-ons are switched on.</p>}
      {shown.map((a) => (
        <AddonCard key={a.id} addon={a} admin={admin} onList={setList} say={(text, error) => setMsg({ text, error })} />
      ))}
    </section>
  );
}

function AddonCard({ addon, admin, onList, say }: { addon: AddonView; admin: boolean; onList: (l: AddonView[]) => void; say: (m: string, error?: boolean) => void }) {
  const [config, setConfig] = useState<Record<string, string>>(addon.account?.config ?? {});
  const [busy, setBusy] = useState(false);
  const acc = addon.account;
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      say(await fn());
    } catch (e) {
      say((e as Error).message, true);
      // The error is kept on the account; show it there too.
      api.addons().then(onList, () => {});
    } finally {
      setBusy(false);
    }
  };
  const status = !addon.enabled ? (
    <Pill tone="muted">Off on this server</Pill>
  ) : !acc ? (
    <Pill tone="muted">Not connected</Pill>
  ) : acc.error ? (
    <Pill tone="bad">Sync failing</Pill>
  ) : (
    <Pill tone="good">{acc.games} games</Pill>
  );
  return (
    <Card
      title={addon.name}
      description={
        <>
          {addon.description}
          {addon.homepage && (
            <>
              {" "}
              <a href={addon.homepage} target="_blank" rel="noreferrer">
                More
              </a>
            </>
          )}
        </>
      }
      status={status}
      actions={
        addon.enabled && (
          <>
            {acc && (
              <>
                <button className="ghost" disabled={busy} onClick={() => run(async () => (onList(await api.disconnectAddon(addon.id)), `${addon.name} disconnected`))}>
                  Disconnect
                </button>
                <button className="ghost" disabled={busy} onClick={() => run(async () => { const r = await api.syncAddon(addon.id); onList(r.addons); return `${addon.name}: ${r.games} games`; })}>
                  Sync now
                </button>
              </>
            )}
            <button className="primary" disabled={busy} onClick={() => run(async () => { const r = await api.connectAddon(addon.id, config); onList(r.addons); return `${addon.name} connected: ${r.games} games`; })}>
              {busy ? "Syncing…" : acc ? "Save" : "Connect"}
            </button>
          </>
        )
      }
    >
      {addon.enabled && addon.fields.length > 0 && (
        <div className="field-grid">
          {addon.fields.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              hint={
                <>
                  {f.link && (
                    <>
                      <a href={f.link.url} target="_blank" rel="noreferrer">
                        {f.link.label}
                      </a>
                      {f.help ? ". " : ""}
                    </>
                  )}
                  {f.help}
                </>
              }
            >
              <input type={f.secret ? "password" : "text"} placeholder={f.placeholder} value={config[f.key] ?? ""} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} autoComplete="off" />
            </Field>
          ))}
        </div>
      )}
      {acc && (acc.error || acc.lastSyncAt) && <p className={`small ${acc.error ? "error" : "muted"}`}>{acc.error ?? `Synced ${new Date(acc.lastSyncAt!).toLocaleString()}`}</p>}
      {admin && <Toggle checked={addon.enabled} onChange={(v) => run(async () => (onList(await api.setAddonEnabled(addon.id, v)), `${addon.name} ${v ? "switched on" : "switched off"} for everyone`))} label="Available on this server" hint="Admins only: switching it off hides it and its games for everyone" />}
    </Card>
  );
}
