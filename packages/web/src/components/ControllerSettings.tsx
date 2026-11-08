import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { feel } from "../feedback";
import { PAD_DEFAULTS, useMediaPrefs, usePadPrefs, type PadPrefs } from "../prefs";
import { language, LANGUAGES, setLanguage, t, type Language } from "../i18n";
import { POSTER_SIZES, THEMES, usePosterSize, useTheme } from "../theme";
import { bridgeError, desktop, type AppSettings } from "../desktop";
import { PadGlyph } from "./PadHints";
import { Card, Field, Toggle } from "./SettingsUi";
import { ThemePicker } from "./ThemePicker";

/** Settings, You, Controller and handheld: this person's choices on this device. */
export function ControllerSettings() {
  const [p, set] = usePadPrefs();
  const { touch, setTouch } = useTheme();
  return (
    <>
      <Card title="Typing" description="What happens when you press A on a text box, such as Search or Bandit's question.">
        <Field label="On-screen keyboard" hint="LootDen's keyboard works in full screen with a controller, where Windows' touch keyboard often doesn't show.">
          <select value={p.keyboard} onChange={(e) => set({ keyboard: e.target.value as PadPrefs["keyboard"] })}>
            <option value="auto">LootDen's keyboard with a controller</option>
            <option value="on">LootDen's keyboard always (touch too)</option>
            <option value="off">Off: use Windows' keyboard</option>
          </select>
        </Field>
        <p className="muted small">
          On the keyboard: <PadGlyph button="x" /> delete, <PadGlyph button="y" /> space, <PadGlyph button="lt" />
          <PadGlyph button="rt" /> move the cursor, <PadGlyph button="l3" /> Shift, <PadGlyph button="view" /> symbols, <PadGlyph button="menu" /> done and{" "}
          <PadGlyph button="b" /> close.
        </p>
      </Card>

      <Card title="Feel" description="Feedback while you move around with a controller or the arrow keys. A mouse never rumbles or clicks.">
        <Toggle
          checked={p.haptics}
          onChange={(v) => {
            set({ haptics: v });
            if (v) setTimeout(() => feel("select"), 0);
          }}
          label="Rumble"
          hint="A tiny buzz on each move, a stronger one on A and a bump at the edge of the page."
        />
        <Toggle
          checked={p.sounds}
          onChange={(v) => {
            set({ sounds: v });
            if (v) setTimeout(() => feel("select"), 0);
          }}
          label="Menu sounds"
          hint="Quiet clicks on moves, A and B."
        />
        {p.sounds && (
          <Field label={`Sound volume (${p.volume}%)`}>
            <input type="range" min={0} max={100} step={5} value={p.volume} onChange={(e) => set({ volume: Number(e.target.value) })} onPointerUp={() => feel("move")} />
          </Field>
        )}
      </Card>

      <Card title="Buttons" description="How the controller's buttons are shown and what the extra ones do.">
        <Field label="Button names" hint="Worked out from the controller you're holding, or pick one.">
          <select value={p.glyphs} onChange={(e) => set({ glyphs: e.target.value as PadPrefs["glyphs"] })}>
            <option value="auto">Match my controller</option>
            <option value="xbox">Xbox and ROG Ally (A B X Y)</option>
            <option value="playstation">PlayStation (✕ ○ □ △)</option>
            <option value="nintendo">Nintendo (B A Y X)</option>
          </select>
        </Field>
        <Toggle checked={p.hints} onChange={(v) => set({ hints: v })} label="Button hints along the bottom" hint="Shows what each button does on the thing you've selected." />
        <Toggle
          checked={p.quickMenus}
          onChange={(v) => set({ quickMenus: v })}
          label="Menu and View buttons"
          hint={
            <>
              <PadGlyph button="menu" /> opens the selected game's options (play, install, favourite, hide). <PadGlyph button="view" /> opens the quick menu from anywhere.
            </>
          }
        />
        <Toggle
          checked={p.stickJumps}
          onChange={(v) => set({ stickJumps: v })}
          label="Stick clicks"
          hint={
            <>
              <PadGlyph button="l3" /> jumps to a letter in a list of games, <PadGlyph button="r3" /> back to the top of the page.
            </>
          }
        />
        <div className="inline">
          <button className="ghost" onClick={() => set(PAD_DEFAULTS)}>
            Put these back as they were
          </button>
        </div>
      </Card>

      <InGameMenuCard />

      <Card title="Handheld" description="For the ROG Ally, Steam Deck, Legion Go and tablets.">
        <Toggle checked={touch === "on"} onChange={(v) => setTouch(v ? "on" : "off")} label="Bigger buttons and text" hint="Larger targets for fingers and a small screen." />
        {desktop ? (
          <p className="muted small">
            Full screen at start-up, the launch splash and how this PC starts LootDen are under <Link to="/settings/computer">This PC</Link>.
          </p>
        ) : null}
        <p className="muted small">On the ROG Ally, set Armoury Crate's Control Mode to Gamepad. In Auto or Desktop mode the controller acts as a mouse and LootDen can't see it.</p>
      </Card>
    </>
  );
}

/** Settings, You, Appearance: the theme and how big things are. */
export function AppearanceSettings() {
  const { theme } = useTheme();
  const [poster, setPoster] = usePosterSize();
  const current = THEMES.find((x) => x.id === theme) ?? THEMES[0]!;
  const [media, setMedia] = useMediaPrefs();
  const lang = language();
  return (
    <>
      <Card title={t("Language")} description={t("Menus and buttons in this language, on this device. Game descriptions stay as the stores write them.")}>
        <select aria-label={t("Language")} value={lang.picked} onChange={(e) => setLanguage(e.target.value as Language | "")}>
          <option value="">{t("Same as this device")} ({LANGUAGES.find((l) => l.code === lang.current)?.name})</option>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </Card>

      <Card title={t("Video previews")} description={t("Play a game's trailer, muted, when you rest on it in the library.")}>
        <Toggle checked={media.previews} onChange={(v) => setMedia({ previews: v })} label={t("Video previews")} />
        <Field label={t("Attract mode")} hint={t("When the app sits idle with a controller, show trailers from the library until someone presses a button.")}>
          <select value={media.attractMinutes} onChange={(e) => setMedia({ attractMinutes: Number(e.target.value) })}>
            <option value={0}>{t("Off")}</option>
            {[2, 5, 10, 20].map((n) => (
              <option key={n} value={n}>
                {t("After {n} minutes", { n })}
              </option>
            ))}
          </select>
        </Field>
      </Card>

      <Card title="Banner and poster size" description={`Theme: ${current.name}. The Featured banner on Home and the poster on a game's page.`}>
        <div className="segmented" role="radiogroup" aria-label="Poster size">
          {POSTER_SIZES.map(([id, label]) => (
            <button key={id} role="radio" aria-checked={poster === id} className={poster === id ? "active" : ""} onClick={() => setPoster(id)}>
              {label}
            </button>
          ))}
        </div>
      </Card>
      <ThemePicker />
    </>
  );
}

/** The in-game menu's combo, a setting of the desktop app on this PC. */
function InGameMenuCard() {
  const [opts, setOpts] = useState<AppSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void desktop?.appSettings?.().then(setOpts, (e) => setError(bridgeError(e)));
  }, []);
  if (!desktop?.appSettings || !desktop.overlay) return null;
  return (
    <Card title="In-game menu" description="Bring LootDen up over a running game to pause it, ask Bandit, open the browser, take a screenshot or close the game.">
      <Field label="Open it with" hint="Works over borderless and windowed games, and in the Xbox full screen experience. In exclusive full screen, switch the game to borderless if the menu stays behind it.">
        <select
          value={opts?.overlay ?? "view-menu"}
          disabled={!opts}
          onChange={(e) => desktop!.appSettings!({ overlay: e.target.value as NonNullable<AppSettings["overlay"]> }).then(setOpts, (err) => setError(bridgeError(err)))}
        >
          <option value="view-menu">Hold View + Menu</option>
          <option value="guide">The Xbox button (unless Game Bar, Armoury Crate or Xbox full screen take it)</option>
          <option value="off">Off</option>
        </select>
      </Field>
      {error && <p className="error small">{error}</p>}
    </Card>
  );
}
