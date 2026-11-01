import { useEffect, useState } from "react";
import type { User } from "@lootden/shared";
import { api, avatarUrl, type DenDutyView } from "../api";
import { Card, Field, Pill, Toggle } from "./SettingsUi";

type Msg = (m: string, error?: boolean) => void;

/**
 * Settings, Den Duty: link LootDen to Den Duty, the family's chore tracker. Time-outs there can
 * lock games here, games can wait until chores are done, and game time bought in Den Duty's shop
 * turns into bonus time here by itself.
 */
export function DenDutySection({ say }: { say: Msg }) {
  const [v, setV] = useState<DenDutyView | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.denDuty().then(setV, (e: Error) => say(e.message, true));
    api.users().then(setUsers, () => {});
  }, []);
  if (!v) return <p className="muted">Loading…</p>;

  const save = async (patch: Parameters<typeof api.saveDenDuty>[0], done = "Saved") => {
    setBusy(true);
    try {
      const next = await api.saveDenDuty(patch);
      setV(next);
      setToken("");
      say(next.error ? next.error : done, !!next.error);
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card
        title="Link Den Duty"
        description={
          <>
            Den Duty is the family's chore tracker. In Den Duty, open Settings, Home Assistant and API tokens, make a <strong>control</strong> token and copy your home id. LootDen checks Den Duty every
            minute.
          </>
        }
        status={v.connected ? <Pill tone="good">Linked</Pill> : v.error ? <Pill tone="bad">Not reachable</Pill> : <Pill tone="muted">Not linked</Pill>}
        actions={
          <>
            {v.hasToken && (
              <button className="button ghost" disabled={busy} onClick={() => void save({ token: null }, "Unlinked Den Duty")}>
                Unlink
              </button>
            )}
            <button
              className="button"
              disabled={busy || !v.hasToken}
              onClick={async () => {
                setBusy(true);
                try {
                  const next = await api.syncDenDuty();
                  setV(next);
                  say(next.error ?? "Den Duty answered", !!next.error);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Check now
            </button>
            <button className="button primary" disabled={busy} onClick={() => void save({ url: v.url, homeId: v.homeId, ...(token.trim() ? { token: token.trim() } : {}) }, "Linked Den Duty")}>
              Save
            </button>
          </>
        }
      >
        <Field label="Den Duty's address" hint="Like http://192.168.1.10:8081 or https://chores.example.com">
          <input value={v.url} onChange={(e) => setV({ ...v, url: e.target.value })} placeholder="http://den-duty:8080" />
        </Field>
        <Field label="Home id" hint="From Den Duty's API tokens page. Pasting a Den Duty link with /homes/… in it works too.">
          <input value={v.homeId} onChange={(e) => setV({ ...v, homeId: e.target.value })} />
        </Field>
        <Field label="Control token" hint={v.hasToken ? "Saved. Paste a new one to replace it." : "Starts with dnk_"}>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={v.hasToken ? "••••••••" : "dnk_…"} autoComplete="off" />
        </Field>
        {v.lastSyncAt && <p className="muted small">Last checked {new Date(v.lastSyncAt).toLocaleTimeString()}</p>}
      </Card>

      {v.connected && (
        <>
          <Card title="Who is who" description="Match each LootDen profile to the same kid in Den Duty.">
            {users
              .filter((u) => u.kidMode || u.role !== "admin")
              .map((u) => (
                <label key={u.id} className="toggle-row">
                  <span style={{ display: "flex", alignItems: "center", gap: "0.5em" }}>
                    <img src={avatarUrl(u.avatar)} alt="" width={26} height={26} className="avatar" />
                    {u.displayName}
                  </span>
                  <select
                    value={v.kids[String(u.id)] ?? ""}
                    disabled={busy}
                    onChange={(e) => {
                      const kids = { ...v.kids };
                      if (e.target.value) kids[String(u.id)] = e.target.value;
                      else delete kids[String(u.id)];
                      void save({ kids }, "Saved");
                    }}
                  >
                    <option value="">Not in Den Duty</option>
                    {v.denKids.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
          </Card>
          <Card title="What the link does">
            <Toggle
              checked={v.locks}
              disabled={busy}
              onChange={(locks) => void save({ locks })}
              label="Time-outs lock games"
              hint="A Den Duty time-out set to lock games stops them here, and closes a game that's running (after a minute's warning). “Lock Roblox” only stops Roblox."
            />
            <Toggle
              checked={v.choresFirst}
              disabled={busy}
              onChange={(choresFirst) => void save({ choresFirst })}
              label="Chores first"
              hint="Games stay closed until today's chores are done in Den Duty. Chores waiting for a grown-up's OK count as done."
            />
            <Toggle
              checked={v.gameTime}
              disabled={busy}
              onChange={(gameTime) => void save({ gameTime })}
              label="Game time from the shop"
              hint="Rewards in Den Duty's shop with game minutes become bonus time here when a kid buys them, and show as handed over in Den Duty."
            />
          </Card>
          {v.goals.length > 0 && (
            <Card title="Family goals reached" description="Reached goals can unlock a family game night (Library, Game night).">
              <ul className="plain-list">
                {v.goals.map((g) => (
                  <li key={g.id}>
                    {g.icon} {g.title}
                    {g.reward ? ` · ${g.reward}` : ""} <span className="muted small">{new Date(g.reachedAt).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </>
  );
}
