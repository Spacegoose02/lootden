import { useEffect, useState } from "react";
import { describeLaunchStep, MAX_LAUNCH_STEPS, MAX_LAUNCH_WAIT, type GlobalLaunchScripts, type LaunchAction, type LaunchProfile, type LaunchStep } from "@lootden/shared";
import { bridgeError, desktop, type LaunchOptionsState } from "../desktop";

/** A game's launch options on this PC, and saving them. Null until loaded, or in a browser. */
export function useLaunchOptions(key: string | null) {
  const [state, setState] = useState<LaunchOptionsState | null>(null);
  const reload = async () => {
    if (!key || !desktop?.launchOptions) return;
    setState(await desktop.launchOptions(key).catch(() => null));
  };
  useEffect(() => {
    setState(null);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { state, reload };
}

const blankProfile = (): LaunchProfile => ({ actions: [], defaultAction: null, before: [], after: [] });

/** Ready-made starting points for common mod launchers. */
const TEMPLATES: Array<{ label: string; action: Omit<LaunchAction, "id"> }> = [
  { label: "Mod loader (one program)", action: { name: "With mods", steps: [{ type: "run", path: "" }] } },
  {
    label: "Start, wait, then start another (GTA V with LSPDFR)",
    action: {
      name: "LSPDFR",
      steps: [
        { type: "run", path: "PlayGTAV.exe" },
        { type: "wait", seconds: 45 },
        { type: "run", path: "RAGEPluginHook.exe" },
      ],
    },
  },
  { label: "SMAPI (Stardew Valley)", action: { name: "SMAPI", steps: [{ type: "run", path: "StardewModdingAPI.exe" }] } },
  { label: "Script that sets up, then the game", action: { name: "With setup script", steps: [{ type: "run", path: "", waitForExit: true, hidden: true }, { type: "run", path: "" }] } },
];

let idSeq = 0;
const newId = () => `a${Date.now().toString(36)}${(idSeq++).toString(36)}`;

/** Edits a list of steps: start a program, wait, close a program. */
export function StepsEditor({ steps, onChange, pickKey, label }: { steps: LaunchStep[]; onChange: (s: LaunchStep[]) => void; pickKey: string; label: string }) {
  const set = (i: number, patch: Partial<LaunchStep>) => onChange(steps.map((s, j) => (j === i ? ({ ...s, ...patch } as LaunchStep) : s)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + d, 0, s!);
    onChange(next);
  };
  const pick = async (i: number) => {
    const p = await desktop?.pickProgram?.(pickKey);
    if (p) set(i, { path: p });
  };
  return (
    <div className="launch-steps" role="group" aria-label={label}>
      {steps.length === 0 && <p className="muted small">Nothing yet.</p>}
      <ol>
        {steps.map((s, i) => (
          <li key={i} className="launch-step">
            <select value={s.type} aria-label="Kind of step" onChange={(e) => onChange(steps.map((x, j) => (j === i ? (e.target.value === "wait" ? { type: "wait", seconds: 30 } : e.target.value === "close" ? { type: "close", name: "" } : { type: "run", path: "" }) : x)))}>
              <option value="run">Start</option>
              <option value="wait">Wait</option>
              <option value="close">Close</option>
            </select>
            {s.type === "run" && (
              <>
                <input className="grow" value={s.path} placeholder="Program, script or steam:// link (inside the game's folder, or a full path)" aria-label="Program" onChange={(e) => set(i, { path: e.target.value })} />
                {desktop?.pickProgram && (
                  <button type="button" className="small" onClick={() => void pick(i)}>
                    Browse…
                  </button>
                )}
                <input value={s.args ?? ""} placeholder="Arguments" aria-label="Arguments" onChange={(e) => set(i, { args: e.target.value })} />
                <label className="check small">
                  <input type="checkbox" checked={!!s.waitForExit} onChange={(e) => set(i, { waitForExit: e.target.checked })} /> Wait until it closes
                </label>
                <label className="check small">
                  <input type="checkbox" checked={!!s.hidden} onChange={(e) => set(i, { hidden: e.target.checked })} /> No window
                </label>
              </>
            )}
            {s.type === "wait" && (
              <label className="inline small">
                <input type="number" min={1} max={MAX_LAUNCH_WAIT} value={s.seconds} aria-label="Seconds" onChange={(e) => set(i, { seconds: Number(e.target.value) })} /> seconds
              </label>
            )}
            {s.type === "close" && <input value={s.name} placeholder="Program file name, like Discord.exe" aria-label="Program to close" onChange={(e) => set(i, { name: e.target.value })} />}
            <span className="launch-step-tools">
              <button type="button" className="ghost small" disabled={i === 0} aria-label="Move up" onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" className="ghost small" disabled={i === steps.length - 1} aria-label="Move down" onClick={() => move(i, 1)}>
                ↓
              </button>
              <button type="button" className="ghost small" aria-label="Remove step" onClick={() => onChange(steps.filter((_, j) => j !== i))}>
                ✕
              </button>
            </span>
          </li>
        ))}
      </ol>
      {steps.length < MAX_LAUNCH_STEPS && (
        <div className="inline">
          <button type="button" className="small" onClick={() => onChange([...steps, { type: "run", path: "" }])}>
            + Start a program
          </button>
          <button type="button" className="small" onClick={() => onChange([...steps, { type: "wait", seconds: 30 }])}>
            + Wait
          </button>
          <button type="button" className="small" onClick={() => onChange([...steps, { type: "close", name: "" }])}>
            + Close a program
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Launch options for one game on this PC: extra ways to start it (mod loaders, a launcher that
 * needs a head start), and steps before and after it plays. Shown on game pages in the app.
 */
export function LaunchOptionsPanel({ launchKey, title, state, onSaved }: { launchKey: string; title: string; state: LaunchOptionsState; onSaved: () => void }) {
  const [draft, setDraft] = useState<LaunchProfile>(state.profile ?? blankProfile());
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(state.profile ?? blankProfile()), [state.profile]);
  const bridge = desktop;
  if (!bridge?.setLaunchOptions) return null;

  const setAction = (i: number, patch: Partial<LaunchAction>) => setDraft({ ...draft, actions: draft.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const save = async () => {
    setError("");
    setSaved(false);
    try {
      await bridge.setLaunchOptions!(launchKey, draft, title);
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(bridgeError(e));
    }
  };
  const globalCount = state.global.before.length + state.global.after.length;

  return (
    <details className="panel launch-options">
      <summary>
        <strong>Launch options on this PC</strong>
        <span className="muted small"> {draft.actions.length ? `${draft.actions.length} way${draft.actions.length === 1 ? "" : "s"} to start` : "mod loaders, waits and scripts"}</span>
      </summary>
      <p className="muted small">
        Start the game a different way, like with SMAPI or a mod launcher that needs the game to load first. Relative paths are inside <code>{state.dir ?? "the game's folder"}</code>. These stay on this PC.
      </p>

      <h4>Ways to start it</h4>
      {draft.actions.map((a, i) => (
        <div key={a.id} className="launch-action">
          <div className="inline wrap">
            <input value={a.name} aria-label="Name" placeholder="Name, like SMAPI" onChange={(e) => setAction(i, { name: e.target.value })} />
            <label className="check small">
              <input type="radio" name={`default-${launchKey}`} checked={draft.defaultAction === a.id} onChange={() => setDraft({ ...draft, defaultAction: a.id })} /> ▶ Play uses this
            </label>
            <button type="button" className="ghost small" onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, j) => j !== i), defaultAction: draft.defaultAction === a.id ? null : draft.defaultAction })}>
              Remove
            </button>
          </div>
          <StepsEditor steps={a.steps} onChange={(steps) => setAction(i, { steps })} pickKey={launchKey} label={`Steps for ${a.name}`} />
        </div>
      ))}
      {draft.actions.length > 0 && (
        <label className="check small">
          <input type="radio" name={`default-${launchKey}`} checked={!draft.defaultAction} onChange={() => setDraft({ ...draft, defaultAction: null })} /> ▶ Play starts the game its own way
        </label>
      )}
      <div className="inline wrap">
        <select
          value=""
          aria-label="Add a way to start the game"
          onChange={(e) => {
            const t = TEMPLATES[Number(e.target.value)];
            if (t) setDraft({ ...draft, actions: [...draft.actions, { id: newId(), ...structuredClone(t.action) }] });
          }}
        >
          <option value="">+ Add a way to start it…</option>
          {TEMPLATES.map((t, i) => (
            <option key={t.label} value={i}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <h4>Before it starts</h4>
      <StepsEditor steps={draft.before} onChange={(before) => setDraft({ ...draft, before })} pickKey={launchKey} label="Steps before the game" />
      <h4>After it closes</h4>
      <StepsEditor steps={draft.after} onChange={(after) => setDraft({ ...draft, after })} pickKey={launchKey} label="Steps after the game" />
      {globalCount > 0 && (
        <label className="check small">
          <input type="checkbox" checked={!!draft.skipGlobal} onChange={(e) => setDraft({ ...draft, skipGlobal: e.target.checked })} /> Skip the {globalCount} step{globalCount === 1 ? "" : "s"} every game runs (Profile, This computer)
        </label>
      )}
      <div className="inline">
        <button className="primary small" onClick={() => void save()}>
          Save launch options
        </button>
        {state.profile && (
          <button
            className="ghost small"
            onClick={() =>
              void bridge.setLaunchOptions!(launchKey, null).then(() => {
                setDraft(blankProfile());
                onSaved();
              })
            }
          >
            Clear all
          </button>
        )}
        {saved && <span className="muted small">Saved.</span>}
      </div>
      <p className="muted small">The first time a program is used, LootDen asks you to allow it on this PC.</p>
      {error && <p className="error small">{error}</p>}
    </details>
  );
}

/** "Play with …" buttons for a game's extra ways to start, next to ▶ Play. */
export function PlayWithButtons({ profile, disabled, onPlay }: { profile: LaunchProfile | null; disabled?: boolean; onPlay: (actionId: string) => void }) {
  if (!profile?.actions.length) return null;
  const others = [...profile.actions.filter((a) => a.id !== profile.defaultAction).map((a) => ({ id: a.id, name: a.name })), ...(profile.defaultAction ? [{ id: "", name: "the game's own way" }] : [])];
  return (
    <>
      {others.map((a) => (
        <button key={a.id || "own"} className="secondary" disabled={disabled} onClick={() => onPlay(a.id)} title={a.id ? profile.actions.find((x) => x.id === a.id)?.steps.map(describeLaunchStep).join(", ") : undefined}>
          ▶ {a.id ? `Play with ${a.name}` : "Play without mods"}
        </button>
      ))}
    </>
  );
}

/** Steps every game on this PC runs before and after it plays (Profile, This computer). */
export function EveryGameScripts() {
  const [draft, setDraft] = useState<GlobalLaunchScripts | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void desktop?.launchOptions?.("lootden:-").then((s) => setDraft(s.global), () => {});
  }, []);
  if (!desktop?.setLaunchScripts || !draft) return null;
  const save = async () => {
    setError("");
    setSaved(false);
    try {
      setDraft(await desktop!.setLaunchScripts!(draft));
      setSaved(true);
    } catch (e) {
      setError(bridgeError(e));
    }
  };
  return (
    <details className="launch-options">
      <summary>
        <strong>Before and after every game</strong> <span className="muted small">{draft.before.length + draft.after.length ? `${draft.before.length + draft.after.length} steps` : "switch HDR on, close programs"}</span>
      </summary>
      <p className="muted small">Run on this PC around every game LootDen starts, including other stores' games with launch options. A game's page can skip them.</p>
      <h4>Before a game starts</h4>
      <StepsEditor steps={draft.before} onChange={(before) => setDraft({ ...draft, before })} pickKey="" label="Steps before every game" />
      <h4>After a game closes</h4>
      <StepsEditor steps={draft.after} onChange={(after) => setDraft({ ...draft, after })} pickKey="" label="Steps after every game" />
      <div className="inline">
        <button className="primary small" onClick={() => void save()}>
          Save
        </button>
        {saved && <span className="muted small">Saved.</span>}
      </div>
      {error && <p className="error small">{error}</p>}
    </details>
  );
}
