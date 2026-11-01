import { useEffect, useState } from "react";
import {
  HELPER_ANSWER_LENGTHS,
  HELPER_AVATAR,
  HELPER_EFFORTS,
  HELPER_MAX_SEARCHES_LIMIT,
  HELPER_MODELS,
  HELPER_NAME,
  HELPER_SEARCH_PRICE,
  type HelperAnswerLength,
  type HelperEffort,
  type HelperSettings,
  type HelperSettingsView,
  type HelperUsageReport,
  KID_HELPER_SITES,
} from "@lootden/shared";
import { api, avatarUrl } from "../api";
import { Card, Field, Pill, Toggle } from "./SettingsUi";
import { HELPER_CHANGED } from "./Bandit";

type Msg = (m: string, error?: boolean) => void;

const money = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

const EFFORT_LABELS: Record<HelperEffort, string> = { low: "Quick", medium: "Balanced", high: "Deep" };
const LENGTH_LABELS: Record<HelperAnswerLength, string> = { short: "Short", medium: "Medium", long: "Long" };

/** Settings, Bandit: the AI provider, its model and costs, the household's limits and budget, and who may use him. */
export function HelperSection({ say }: { say: Msg }) {
  const [view, setView] = useState<HelperSettingsView | null>(null);
  const [draft, setDraft] = useState<HelperSettings | null>(null);
  const [usage, setUsage] = useState<HelperUsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const loadUsage = () => void api.helperUsage().then(setUsage, (e: Error) => say(e.message, true));
  useEffect(() => {
    api.helperSettings().then((v) => {
      setView(v);
      setDraft(v.settings);
    }, (e: Error) => say(e.message, true));
    loadUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!view || !draft) return <p className="muted">Loading…</p>;
  const set = (patch: Partial<HelperSettings>) => setDraft({ ...draft, ...patch });
  const save = async () => {
    setBusy(true);
    try {
      const v = await api.saveHelperSettings(draft);
      setView(v);
      setDraft(v.settings);
      say("Saved");
      loadUsage();
      window.dispatchEvent(new Event(HELPER_CHANGED));
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const model = HELPER_MODELS.find((m) => m.id === draft.model) ?? HELPER_MODELS[0]!;
  // A typical question: about 3,000 tokens in (instructions and the chat so far) and a few hundred out.
  const perQuestion = (model.price.input * 3000 + model.price.output * (draft.effort === "high" ? 1500 : draft.effort === "medium" ? 800 : 400)) / 1_000_000;
  // A question that searches: one search and the results it reads (about 10,000 tokens).
  const perSearch = HELPER_SEARCH_PRICE + (model.price.input * 10_000) / 1_000_000;

  return (
    <>
      <Card
        title={`${HELPER_NAME}, the AI gaming helper`}
        description="A raccoon in the corner of every page who helps with the game you're on. Each person can switch him off in their Profile; kid profiles only get him when you switch him on below."
        status={view.paused ? <Pill tone="bad">Paused: budget used up</Pill> : view.ready ? <Pill tone="good">On</Pill> : <Pill tone="muted">{view.settings.apiKey || view.keyFromEnvironment ? "Off" : "Needs a key"}</Pill>}
        actions={
          <button className="primary" disabled={busy} onClick={() => void save()}>
            Save
          </button>
        }
      >
        <div className="inline">
          <span className="bandit-box">
            <img src={avatarUrl(HELPER_AVATAR)} alt="" width={56} height={56} />
          </span>
          <div className="toggle-list" style={{ flex: 1 }}>
            <Toggle checked={draft.enabled} onChange={(v) => set({ enabled: v })} label={`${HELPER_NAME} is on`} hint="Off hides him for everyone, without losing these settings." />
          </div>
        </div>
        <div className="field-grid">
          <Field
            label="Anthropic API key"
            hint={
              <>
                {view.keyFromEnvironment ? "Set by ANTHROPIC_API_KEY on the server; a key here wins. " : "Kept encrypted on the server and never sent back. "}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                  Get a key
                </a>
                . Set a spend limit on the key there too, as a backstop.
              </>
            }
          >
            <input type="password" autoComplete="off" value={draft.apiKey} placeholder={view.keyFromEnvironment ? "From the environment" : "sk-ant-…"} onChange={(e) => set({ apiKey: e.target.value })} />
          </Field>
          <Field label="Model" hint={`${model.note}. $${model.price.input} per million tokens in, $${model.price.output} out.`}>
            <select value={draft.model} onChange={(e) => set({ model: e.target.value })}>
              {HELPER_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}: {m.note}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Thinking" hint="How hard the model thinks before answering. Deeper is smarter on tricky questions, slower and costs more.">
            <div className="segmented" role="radiogroup" aria-label="Thinking">
              {HELPER_EFFORTS.map((e) => (
                <button key={e} type="button" role="radio" aria-checked={draft.effort === e} className={draft.effort === e ? "active" : ""} onClick={() => set({ effort: e })}>
                  {EFFORT_LABELS[e]}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Longest answer" hint={`At most ${HELPER_ANSWER_LENGTHS[draft.answerLength].toLocaleString()} tokens per answer, thinking included. Caps what one answer can cost.`}>
            <div className="segmented" role="radiogroup" aria-label="Longest answer">
              {(Object.keys(HELPER_ANSWER_LENGTHS) as HelperAnswerLength[]).map((l) => (
                <button key={l} type="button" role="radio" aria-checked={draft.answerLength === l} className={draft.answerLength === l ? "active" : ""} onClick={() => set({ answerLength: l })}>
                  {LENGTH_LABELS[l]}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Questions a day, grown-ups" hint="Per person. 0 for no limit.">
            <input type="number" min={0} max={10000} value={draft.dailyLimit} onChange={(e) => set({ dailyLimit: Number(e.target.value) })} />
          </Field>
          <Field label="Questions a day, kids" hint="Per kid profile. 0 for no limit.">
            <input type="number" min={0} max={10000} value={draft.kidDailyLimit} onChange={(e) => set({ kidDailyLimit: Number(e.target.value) })} />
          </Field>
          <Field label="Monthly budget (US dollars)" hint={`${HELPER_NAME} pauses for everyone once this month's estimated cost reaches it, and comes back on the 1st. 0 for no budget. A typical question costs about ${money(perQuestion)} with these settings${draft.webSearch ? `, or about ${money(perQuestion + perSearch)} when it searches` : ""}.`}>
            <input type="number" min={0} step={0.5} value={draft.monthlyBudget} onChange={(e) => set({ monthlyBudget: Number(e.target.value) })} />
          </Field>
          <Field label="Web searches per question" hint={`Up to this many searches for one question; each costs about ${money(HELPER_SEARCH_PRICE)}, plus the reading. Pages come from search results, pasted links and the game's store page.`}>
            <input type="number" min={1} max={HELPER_MAX_SEARCHES_LIMIT} value={draft.maxSearches} disabled={!draft.webSearch} onChange={(e) => set({ maxSearches: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="toggle-list">
          <Toggle
            checked={draft.webSearch}
            onChange={(v) => set({ webSearch: v })}
            label="Search the web and read links"
            hint={`So ${HELPER_NAME} knows about new games, DLC and patches, and can open links people paste, instead of only what the AI learned in training. He shows his sources.`}
          />
          <Toggle
            checked={draft.kidsWebSearch}
            disabled={!draft.webSearch}
            onChange={(v) => set({ kidsWebSearch: v })}
            label="Let kids' questions search too"
            hint={`Only on game sites made safe for kids: ${KID_HELPER_SITES.slice(0, 6).join(", ")} and a few more. Kids don't see links.`}
          />
        </div>
      </Card>
      {usage && <HelperUsage usage={usage} say={say} reload={loadUsage} />}
    </>
  );
}

function HelperUsage({ usage, say, reload }: { usage: HelperUsageReport; say: Msg; reload: () => void }) {
  const [limits, setLimits] = useState<Record<number, string>>({});
  const monthName = new Date(`${usage.month}-15T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const share = usage.budget > 0 ? Math.min(1, usage.spent / usage.budget) : 0;
  const dayMax = Math.max(0.0001, ...usage.days.map((d) => d.cost));
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      say("Saved");
      reload();
      window.dispatchEvent(new Event(HELPER_CHANGED));
    } catch (e) {
      say((e as Error).message, true);
    }
  };
  return (
    <Card title={`Usage and cost, ${monthName}`} description="Estimated from the tokens the API reports and Anthropic's list prices. Your Anthropic bill is the final word.">
      <p style={{ margin: 0 }}>
        <strong style={{ fontSize: "1.4rem" }}>{money(usage.spent)}</strong>
        {usage.budget > 0 ? <span className="muted"> of {money(usage.budget)} budget</span> : <span className="muted"> (no monthly budget)</span>} · {usage.messages} question{usage.messages === 1 ? "" : "s"} · {usage.searches} web search{usage.searches === 1 ? "" : "es"}
      </p>
      {usage.budget > 0 && (
        <div className={`helper-budget${usage.paused ? " over" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label="Budget used">
          <span style={{ width: `${share * 100}%` }} />
        </div>
      )}
      {usage.days.length > 0 && (
        <div className="helper-days" aria-label="Cost per day this month">
          {usage.days.map((d) => (
            <span key={d.day} style={{ height: `${Math.max(4, (d.cost / dayMax) * 100)}%` }} title={`${d.day}: ${d.messages} questions, ${money(d.cost)}`} />
          ))}
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table className="helper-people">
          <thead>
            <tr>
              <th>Person</th>
              <th>Allowed</th>
              <th>Questions a day</th>
              <th>Today</th>
              <th>This month</th>
              <th>Tokens in / out</th>
              <th>Searches</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {usage.people.map((p) => (
              <tr key={p.userId}>
                <td>
                  <span className="inline">
                    <img src={avatarUrl(p.avatar)} alt="" width={28} height={28} className="avatar" />
                    {p.name}
                    {p.kid && <Pill tone="muted">Kid</Pill>}
                  </span>
                </td>
                <td>
                  <label className="switch" title={p.isDefault ? (p.kid ? "Kids start switched off" : "Grown-ups start switched on") : undefined}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`${p.name} can use ${HELPER_NAME}`}
                      checked={p.allowed}
                      onChange={(e) => void act(() => api.saveUserHelper(p.userId, { allowed: e.target.checked }))}
                    />
                    <span aria-hidden="true" />
                  </label>
                </td>
                <td>
                  <form
                    className="inline"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const v = (limits[p.userId] ?? "").trim();
                      void act(() => api.saveUserHelper(p.userId, { dailyLimit: v === "" ? null : Number(v) }));
                    }}
                  >
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      aria-label={`${p.name}'s questions a day`}
                      placeholder={p.effectiveLimit ? String(p.effectiveLimit) : "No limit"}
                      title="Blank uses the default"
                      value={limits[p.userId] ?? (p.dailyLimit === null ? "" : String(p.dailyLimit))}
                      onChange={(e) => setLimits({ ...limits, [p.userId]: e.target.value })}
                    />
                    <button className="ghost small">Set</button>
                  </form>
                </td>
                <td>
                  {p.today}
                  {p.effectiveLimit ? <span className="muted"> / {p.effectiveLimit}</span> : null}
                </td>
                <td>{p.messages}</td>
                <td className="muted">
                  {tokens(p.inputTokens)} / {tokens(p.outputTokens)}
                </td>
                <td>{p.searches}</td>
                <td>{money(p.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Blank questions a day uses the grown-up or kid default above; 0 means no limit for that person.</p>
    </Card>
  );
}
