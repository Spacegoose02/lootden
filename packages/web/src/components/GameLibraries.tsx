import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { AddonView } from "@lootden/shared";
import { api } from "../api";
import { desktop } from "../desktop";
import { Card, Field, Pill, Toggle } from "./SettingsUi";

/** Profile: connect store accounts (Steam, GOG, Epic...) so their games show in the Library. */
export function GameLibraries({ admin }: { admin: boolean }) {
  const [list, setList] = useState<AddonView[] | null>(null);
  const [params, setParams] = useSearchParams();
  // Back from Sign in with Steam: ?steam=<what happened> or ?steamError=<why not>.
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(() => {
    const ok = params.get("steam");
    const bad = params.get("steamError");
    return ok ? { text: ok } : bad ? { text: bad, error: true } : null;
  });
  useEffect(() => {
    api.addons().then(setList, (e: Error) => setMsg({ text: e.message, error: true }));
    if (params.has("steam") || params.has("steamError")) setParams({}, { replace: true });
  }, []);
  if (!list) return msg ? <p className="error">{msg.text}</p> : null;
  const shown = list.filter((a) => a.enabled || admin);
  return (
    <section className="panel game-libraries">
      <h2>Game libraries</h2>
      <p className="muted small">
        Connect your accounts on other stores and their games show up under <Link to="/library?tab=stores">Library, Other stores</Link>, next to what's on this server. Only you see your accounts and games. They're kept with your LootDen account, not on this device, so every device you sign in on gets them without entering anything again; keys and tokens are stored encrypted and never sent back to a browser.
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
  // A sign-in on the store's site (or another device) can fill fields in; show what's saved.
  const saved = JSON.stringify(acc?.config ?? {});
  useEffect(() => setConfig(acc?.config ?? {}), [saved]);
  const sharedFields = addon.fields.filter((f) => f.shared);
  const [shared, setShared] = useState<Record<string, string>>(() => Object.fromEntries(sharedFields.map((f) => [f.key, addon.sharedSet.includes(f.key) ? "********" : ""])));
  const [waiting, setWaiting] = useState(false);
  // The desktop app finishes a store sign-in in the system browser: look for the result for a few minutes.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const t = window.setInterval(() => {
      if (Date.now() - started > 5 * 60_000) return void (window.clearInterval(t), setWaiting(false));
      void api.addons().then((l) => {
        const now = l.find((a) => a.id === addon.id)?.account?.config;
        if (JSON.stringify(now ?? {}) !== saved) {
          onList(l);
          setWaiting(false);
          say(`${addon.name} linked`);
        }
      }, () => {});
    }, 3000);
    return () => window.clearInterval(t);
  }, [waiting]);
  const signIn = () =>
    run(async () => {
      const { url } = await api.addonSignIn(addon.signIn!.start);
      window.location.href = url;
      if (desktop) setWaiting(true);
      return desktop ? `Finish signing in to ${addon.name} in your browser; this page updates by itself.` : `Opening ${addon.name}…`;
    });
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
            {addon.signIn && (
              <button className="secondary" disabled={busy || waiting} onClick={signIn}>
                {waiting ? "Waiting for the browser…" : addon.signIn.label}
              </button>
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
              <input type={f.secret ? "password" : "text"} placeholder={f.shared && addon.sharedSet.includes(f.key) ? "Set by your admin for everyone; leave empty" : f.placeholder} value={config[f.key] ?? ""} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} autoComplete="off" />
            </Field>
          ))}
        </div>
      )}
      {acc && (acc.error || acc.lastSyncAt) && <p className={`small ${acc.error ? "error" : "muted"}`}>{acc.error ?? `Synced ${new Date(acc.lastSyncAt!).toLocaleString()}`}</p>}
      {admin && addon.enabled && sharedFields.length > 0 && (
        <div className="addon-shared">
          <h4>For everyone on this server</h4>
          <p className="muted small">Admins only: filled in here, people can leave it empty on their own card. Their own value still wins.</p>
          <div className="field-grid">
            {sharedFields.map((f) => (
              <Field key={f.key} label={f.label} hint={f.help}>
                <input type={f.secret ? "password" : "text"} value={shared[f.key] ?? ""} onChange={(e) => setShared({ ...shared, [f.key]: e.target.value })} autoComplete="off" />
              </Field>
            ))}
          </div>
          <button className="secondary" disabled={busy} onClick={() => run(async () => (onList(await api.setAddonShared(addon.id, shared)), `${addon.name}: saved for everyone`))}>
            Save for everyone
          </button>
        </div>
      )}
      {admin && <Toggle checked={addon.enabled} onChange={(v) => run(async () => (onList(await api.setAddonEnabled(addon.id, v)), `${addon.name} ${v ? "switched on" : "switched off"} for everyone`))} label="Available on this server" hint="Admins only: switching it off hides it and its games for everyone" />}
    </Card>
  );
}
