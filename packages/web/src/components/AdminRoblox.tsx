import { useEffect, useState } from "react";
import type { RobloxGame, User } from "@lootden/shared";
import { api, avatarUrl } from "../api";
import { Card, Pill } from "./SettingsUi";

type Msg = (m: string, error?: boolean) => void;

/** Who sees a Roblox game: everyone, or the profiles ticked. */
function PeoplePicker({ users, everyone, userIds, disabled, onChange }: { users: User[]; everyone: boolean; userIds: number[]; disabled?: boolean; onChange: (a: { everyone: boolean; userIds: number[] }) => void }) {
  return (
    <div className="roblox-people" role="group" aria-label="Who sees it">
      <label className="check">
        <input type="checkbox" checked={everyone} disabled={disabled} onChange={(e) => onChange({ everyone: e.target.checked, userIds })} />
        Everyone
      </label>
      {users.map((u) => (
        <label key={u.id} className="check" title={everyone ? "Shown to everyone" : undefined}>
          <input
            type="checkbox"
            disabled={disabled || everyone}
            checked={everyone || userIds.includes(u.id)}
            onChange={(e) => onChange({ everyone, userIds: e.target.checked ? [...userIds, u.id] : userIds.filter((x) => x !== u.id) })}
          />
          <img src={avatarUrl(u.avatar)} alt="" width={22} height={22} className="avatar" />
          {u.displayName}
          {u.kidMode && <Pill tone="muted">Kid</Pill>}
        </label>
      ))}
    </div>
  );
}

/**
 * Settings, Roblox: paste a Roblox game's link, LootDen fetches its name, icon and details from
 * Roblox, and it shows in the library (under the Roblox store) for the profiles ticked. Play
 * opens it in the Roblox app on that PC, with play time limits applied.
 */
export function RobloxSection({ say }: { say: Msg }) {
  const [games, setGames] = useState<RobloxGame[] | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [input, setInput] = useState("");
  const [access, setAccess] = useState<{ everyone: boolean; userIds: number[] }>({ everyone: false, userIds: [] });
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => api.robloxGames().then(setGames, (e: Error) => say(e.message, true));
  useEffect(() => {
    void load();
    api.users().then(setUsers, () => {});
  }, []);

  /** Runs an action; the message is what it returns, else `done`. */
  const run = async (key: string, fn: () => Promise<unknown>, done = "") => {
    setBusy(key);
    try {
      const r = await fn();
      say(typeof r === "string" ? r : done);
      await load();
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  // Ticks save straight away, shown at once.
  const saveAccess = (g: RobloxGame, a: { everyone: boolean; userIds: number[] }) => {
    setGames((list) => list?.map((x) => (x.universeId === g.universeId ? { ...x, ...a } : x)) ?? null);
    api.setRobloxAccess(g.universeId, a).catch((e: Error) => (say(e.message, true), void load()));
  };

  return (
    <>
      <Card
        title="Add a Roblox game"
        description={
          <>
            Paste the game's address from roblox.com (like <code>roblox.com/games/920587237/Adopt-Me</code>) or its place ID. LootDen gets its name, icon and details from Roblox, and it shows in the
            Library under Roblox for the people you tick. Play opens it in the Roblox app on that PC, signed in to whichever Roblox account the PC uses, and counts against their play time.
          </>
        }
      >
        <form
          className="inline wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim()) return;
            void run("add", async () => {
              const g = await api.addRobloxGame(input.trim(), access);
              setInput("");
              return `Added ${g.name}`;
            });
          }}
        >
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://www.roblox.com/games/…" aria-label="Roblox game link or place ID" style={{ flex: 1, minWidth: "16rem" }} />
          <button className="primary" disabled={busy === "add" || !input.trim()}>
            {busy === "add" ? "Looking it up…" : "Add game"}
          </button>
        </form>
        <p className="muted small">Who sees it:</p>
        <PeoplePicker users={users} everyone={access.everyone} userIds={access.userIds} onChange={setAccess} />
      </Card>

      <Card title="Roblox games" description="Untick someone to take a game off their library. Kids only see the games ticked for them here, whatever Roblox's age recommendation says.">
        {games === null ? (
          <p className="muted">Loading…</p>
        ) : games.length === 0 ? (
          <p className="muted">No Roblox games yet.</p>
        ) : (
          <ul className="roblox-admin-list">
            {games.map((g) => (
              <li key={g.universeId} className="roblox-admin-row">
                {g.iconUrl ? <img src={g.iconUrl} alt="" width={72} height={72} className="roblox-icon" /> : <span className="roblox-icon cover-placeholder" />}
                <div className="roblox-admin-info">
                  <strong>{g.name}</strong>
                  <span className="muted small">{[g.creator && `By ${g.creator}`, g.genre, g.ageRating, `Place ${g.placeId}`].filter(Boolean).join(" · ")}</span>
                  <PeoplePicker users={users} everyone={g.everyone} userIds={g.userIds} disabled={busy === g.universeId} onChange={(a) => saveAccess(g, a)} />
                  {!g.everyone && g.userIds.length === 0 && <span className="muted small">Nobody sees this one yet.</span>}
                </div>
                <div className="inline">
                  <a className="button small ghost" href={`https://www.roblox.com/games/${g.placeId}`} target="_blank" rel="noreferrer">
                    Roblox page
                  </a>
                  <button className="small secondary" disabled={!!busy} onClick={() => run(g.universeId, () => api.refreshRobloxGame(g.universeId), `Updated ${g.name} from Roblox`)}>
                    ⟳ Refresh
                  </button>
                  <button
                    className="small danger"
                    disabled={!!busy}
                    onClick={() => {
                      if (confirm(`Remove ${g.name} from LootDen? It leaves everyone's library.`)) void run(g.universeId, () => api.removeRobloxGame(g.universeId), `Removed ${g.name}`);
                    }}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
