import { useEffect, useRef, useState } from "react";
import { DECK_LABELS, PROTON_LABELS, type GameCompat, type SaveBackup } from "@lootden/shared";
import { api, formatBytes, formatMoney, type HomeAssistantState, type WishPrices } from "../api";
import { bridgeError, desktop, type StoreSavesState } from "../desktop";

/** ProtonDB and Steam Deck badges for a Steam game, linking to each. */
export function CompatBadges({ steamAppId }: { steamAppId: string | number | null | undefined }) {
  const id = steamAppId == null ? "" : String(steamAppId);
  const [c, setC] = useState<GameCompat | null>(null);
  useEffect(() => {
    setC(null);
    if (/^\d+$/.test(id)) api.compat(id).then(setC, () => setC(null));
  }, [id]);
  if (!c || (!c.protondb && (!c.deck || c.deck === "unknown"))) return null;
  return (
    <p className="compat-badges">
      {c.protondb && (
        <a
          className={`badge proton-${c.protondb.tier}`}
          href={`https://www.protondb.com/app/${id}`}
          target="_blank"
          rel="noreferrer"
          title={`ProtonDB: how it runs on Linux and the Steam Deck, from ${c.protondb.reports} report${c.protondb.reports === 1 ? "" : "s"}${c.protondb.trending && c.protondb.trending !== c.protondb.tier ? `; lately ${PROTON_LABELS[c.protondb.trending]}` : ""}`}
        >
          ProtonDB {PROTON_LABELS[c.protondb.tier]}
        </a>
      )}
      {c.deck && c.deck !== "unknown" && (
        <a className={`badge deck-${c.deck}`} href={`https://store.steampowered.com/app/${id}`} target="_blank" rel="noreferrer" title="Valve's Steam Deck rating">
          {c.deck === "verified" ? "✔ " : c.deck === "playable" ? "ⓘ " : "⊘ "}
          {DECK_LABELS[c.deck]}
        </a>
      )}
    </p>
  );
}

/** Saves for another store's game: found through Ludusavi's list by the app, backed up to the server. */
export function StoreSavesPanel({ addon, id, title }: { addon: string; id: string; title: string }) {
  const [saves, setSaves] = useState<SaveBackup[] | null>(null);
  const [here, setHere] = useState<StoreSavesState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const load = () => api.storeSaves(addon, id).then(setSaves, () => setSaves([]));
  useEffect(() => {
    void load();
    desktop?.storeSaves?.(addon, id, title).then(setHere, () => setHere(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addon, id]);
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const m = await fn();
      if (m) setMsg({ text: m });
      await load();
    } catch (e) {
      setMsg({ text: bridgeError(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  if (!saves) return null;
  if (!saves.length && !here?.locations.length) return null;
  const base = `/api/store-games/${encodeURIComponent(addon)}/${encodeURIComponent(id)}/saves`;
  return (
    <section className="panel saves">
      <h2>Saves</h2>
      {here ? (
        here.locations.length ? (
          <p className="muted small">
            From Ludusavi's list{here.name && here.name !== title ? ` (as ${here.name})` : ""}: {here.found ? `found in ${here.found} place${here.found === 1 ? "" : "s"} on this PC` : "nothing on this PC yet"}.
            {here.auto ? " They're backed up when you close the game after starting it from LootDen." : ""}
          </p>
        ) : (
          <p className="muted small">Ludusavi's list doesn't know where this game keeps its saves.</p>
        )
      ) : (
        <p className="muted small">The LootDen app finds this game's saves through Ludusavi's list and backs them up; backups are private to you, the last 10 kept.</p>
      )}
      {here?.locations.length ? (
        <details className="small">
          <summary>Where it looks</summary>
          <ul>
            {here.locations.map((l) => (
              <li key={l}>
                <code>{l}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {msg && <p className={msg.error ? "error" : "notice"}>{msg.text}</p>}
      <div className="inline">
        {desktop?.backupStoreSaves && !!here?.found && (
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await desktop!.backupStoreSaves!(addon, id, title);
                return `Backed up ${formatBytes(r.size)} from ${r.files} place${r.files === 1 ? "" : "s"}.`;
              })
            }
          >
            Back up now
          </button>
        )}
        <button disabled={busy} onClick={() => file.current?.click()}>
          Upload a zip
        </button>
        <input
          ref={file}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void run(async () => (await api.uploadStoreSave(addon, id, f), "Uploaded."));
          }}
        />
      </div>
      {saves.length > 0 && (
        <table className="table">
          <tbody>
            {saves.map((s) => (
              <tr key={s.id}>
                <td>{new Date(s.createdAt).toLocaleString()}</td>
                <td className="muted">{s.device ?? ""}</td>
                <td className="num">{formatBytes(s.size)}</td>
                <td className="actions">
                  {desktop?.restoreStoreSaves && !!here?.locations.length && s.device !== "Web upload" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const r = await desktop!.restoreStoreSaves!(addon, id, title, s.id);
                          return r ? `Restored. What was there before is kept in ${r.previous}` : undefined;
                        })
                      }
                    >
                      Restore
                    </button>
                  )}
                  <a className="button" href={`${base}/${s.id}?title=${encodeURIComponent(title)}`} download>
                    Download
                  </a>
                  <button className="danger" disabled={busy} onClick={() => confirm("Delete this backup?") && void run(async () => void (await api.deleteStoreSave(addon, id, s.id)))}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The wishlist's price line for one game: cheapest shop now, lowest ever, and a target price. */
export function WishPriceLine({ wishId, data, canEdit, onChange }: { wishId: number; data: WishPrices; canEdit: boolean; onChange: (d: WishPrices) => void }) {
  const p = data.prices.find((x) => x.wishId === wishId);
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState("");
  if (!data.enabled) return null;
  if (!p?.checkedAt) return <small className="muted">Price not checked yet</small>;
  if (p.price == null) return <small className="muted">{p.error ?? "No price found"}</small>;
  return (
    <span className="wish-price">
      <a href={p.url ?? p.itadUrl ?? "#"} target="_blank" rel="noreferrer" className={p.cut > 0 ? "price on-sale" : "price"}>
        {formatMoney(p.price, p.currency)}
        {p.cut > 0 && <span className="badge sale">−{p.cut}%</span>}
      </a>
      <small className="muted">
        {p.shop ? `at ${p.shop}` : ""}
        {p.low != null ? ` · lowest ${formatMoney(p.low, p.currency)}` : ""}
        {p.target != null ? ` · alert at ${formatMoney(p.target, p.currency)}` : ""}
      </small>
      {canEdit &&
        (editing ? (
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              void api.setWishTarget(wishId, target.trim() ? Number(target) : null).then((d) => (onChange(d), setEditing(false)));
            }}
          >
            <input type="number" min={0} step="0.01" value={target} placeholder="Price" aria-label="Alert at this price or less" style={{ width: "6rem" }} onChange={(e) => setTarget(e.target.value)} />
            <button className="small">Save</button>
          </form>
        ) : (
          <button className="ghost small" onClick={() => (setTarget(p.target != null ? String(p.target) : ""), setEditing(true))}>
            {p.target != null ? "Change alert" : "Alert me at…"}
          </button>
        ))}
      {p.itadUrl && (
        <a className="small muted" href={p.itadUrl} target="_blank" rel="noreferrer">
          Price history
        </a>
      )}
    </span>
  );
}

/** Admin: the IsThereAnyDeal key and when to send sale alerts. */
export function PriceSettingsPanel({ data, onChange }: { data: WishPrices; onChange: (d: WishPrices) => void }) {
  const s = data.settings!;
  const [key, setKey] = useState(s.apiKey);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = (patch: Parameters<typeof api.savePriceSettings>[0]) =>
    api.savePriceSettings(patch).then(
      (d) => (onChange(d), setMsg(null)),
      (e: Error) => setMsg({ text: e.message, error: true }),
    );
  return (
    <details className="panel price-settings" open={!s.hasKey}>
      <summary>
        <strong>Prices and sale alerts</strong> <span className="muted small">{s.hasKey ? `IsThereAnyDeal, ${s.country}` : "off"}</span>
      </summary>
      <p className="muted small">
        Get a free API key at <a href="https://isthereanydeal.com/apps/my/" target="_blank" rel="noreferrer">isthereanydeal.com/apps/my</a> (sign in, Register an app, copy the API key). Prices are checked twice a day; alerts go to the bell and to Apprise when "A wishlist game is on sale" is on under Settings, Notifications.
      </p>
      <form
        className="inline wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ apiKey: key });
        }}
      >
        <input type="password" value={key} placeholder="IsThereAnyDeal API key" aria-label="IsThereAnyDeal API key" onChange={(e) => setKey(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
        <button>Save key</button>
        <label className="inline">
          Country
          <input defaultValue={s.country} maxLength={2} style={{ width: "3.5rem", textTransform: "uppercase" }} onBlur={(e) => e.target.value !== s.country && void save({ country: e.target.value })} />
        </label>
      </form>
      <div className="inline wrap">
        <label className="check">
          <input type="checkbox" checked={s.atLow} onChange={(e) => void save({ atLow: e.target.checked })} /> Alert when a game hits its lowest price ever
        </label>
        <label className="inline">
          Alert at
          <input type="number" min={0} max={99} defaultValue={s.minCut || ""} placeholder="off" style={{ width: "4.5rem" }} onBlur={(e) => void save({ minCut: Number(e.target.value) || 0 })} />% off or more
        </label>
        {s.hasKey && (
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              api
                .checkPrices()
                .then(
                  (d) => (onChange(d), setMsg({ text: `Checked ${d.checked} game${d.checked === 1 ? "" : "s"}; ${d.onSale} on sale.` })),
                  (e: Error) => setMsg({ text: e.message, error: true }),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Checking…" : "Check prices now"}
          </button>
        )}
      </div>
      <p className="muted small">Each game can also have its own alert price ("Alert me at…").</p>
      {msg && <p className={msg.error ? "error" : "notice"}>{msg.text}</p>}
    </details>
  );
}

/** Settings, Home Assistant: an MQTT broker, with sensors that set themselves up. */
export function HomeAssistantSection({ say }: { say: (m: string, error?: boolean) => void }) {
  const [s, setS] = useState<HomeAssistantState | null>(null);
  const [form, setForm] = useState<Partial<HomeAssistantState>>({});
  useEffect(() => {
    api.homeAssistant().then((x) => (setS(x), setForm(x)), (e: Error) => say(e.message, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!s) return <p className="muted">Loading…</p>;
  const save = (patch: Partial<HomeAssistantState>) =>
    api.saveHomeAssistant(patch).then(
      (x) => (setS(x), setForm(x), say(x.enabled ? (x.connected ? "Connected to the broker." : `Saved, but not connected${x.error ? `: ${x.error}` : ""}`) : "Saved.", x.enabled && !x.connected)),
      (e: Error) => say(e.message, true),
    );
  const field = (k: keyof HomeAssistantState, label: string, extra: Record<string, unknown> = {}) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input value={String(form[k] ?? "")} onChange={(e) => setForm({ ...form, [k]: e.target.value })} {...extra} />
    </label>
  );
  return (
    <section className="panel">
      <p className="muted small">
        LootDen publishes sensors to Home Assistant through an MQTT broker (the Mosquitto add-on works): one per person with the game they're playing, plus games in the library, people playing, PCs online and downloads running. With MQTT discovery on (the default) they appear under a LootDen device by themselves, ready for automations like dimming the lights when a game starts.
      </p>
      <p className="small">
        Status:{" "}
        {s.enabled ? (s.connected ? <strong className="good">connected</strong> : <strong className="error">not connected{s.error ? ` (${s.error})` : ""}</strong>) : <span className="muted">off</span>}
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ ...form, enabled: true });
        }}
      >
        {field("url", "Broker address", { placeholder: "mqtt://192.168.1.10:1883" })}
        <div className="inline wrap">
          {field("username", "User name")}
          {field("password", "Password", { type: "password" })}
        </div>
        <div className="inline wrap">
          {field("prefix", "Topic prefix")}
          {field("discovery", "Discovery prefix")}
        </div>
        <div className="inline">
          <button className="primary">{s.enabled ? "Save and reconnect" : "Switch on"}</button>
          {s.enabled && (
            <>
              <button type="button" onClick={() => void api.testHomeAssistant().then((x) => (setS(x), say("Sent the sensors again.")), (e: Error) => say(e.message, true))}>
                Send now
              </button>
              <button type="button" className="ghost" onClick={() => void save({ enabled: false })}>
                Switch off
              </button>
            </>
          )}
        </div>
      </form>
    </section>
  );
}
