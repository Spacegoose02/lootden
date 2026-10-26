import { useState } from "react";
import { THEMES, gridLayers, useTheme } from "../theme";
import { BrandLogo } from "./BrandLogo";

type Scheme = "all" | "dark" | "light";

/** The Settings Themes tab: every theme as a small mock of the app in its colours. */
export function ThemePicker() {
  const { theme, setTheme, logo, setLogo } = useTheme();
  const [scheme, setScheme] = useState<Scheme>("all");
  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0]!;
  const shown = THEMES.filter((t) => scheme === "all" || t.scheme === scheme);

  return (
    <>
      <div className="theme-toolbar">
        <p className="muted small">
          Using <strong>{current.name}</strong>. Your choice is saved on this device only, so each computer and browser can have its own.
        </p>
        <div className="segmented" role="radiogroup" aria-label="Show themes">
          {(["all", "dark", "light"] as const).map((s) => (
            <button key={s} role="radio" aria-checked={scheme === s} className={scheme === s ? "active" : ""} onClick={() => setScheme(s)}>
              {s === "all" ? `All (${THEMES.length})` : s === "dark" ? "Dark" : "Light"}
            </button>
          ))}
        </div>
      </div>
      {(["Modern", "Retro"] as const).map((group) => {
        const list = shown.filter((t) => t.group === group);
        if (!list.length) return null;
        return (
          <div key={group}>
            <h3 className="theme-group">{group}</h3>
            <div className="themes" role="radiogroup" aria-label={`${group} themes`}>
              {list.map((t) => {
                const p = t.preview;
                const r = Math.min(p.radius, 10);
                // Outline themes draw their bars and button as glowing strokes, like the real app does.
                const fill = (c: string) => (p.outline ? { border: `1.5px solid ${c}`, boxShadow: `0 0 6px ${c}` } : { background: c, opacity: 0.85 });
                return (
                  <button key={t.id} role="radio" aria-checked={theme === t.id} className={`theme-card${theme === t.id ? " active" : ""}`} onClick={() => setTheme(t.id)}>
                    <span className="theme-mock" aria-hidden="true" style={{ background: p.grid ? `${gridLayers(p.grid, 12)}, ${p.bg}` : p.bg, color: p.text, borderColor: p.border, fontFamily: p.font }}>
                      <span className="theme-mock-bar" style={{ background: p.bg2, borderColor: p.border }}>
                        <i style={{ background: p.accent }} />
                        <b style={{ background: p.muted }} />
                        <b style={{ background: p.muted }} />
                      </span>
                      <span className="theme-mock-body">
                        {[0, 1, 2].map((i) => (
                          <span key={i} className="theme-mock-card" style={{ background: p.panel, borderColor: p.border, borderRadius: r / 2 }}>
                            <span style={{ ...fill(i === 1 ? p.accent2 : p.accent), borderRadius: r / 3 }} />
                          </span>
                        ))}
                        <span className="theme-mock-text">
                          <span style={{ color: p.text }}>Aa</span>
                          <b style={{ background: p.muted }} />
                        </span>
                        <span
                          className="theme-mock-button"
                          style={p.outline ? { border: `1px solid ${p.accent}`, color: p.accent, boxShadow: `0 0 6px ${p.accent}`, borderRadius: r } : { background: p.accent, color: p.accentText, borderRadius: r }}
                        >
                          Play
                        </span>
                      </span>
                    </span>
                    <span className="theme-card-name">
                      <strong>{t.name}</strong>
                      {theme === t.id && <span className="pill">Active</span>}
                    </span>
                    <small>{t.note}</small>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {__BRAND__.raccoon && (
        <div className="inline logo-style">
          <BrandLogo size={48} />
          <div className="segmented" role="radiogroup" aria-label="Logo colours">
            <button role="radio" aria-checked={logo === "theme"} className={logo === "theme" ? "active" : ""} onClick={() => setLogo("theme")}>
              Logo in theme colours
            </button>
            <button role="radio" aria-checked={logo === "raccoon"} className={logo === "raccoon" ? "active" : ""} onClick={() => setLogo("raccoon")}>
              Raccoon black, grey and white
            </button>
          </div>
        </div>
      )}
    </>
  );
}
