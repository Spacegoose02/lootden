import { useEffect, useState } from "react";
import { secondsLeft, type Allowance, type PlayLimits, type TimeRequest, type User } from "@lootden/shared";
import { api, formatMinutes, type FamilySettings } from "../api";
import { Card, Field, Toggle } from "./SettingsUi";

/** A ring that empties as today's play time runs out. */
function TimeRing({ a }: { a: Allowance }) {
  const total = a.allowedSeconds ?? 0;
  const left = a.remainingSeconds ?? 0;
  const share = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
  const tone = !a.canPlay ? "out" : share < 0.15 ? "low" : "ok";
  return (
    <svg className={`time-ring time-ring-${tone}`} viewBox="0 0 42 42" width="92" height="92" aria-hidden="true">
      <circle cx="21" cy="21" r="17" className="time-ring-track" />
      <circle cx="21" cy="21" r="17" className="time-ring-fill" strokeDasharray={`${share * 106.8} 106.8`} transform="rotate(-90 21 21)" />
    </svg>
  );
}

/** Today's play time for someone with limits, and a way to ask for more. Nothing when there are no limits. */
export function PlayTimeCard({ compact = false }: { compact?: boolean }) {
  const [a, setA] = useState<Allowance | null>(null);
  const [mine, setMine] = useState<TimeRequest[]>([]);
  const [asking, setAsking] = useState(false);
  const [minutes, setMinutes] = useState(15);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const load = () => {
    api.allowance().then(setA, () => setA(null));
    api.timeRequests().then(setMine, () => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (!a?.limited) return null;
  const pending = mine.find((r) => r.state === "pending" && r.date === a.date);
  const left = secondsLeft(a);
  const ask = async () => {
    setError("");
    try {
      await api.askForTime(minutes, note.trim() || null);
      setAsking(false);
      setNote("");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className={`panel playtime-card${compact ? " compact" : ""}${a.canPlay ? "" : " is-out"}`} aria-label="Play time today" data-nav-zone>
      {a.allowedSeconds !== null ? <TimeRing a={a} /> : <span className="playtime-moon" aria-hidden="true">{a.bedtimeNow ? "🌙" : "🕹️"}</span>}
      <div className="playtime-main">
        <p className="eyebrow">Play time today</p>
        <h2>
          {!a.canPlay ? (a.bedtimeNow ? "Bedtime 🌙" : "Time's up!") : left !== null ? `${formatMinutes(left)} left` : "Play on!"}
        </h2>
        <p className="muted small">
          {[
            a.allowedSeconds !== null ? `${formatMinutes(a.usedSeconds)} of ${formatMinutes(a.allowedSeconds)} played` : `${formatMinutes(a.usedSeconds)} played`,
            a.bonusSeconds ? `includes ${formatMinutes(a.bonusSeconds)} bonus` : null,
            a.bedtime ? `bedtime ${a.bedtime.from} to ${a.bedtime.to}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {!a.canPlay && a.reason && <p className="small">{a.reason}</p>}
        {pending ? (
          <p className="notice small">Asked for {pending.minutes} more minutes. Waiting for a grown-up…</p>
        ) : a.bedtimeNow ? null : asking ? (
          <form
            className="inline wrap"
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <div className="segmented" role="radiogroup" aria-label="How many minutes">
              {[15, 30, 60].map((m) => (
                <button type="button" key={m} role="radio" aria-checked={minutes === m} className={minutes === m ? "active" : ""} onClick={() => setMinutes(m)}>
                  +{m} min
                </button>
              ))}
            </div>
            <input placeholder="Why? (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Why" maxLength={200} />
            <button className="primary">Ask</button>
            <button type="button" className="ghost" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button className="secondary small" onClick={() => setAsking(true)}>
            ⏱️ Ask for more time
          </button>
        )}
        {error && <p className="error small">{error}</p>}
      </div>
    </section>
  );
}

/** Admins: bonus time asks from today and the last week, with yes and no. */
export function TimeRequestsAdmin() {
  const [list, setList] = useState<TimeRequest[] | null>(null);
  const [error, setError] = useState("");
  const load = () => api.timeRequests().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!list?.length) return error ? <p className="error">{error}</p> : null;
  return (
    <section className="panel time-requests">
      <h2>Bonus time</h2>
      {error && <p className="error small">{error}</p>}
      <ul className="list">
        {list.map((r) => (
          <li key={r.id} className={`time-request state-${r.state}`}>
            <span>
              <strong>{r.name}</strong> asked for <strong>{r.minutes} minutes</strong>
              {r.note ? <span className="muted"> · “{r.note}”</span> : null}
              <small className="muted"> · {new Date(r.createdAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</small>
            </span>
            {r.state === "pending" ? (
              <span className="inline">
                <button className="primary small" onClick={() => run(() => api.approveTime(r.id))}>
                  Yes
                </button>
                {r.minutes > 10 && (
                  <button className="secondary small" onClick={() => run(() => api.approveTime(r.id, Math.max(5, Math.round(r.minutes / 2))))}>
                    Half
                  </button>
                )}
                <button className="ghost small" onClick={() => run(() => api.declineTime(r.id))}>
                  No
                </button>
              </span>
            ) : (
              <span className={`pill ${r.state === "approved" ? "good" : "muted"}`}>{r.state === "approved" ? "Granted" : "Not today"}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const DAY_OPTIONS = [null, 30, 45, 60, 90, 120, 180, 240];

/** Admins, per profile: daily minutes on school days and weekends, bedtime, closing the game, and bonus time now. */
export function PlayLimitsEditor({ user, say }: { user: User; say: (m: string, error?: boolean) => void }) {
  const [l, setL] = useState<PlayLimits | null>(null);
  const [a, setA] = useState<Allowance | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.userLimits(user.id).then((r) => (setL(r.limits), setA(r.allowance)), (e: Error) => say(e.message, true));
  }, [user.id]);
  if (!l) return <p className="muted small browser-rules">Loading…</p>;
  const save = async (next: PlayLimits) => {
    setBusy(true);
    try {
      const r = await api.saveUserLimits(user.id, next);
      setL(r.limits);
      setA(r.allowance);
      say("Saved");
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const give = async (m: number) => {
    try {
      setA((await api.giveTime(user.id, m)).allowance);
      say(`Gave ${user.displayName} ${m} more minutes today`);
    } catch (e) {
      say((e as Error).message, true);
    }
  };
  const minutes = (key: "weekdayMinutes" | "weekendMinutes", label: string) => (
    <Field label={label}>
      <select value={l[key] ?? ""} disabled={busy} onChange={(e) => void save({ ...l, [key]: e.target.value === "" ? null : Number(e.target.value) })}>
        {DAY_OPTIONS.map((m) => (
          <option key={m ?? "none"} value={m ?? ""}>
            {m === null ? "No limit" : formatMinutes(m * 60)}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <div className="browser-rules play-limits">
      <div className="inline wrap">
        {minutes("weekdayMinutes", "Monday to Friday")}
        {minutes("weekendMinutes", "Weekends")}
        <Field label="Bedtime" hint="No games between these times">
          <span className="inline">
            <input type="time" value={l.bedtime?.from ?? ""} disabled={busy} onChange={(e) => void save({ ...l, bedtime: e.target.value ? { from: e.target.value, to: l.bedtime?.to ?? "07:00" } : null })} aria-label="Bedtime starts" />
            <span className="muted">to</span>
            <input type="time" value={l.bedtime?.to ?? ""} disabled={busy || !l.bedtime} onChange={(e) => void save({ ...l, bedtime: l.bedtime ? { ...l.bedtime, to: e.target.value || "07:00" } : null })} aria-label="Bedtime ends" />
          </span>
        </Field>
      </div>
      <Toggle
        checked={l.hardStop}
        disabled={busy}
        onChange={(v) => void save({ ...l, hardStop: v })}
        label="Close the game when time's up"
        hint="The LootDen app gives heads-ups at 10, 5 and 1 minute, then a minute to save. Off: only the heads-ups. Emulated games and other stores' games only get the heads-ups."
      />
      {a && a.limited && (
        <p className="muted small">
          Today: {formatMinutes(a.usedSeconds)} played
          {a.allowedSeconds !== null ? `, ${formatMinutes(a.remainingSeconds ?? 0)} left` : ""}
          {a.bonusSeconds ? ` (with ${formatMinutes(a.bonusSeconds)} bonus)` : ""}.{" "}
          <span className="inline">
            Give bonus time:
            {[15, 30, 60].map((m) => (
              <button key={m} type="button" className="ghost small" onClick={() => void give(m)}>
                +{m} min
              </button>
            ))}
          </span>
        </p>
      )}
    </div>
  );
}

/** Admins: the household's time zone (days, weeks, bedtimes) and save slots on shared PCs. */
export function FamilySettingsCard({ say }: { say: (m: string, error?: boolean) => void }) {
  const [s, setS] = useState<FamilySettings | null>(null);
  const [tz, setTz] = useState("");
  useEffect(() => {
    api.familySettings().then((x) => (setS(x), setTz(x.timeZone)), () => {});
  }, []);
  if (!s) return null;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const save = async (patch: Partial<FamilySettings>) => {
    try {
      const x = await api.saveFamilySettings(patch);
      setS(x);
      setTz(x.timeZone);
      say("Saved");
    } catch (e) {
      say((e as Error).message, true);
    }
  };
  return (
    <Card title="Family" description="Play time limits and bedtimes are set per profile (Play time, under Profiles). Days, weeks and bedtimes follow this time zone.">
      <form
        className="inline wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ timeZone: tz });
        }}
      >
        <Field label="Household time zone" hint={`In use: ${s.effectiveTimeZone}${s.timeZone ? "" : " (the server's)"}`}>
          <input value={tz} placeholder={s.effectiveTimeZone} onChange={(e) => setTz(e.target.value)} />
        </Field>
        <button>Save</button>
        {browserTz && browserTz !== s.effectiveTimeZone && (
          <button type="button" className="ghost" onClick={() => void save({ timeZone: browserTz })}>
            Use {browserTz}
          </button>
        )}
      </form>
      <Toggle
        checked={s.separateSaves}
        onChange={(v) => void save({ separateSaves: v })}
        label="Separate saves for each profile on shared PCs"
        hint="Before a game starts, the LootDen app puts the last player's saves aside and brings back yours (games with a save location set). Nobody plays over anyone else's progress."
      />
    </Card>
  );
}
