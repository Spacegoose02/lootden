import { useEffect, useState } from "react";
import { updateFavicon, type LogoStyle } from "./components/BrandLogo";
import { desktop } from "./desktop";

/**
 * Themes are sets of CSS variables (see the token list in styles.css). Each one only
 * needs a few colours; the rest are derived. The picker shows them in two groups,
 * like the reference board: Modern, Glow (Laser Grid, Nuclear and Neon) and Retro.
 */
interface ThemeDef {
  id: string;
  name: string;
  note: string;
  group: "Modern" | "Glow" | "Retro";
  /** Laser, Nuclear and Neon variants share extra styling in styles.css, keyed by data-family. */
  family?: "laser" | "nuclear" | "neon";
  scheme: "dark" | "light";
  bg: string;
  bg2: string;
  panel: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accent2: string;
  accentText?: string;
  radius?: number;
  font?: string;
  /** Extra page background layers (gradients) behind everything. */
  glow?: string;
  pageBg?: string;
  /** Bars and the main button are drawn as glowing outlines instead of solid fills. */
  outline?: boolean;
  /** Colour of a fine square grid drawn over the page (and the picker tile). */
  grid?: string;
}

const MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace';

const DEFS: ThemeDef[] = [
  // ---- Modern ----
  {
    id: "wavelength", name: "Wavelength", note: "Neon synthwave on deep purple", group: "Modern", scheme: "dark",
    bg: "#0d0820", bg2: "#160d33", panel: "#1e1342", border: "#3a2a6e", text: "#f3eeff", muted: "#b3a6d9", accent: "#ff4fd8", accent2: "#2ef2ff", accentText: "#12051f",
    pageBg: "radial-gradient(1200px 600px at 10% -10%, #3b136b 0%, transparent 60%), radial-gradient(900px 500px at 110% 10%, #0b4a6b 0%, transparent 55%)",
    glow: "0 0 24px rgba(255, 79, 216, 0.35)",
  },
  {
    id: "manatee", name: "Manatee", note: "Calm slate blues, soft and rounded", group: "Modern", scheme: "dark", radius: 22,
    bg: "#1d2633", bg2: "#253141", panel: "#2e3c4f", border: "#41546b", text: "#eef3f8", muted: "#a5b4c6", accent: "#7fb4e8", accent2: "#9ad8c8", accentText: "#0f1a26",
    pageBg: "linear-gradient(180deg, #273447 0%, transparent 420px)",
  },
  { id: "midnight-gold", name: "Midnight Gold", note: "Near-black with warm gold", group: "Modern", scheme: "dark", bg: "#0f1014", bg2: "#17181e", panel: "#1b1c23", border: "#2c2d36", text: "#f2efe8", muted: "#a19c90", accent: "#f2b84b", accent2: "#f28c38", accentText: "#1a1206" },
  { id: "nord", name: "Nord", note: "Arctic blue-grey, frosty accents", group: "Modern", scheme: "dark", bg: "#2e3440", bg2: "#3b4252", panel: "#3b4252", border: "#4c566a", text: "#eceff4", muted: "#c0c8d6", accent: "#88c0d0", accent2: "#b48ead", accentText: "#1d2129" },
  { id: "deep-ocean", name: "Deep Ocean", note: "Dark navy with neon reef colours", group: "Modern", scheme: "dark", bg: "#070b1d", bg2: "#0d1430", panel: "#111a3a", border: "#1f2b57", text: "#e6ecff", muted: "#8f9cc8", accent: "#22d3ee", accent2: "#f43f8e", accentText: "#041018" },
  { id: "daylight", name: "Daylight", note: "Clean and bright", group: "Modern", scheme: "light", bg: "#f4f5f9", bg2: "#ffffff", panel: "#ffffff", border: "#dde1ea", text: "#171a21", muted: "#5d6576", accent: "#d9731a", accent2: "#2563eb", accentText: "#ffffff", glow: "0 6px 20px rgba(30, 30, 60, 0.08)" },
  { id: "dracula", name: "Dracula", note: "Classic dark purple and pink", group: "Modern", scheme: "dark", bg: "#282a36", bg2: "#303241", panel: "#343746", border: "#44475a", text: "#f8f8f2", muted: "#b6b9cf", accent: "#bd93f9", accent2: "#ff79c6", accentText: "#1b1530" },
  { id: "tokyo-night", name: "Tokyo Night", note: "Deep indigo city lights", group: "Modern", scheme: "dark", bg: "#1a1b26", bg2: "#1f2335", panel: "#24283b", border: "#33395a", text: "#c0caf5", muted: "#8a92b8", accent: "#7aa2f7", accent2: "#bb9af7", accentText: "#11131c" },
  { id: "gruvbox", name: "Gruvbox", note: "Warm retro-modern browns", group: "Modern", scheme: "dark", bg: "#282828", bg2: "#32302f", panel: "#3c3836", border: "#504945", text: "#ebdbb2", muted: "#bdae93", accent: "#fabd2f", accent2: "#fe8019", accentText: "#1d2021" },
  { id: "solarized", name: "Solarized Dark", note: "Teal-blue base, measured accents", group: "Modern", scheme: "dark", bg: "#002b36", bg2: "#073642", panel: "#073642", border: "#0f4a57", text: "#eee8d5", muted: "#93a1a1", accent: "#2aa198", accent2: "#b58900", accentText: "#002b36" },
  { id: "mocha", name: "Mocha", note: "Soft pastels on dark espresso", group: "Modern", scheme: "dark", bg: "#1e1e2e", bg2: "#232336", panel: "#2a2a3d", border: "#3b3b54", text: "#cdd6f4", muted: "#a6adc8", accent: "#cba6f7", accent2: "#f5c2e7", accentText: "#1e1e2e" },
  { id: "midnight", name: "Midnight", note: "Plain dark with a blue accent", group: "Modern", scheme: "dark", radius: 10, bg: "#0e1116", bg2: "#161b22", panel: "#161b22", border: "#2a313c", text: "#e6edf3", muted: "#8b949e", accent: "#4c9aff", accent2: "#a371f7", accentText: "#ffffff" },
  { id: "rose-pine", name: "Rosé Pine", note: "Muted rose and gold on dusky violet", group: "Modern", scheme: "dark", radius: 16, bg: "#191724", bg2: "#1f1d2e", panel: "#26233a", border: "#403d52", text: "#e0def4", muted: "#a19dbb", accent: "#ebbcba", accent2: "#f6c177", accentText: "#191724" },
  { id: "kanagawa", name: "Kanagawa", note: "Ink-wash blues with autumn highlights", group: "Modern", scheme: "dark", radius: 8, bg: "#16161d", bg2: "#1f1f28", panel: "#2a2a37", border: "#363646", text: "#dcd7ba", muted: "#a6a69c", accent: "#7e9cd8", accent2: "#ffa066", accentText: "#16161d" },
  { id: "evergreen", name: "Evergreen", note: "Deep forest green with amber light", group: "Modern", scheme: "dark", bg: "#0f1a14", bg2: "#14231b", panel: "#1a2c22", border: "#2b4536", text: "#e4f0e6", muted: "#9db8a5", accent: "#7fd18b", accent2: "#f2b84b", accentText: "#0a1a0f",
    pageBg: "linear-gradient(180deg, #17301f 0%, transparent 400px)" },
  { id: "aurora", name: "Aurora", note: "Northern lights over a polar night", group: "Modern", scheme: "dark", radius: 18, bg: "#060d1a", bg2: "#0b1628", panel: "#101f36", border: "#1e3557", text: "#e8f4ff", muted: "#93aecb", accent: "#4dffb4", accent2: "#b07cff", accentText: "#03140c",
    pageBg: "radial-gradient(1100px 520px at 20% -15%, #0d4d3f 0%, transparent 60%), radial-gradient(900px 480px at 95% 0%, #3a1f6b 0%, transparent 55%)",
    glow: "0 0 24px rgba(77, 255, 180, 0.28)" },
  { id: "tropical", name: "Tropical Sunset", note: "Coral and mango on a dark lagoon", group: "Modern", scheme: "dark", radius: 18, bg: "#0b1f24", bg2: "#10292f", panel: "#15333a", border: "#245059", text: "#fff3ea", muted: "#a9c9c8", accent: "#ff6f59", accent2: "#ffc145", accentText: "#2a0b05",
    pageBg: "radial-gradient(1000px 500px at 100% -10%, #5a2a2a 0%, transparent 55%)" },
  { id: "latte", name: "Latte", note: "Soft pastels on warm cream", group: "Modern", scheme: "light", bg: "#eff1f5", bg2: "#e6e9ef", panel: "#ffffff", border: "#ccd0da", text: "#4c4f69", muted: "#6c6f85", accent: "#8839ef", accent2: "#d20f39", accentText: "#ffffff" },
  { id: "sakura", name: "Sakura", note: "Cherry blossom pink, light and airy", group: "Modern", scheme: "light", radius: 20, bg: "#fdf2f5", bg2: "#fff8fa", panel: "#ffffff", border: "#f2d3dc", text: "#3d2530", muted: "#8a6572", accent: "#d63d6f", accent2: "#5c8f4e", accentText: "#ffffff",
    pageBg: "linear-gradient(180deg, #fbe1ea 0%, transparent 380px)" },
  { id: "paper", name: "Paper", note: "Ink on warm sepia pages", group: "Modern", scheme: "light", radius: 6, bg: "#f4ecd8", bg2: "#efe4cb", panel: "#fbf6ea", border: "#d9c9a3", text: "#3b2f1e", muted: "#7a6a4f", accent: "#a2471d", accent2: "#2f5d62", accentText: "#ffffff" },

  // ---- Glow: Laser Grid outlines, Nuclear reactor glow, Neon signs (see the extras in styles.css) ----
  { id: "laser-grid", name: "Laser Grid", note: "Neon cyan outlines on a black grid", group: "Glow", family: "laser", scheme: "dark", radius: 4, outline: true, grid: "rgba(0, 229, 255, 0.07)",
    bg: "#03070b", bg2: "#060d14", panel: "#08121b", border: "#0e3a47", text: "#d9fbff", muted: "#6fb3c2", accent: "#00e5ff", accent2: "#2b8cff", accentText: "#001318",
    glow: "0 0 14px rgba(0, 229, 255, 0.45)" },
  { id: "laser-grid-magenta", name: "Laser Grid Magenta", note: "Hot magenta outlines on a black grid", group: "Glow", family: "laser", scheme: "dark", radius: 4, outline: true, grid: "rgba(255, 43, 214, 0.07)",
    bg: "#0b0309", bg2: "#140611", panel: "#1b0817", border: "#4a0e3d", text: "#ffe0f6", muted: "#c77fb4", accent: "#ff2bd6", accent2: "#a64dff", accentText: "#1a0015",
    glow: "0 0 14px rgba(255, 43, 214, 0.45)" },
  { id: "laser-grid-amber", name: "Laser Grid Amber", note: "Amber outlines on a black grid", group: "Glow", family: "laser", scheme: "dark", radius: 4, outline: true, grid: "rgba(255, 178, 26, 0.07)",
    bg: "#0b0703", bg2: "#140d06", panel: "#1b1208", border: "#4a300e", text: "#fff1d9", muted: "#c9a06f", accent: "#ffb21a", accent2: "#ff6a1a", accentText: "#1a0d00",
    glow: "0 0 14px rgba(255, 178, 26, 0.45)" },
  { id: "laser-grid-green", name: "Laser Grid Green", note: "Phosphor green outlines on a black grid", group: "Glow", family: "laser", scheme: "dark", radius: 4, outline: true, grid: "rgba(43, 255, 106, 0.07)",
    bg: "#030b05", bg2: "#06140a", panel: "#081b0d", border: "#0e4a1d", text: "#dcffe4", muted: "#7fc290", accent: "#2bff6a", accent2: "#00d9a3", accentText: "#00180a",
    glow: "0 0 14px rgba(43, 255, 106, 0.45)" },
  { id: "laser-grid-violet", name: "Laser Grid Violet", note: "Ultraviolet outlines on a black grid", group: "Glow", family: "laser", scheme: "dark", radius: 4, outline: true, grid: "rgba(169, 112, 255, 0.07)",
    bg: "#06030b", bg2: "#0c0614", panel: "#11081b", border: "#2c0e4a", text: "#ece0ff", muted: "#a58fd1", accent: "#a970ff", accent2: "#ff4fd8", accentText: "#0e001a",
    glow: "0 0 14px rgba(169, 112, 255, 0.45)" },
  { id: "laser-grid-red", name: "Laser Grid Red", note: "Red laser outlines on a black grid", group: "Glow", family: "laser", scheme: "dark", radius: 4, outline: true, grid: "rgba(255, 59, 59, 0.07)",
    bg: "#0b0303", bg2: "#140606", panel: "#1b0808", border: "#4a0e0e", text: "#ffe0e0", muted: "#cf8585", accent: "#ff3b3b", accent2: "#ff9a2b", accentText: "#1a0000",
    glow: "0 0 14px rgba(255, 59, 59, 0.45)" },
  { id: "nuclear", name: "Nuclear", note: "Toxic green and hazard yellow glow", group: "Glow", family: "nuclear", scheme: "dark", radius: 8, bg: "#070a04", bg2: "#0c1207", panel: "#111a0a", border: "#2c4214", text: "#eaffd6", muted: "#9fbf7a", accent: "#76ff2e", accent2: "#ffe11a", accentText: "#0a1402",
    pageBg: "radial-gradient(900px 520px at 15% -10%, rgba(118, 255, 46, 0.18) 0%, transparent 60%), radial-gradient(800px 460px at 105% 5%, rgba(255, 225, 26, 0.12) 0%, transparent 55%)",
    glow: "0 0 22px rgba(118, 255, 46, 0.4)" },
  { id: "nuclear-cherenkov", name: "Cherenkov", note: "Reactor-pool blue glow under water", group: "Glow", family: "nuclear", scheme: "dark", radius: 8, bg: "#03070d", bg2: "#060d18", panel: "#0a1424", border: "#173357", text: "#dcecff", muted: "#8aa8cf", accent: "#3ab4ff", accent2: "#7df9ff", accentText: "#00101f",
    pageBg: "radial-gradient(900px 520px at 15% -10%, rgba(58, 180, 255, 0.18) 0%, transparent 60%), radial-gradient(800px 460px at 105% 5%, rgba(125, 249, 255, 0.12) 0%, transparent 55%)",
    glow: "0 0 22px rgba(58, 180, 255, 0.4)" },
  { id: "nuclear-meltdown", name: "Meltdown", note: "Molten orange core and warning red", group: "Glow", family: "nuclear", scheme: "dark", radius: 8, bg: "#0d0603", bg2: "#170b05", panel: "#211007", border: "#4d2410", text: "#ffe9d9", muted: "#cf9a7a", accent: "#ff7a1a", accent2: "#ff3b2b", accentText: "#1a0800",
    pageBg: "radial-gradient(900px 520px at 15% -10%, rgba(255, 122, 26, 0.18) 0%, transparent 60%), radial-gradient(800px 460px at 105% 5%, rgba(255, 59, 43, 0.12) 0%, transparent 55%)",
    glow: "0 0 22px rgba(255, 122, 26, 0.4)" },
  { id: "nuclear-radium", name: "Radium", note: "Glow-in-the-dark dial green on black", group: "Glow", family: "nuclear", scheme: "dark", radius: 8, bg: "#040a08", bg2: "#08120f", panel: "#0c1a15", border: "#1f4236", text: "#e0fff3", muted: "#8fc2ad", accent: "#3dffb0", accent2: "#d4ff5c", accentText: "#00170d",
    pageBg: "radial-gradient(900px 520px at 15% -10%, rgba(61, 255, 176, 0.18) 0%, transparent 60%), radial-gradient(800px 460px at 105% 5%, rgba(212, 255, 92, 0.12) 0%, transparent 55%)",
    glow: "0 0 22px rgba(61, 255, 176, 0.4)" },
  { id: "nuclear-isotope", name: "Isotope", note: "Plutonium violet with a hazard yellow edge", group: "Glow", family: "nuclear", scheme: "dark", radius: 8, bg: "#08040d", bg2: "#0f0818", panel: "#160c22", border: "#35205a", text: "#f1e6ff", muted: "#ae98cf", accent: "#c06bff", accent2: "#ffe11a", accentText: "#12001f",
    pageBg: "radial-gradient(900px 520px at 15% -10%, rgba(192, 107, 255, 0.18) 0%, transparent 60%), radial-gradient(800px 460px at 105% 5%, rgba(255, 225, 26, 0.12) 0%, transparent 55%)",
    glow: "0 0 22px rgba(192, 107, 255, 0.4)" },
  { id: "neon-nights", name: "Neon Nights", note: "Pink and blue sign tubes on a dark wall", group: "Glow", family: "neon", scheme: "dark", radius: 12, bg: "#0a0710", bg2: "#120c1c", panel: "#181126", border: "#36264f", text: "#fbefff", muted: "#b8a6d1", accent: "#ff4fc3", accent2: "#4fb8ff", accentText: "#1a0012",
    pageBg: "radial-gradient(1000px 480px at 0% -10%, rgba(255, 79, 195, 0.16) 0%, transparent 60%), radial-gradient(900px 460px at 100% 0%, rgba(79, 184, 255, 0.12) 0%, transparent 55%)",
    glow: "0 0 18px rgba(255, 79, 195, 0.5), 0 0 2px rgba(255, 79, 195, 0.9)" },
  { id: "neon-diner", name: "Neon Diner", note: "Cherry red and teal roadside sign", group: "Glow", family: "neon", scheme: "dark", radius: 12, bg: "#0b0809", bg2: "#141011", panel: "#1c1517", border: "#3d2a2e", text: "#fff0ee", muted: "#c4a4a4", accent: "#ff3d55", accent2: "#2ee6c9", accentText: "#1a0005",
    pageBg: "radial-gradient(1000px 480px at 0% -10%, rgba(255, 61, 85, 0.16) 0%, transparent 60%), radial-gradient(900px 460px at 100% 0%, rgba(46, 230, 201, 0.12) 0%, transparent 55%)",
    glow: "0 0 18px rgba(255, 61, 85, 0.5), 0 0 2px rgba(255, 61, 85, 0.9)" },
  { id: "neon-lime", name: "Neon Lime", note: "Electric lime and orange on charcoal", group: "Glow", family: "neon", scheme: "dark", radius: 12, bg: "#08090a", bg2: "#0f1112", panel: "#15181a", border: "#2c3236", text: "#f2fbe8", muted: "#a7b39b", accent: "#b8ff2e", accent2: "#ff8a1f", accentText: "#0f1a00",
    pageBg: "radial-gradient(1000px 480px at 0% -10%, rgba(184, 255, 46, 0.16) 0%, transparent 60%), radial-gradient(900px 460px at 100% 0%, rgba(255, 138, 31, 0.12) 0%, transparent 55%)",
    glow: "0 0 18px rgba(184, 255, 46, 0.5), 0 0 2px rgba(184, 255, 46, 0.9)" },
  { id: "neon-ultraviolet", name: "Neon Ultraviolet", note: "Blacklight violet with a cyan flicker", group: "Glow", family: "neon", scheme: "dark", radius: 12, bg: "#07051a", bg2: "#0d0a26", panel: "#130f33", border: "#2e2766", text: "#f0edff", muted: "#aaa2dd", accent: "#9d6bff", accent2: "#3ff7ff", accentText: "#0c0026",
    pageBg: "radial-gradient(1000px 480px at 0% -10%, rgba(157, 107, 255, 0.16) 0%, transparent 60%), radial-gradient(900px 460px at 100% 0%, rgba(63, 247, 255, 0.12) 0%, transparent 55%)",
    glow: "0 0 18px rgba(157, 107, 255, 0.5), 0 0 2px rgba(157, 107, 255, 0.9)" },
  { id: "neon-sunset", name: "Neon Sunset", note: "Orange and pink tubes at dusk", group: "Glow", family: "neon", scheme: "dark", radius: 12, bg: "#0e0710", bg2: "#170c1a", panel: "#1f1124", border: "#432647", text: "#fff0ea", muted: "#cfa6b4", accent: "#ff8a3d", accent2: "#ff4f9a", accentText: "#1a0900",
    pageBg: "radial-gradient(1000px 480px at 0% -10%, rgba(255, 138, 61, 0.16) 0%, transparent 60%), radial-gradient(900px 460px at 100% 0%, rgba(255, 79, 154, 0.12) 0%, transparent 55%)",
    glow: "0 0 18px rgba(255, 138, 61, 0.5), 0 0 2px rgba(255, 138, 61, 0.9)" },
  { id: "neon-ice", name: "Neon Ice", note: "Cold white-blue tubes on navy", group: "Glow", family: "neon", scheme: "dark", radius: 12, bg: "#040912", bg2: "#08111f", panel: "#0d182b", border: "#1f3557", text: "#eef7ff", muted: "#9ab2cf", accent: "#7fd8ff", accent2: "#c8a6ff", accentText: "#00121f",
    pageBg: "radial-gradient(1000px 480px at 0% -10%, rgba(127, 216, 255, 0.16) 0%, transparent 60%), radial-gradient(900px 460px at 100% 0%, rgba(200, 166, 255, 0.12) 0%, transparent 55%)",
    glow: "0 0 18px rgba(127, 216, 255, 0.5), 0 0 2px rgba(127, 216, 255, 0.9)" },

  // ---- Retro ----
  { id: "doom", name: "Inferno", note: "Hell-red with molten gold, 90s shooter", group: "Retro", scheme: "dark", radius: 4, bg: "#160606", bg2: "#200909", panel: "#2a0c0c", border: "#4a1616", text: "#f6e3d3", muted: "#c29a8a", accent: "#f4b63f", accent2: "#e53b2c", accentText: "#1a0503" },
  { id: "monochrome", name: "Monochrome", note: "Black and white, nothing else", group: "Retro", scheme: "dark", radius: 2, bg: "#0a0a0a", bg2: "#121212", panel: "#161616", border: "#333333", text: "#f2f2f2", muted: "#a0a0a0", accent: "#ffffff", accent2: "#9a9a9a", accentText: "#000000" },
  { id: "arcade-wood", name: "Arcade Cabinet", note: "Woodgrain brown and brass", group: "Retro", scheme: "dark", radius: 6, bg: "#1b130b", bg2: "#241a10", panel: "#2c2014", border: "#4a3721", text: "#f4e6cf", muted: "#c3a985", accent: "#e8a33d", accent2: "#c76a2b", accentText: "#1b1006" },
  { id: "synthwave", name: "Synthwave '84", note: "Hot pink and sunset orange on purple", group: "Retro", scheme: "dark", bg: "#1a0b2e", bg2: "#22103b", panel: "#2a1446", border: "#4a2575", text: "#fbeaff", muted: "#c9a9e0", accent: "#ff3e9a", accent2: "#ffb347", accentText: "#1a0612",
    pageBg: "linear-gradient(180deg, #2b0f4a 0%, transparent 380px)" },
  { id: "vaporwave", name: "Vaporwave", note: "Cyan and pink on electric indigo", group: "Retro", scheme: "dark", bg: "#170f3f", bg2: "#1f1552", panel: "#261a63", border: "#3e2d91", text: "#f2edff", muted: "#b6a9ea", accent: "#21e6ff", accent2: "#ff71ce", accentText: "#06142a" },
  { id: "matrix", name: "Terminal Green", note: "Phosphor green CRT", group: "Retro", scheme: "dark", radius: 0, font: MONO, bg: "#020a03", bg2: "#041006", panel: "#061608", border: "#0f3a14", text: "#b6ffb8", muted: "#5fbf66", accent: "#39ff6a", accent2: "#a6ff4d", accentText: "#001a05" },
  { id: "amber", name: "Amber Terminal", note: "Warm amber monochrome monitor", group: "Retro", scheme: "dark", radius: 0, font: MONO, bg: "#100800", bg2: "#170c01", panel: "#1d1002", border: "#4a2a05", text: "#ffd08a", muted: "#c48a3a", accent: "#ffb000", accent2: "#ff7a00", accentText: "#1a0d00" },
  { id: "cyberpunk", name: "Cyberpunk", note: "Acid yellow and magenta on black", group: "Retro", scheme: "dark", radius: 0, bg: "#0b0b10", bg2: "#121219", panel: "#16161f", border: "#2a2a3a", text: "#f4f4f8", muted: "#9b9bb0", accent: "#fcee0a", accent2: "#ff2a6d", accentText: "#0b0b10" },
  { id: "c64", name: "Commodore 64", note: "READY. Light blue on violet", group: "Retro", scheme: "dark", radius: 0, font: MONO, bg: "#40318d", bg2: "#4b3b9e", panel: "#3a2c80", border: "#7869c4", text: "#d8d2ff", muted: "#a59cf0", accent: "#7ce0ff", accent2: "#a4f0a0", accentText: "#1e1650" },
  { id: "red-visor", name: "Red Visor", note: "Red-on-black 3D headset glow", group: "Retro", scheme: "dark", radius: 0, font: MONO, bg: "#000000", bg2: "#0c0000", panel: "#140101", border: "#4d0606", text: "#ff4a3d", muted: "#b0241b", accent: "#ff1a0d", accent2: "#ff8a80", accentText: "#000000" },
  { id: "famicom", name: "Famicom", note: "Cream plastic, maroon trim, gold dots", group: "Retro", scheme: "light", radius: 4, bg: "#ece4d4", bg2: "#e2d8c3", panel: "#f6f1e6", border: "#b9a98a", text: "#2b1d16", muted: "#6e5b49", accent: "#9b1b30", accent2: "#c99a2e", accentText: "#ffffff" },
  { id: "gameboy", name: "Pocket Green", note: "Four shades of handheld green", group: "Retro", scheme: "light", radius: 2, font: MONO, bg: "#9bbc0f", bg2: "#8bac0f", panel: "#a9c71f", border: "#306230", text: "#0f380f", muted: "#306230", accent: "#0f380f", accent2: "#306230", accentText: "#9bbc0f",
    glow: "none" },
  { id: "classic-desktop", name: "Classic Desktop", note: "Grey windows and navy title bars", group: "Retro", scheme: "light", radius: 0, bg: "#c3c3c3", bg2: "#d4d0c8", panel: "#d4d0c8", border: "#808080", text: "#000000", muted: "#404040", accent: "#000080", accent2: "#1084d0", accentText: "#ffffff", glow: "inset -1px -1px #404040, inset 1px 1px #ffffff" },
];

/** What the Themes tab needs to draw each theme's preview without applying it. */
export const THEMES = DEFS.map((t) => ({
  id: t.id,
  name: t.name,
  note: t.note,
  group: t.group,
  scheme: t.scheme,
  swatch: [t.bg, t.panel, t.accent, t.accent2] as const,
  preview: {
    bg: t.bg,
    bg2: t.bg2,
    panel: t.panel,
    border: t.border,
    text: t.text,
    muted: t.muted,
    accent: t.accent,
    accent2: t.accent2,
    accentText: t.accentText ?? (t.scheme === "dark" ? "#0b0b10" : "#ffffff"),
    radius: t.radius ?? 14,
    font: t.font,
    outline: t.outline ?? false,
    grid: t.grid,
  },
}));
export type ThemeId = string;

/** A fine square grid as two background layers, for themes that ask for one. */
export function gridLayers(color: string, size = 32): string {
  return `linear-gradient(${color} 1px, transparent 1px) 0 0 / ${size}px ${size}px, linear-gradient(90deg, ${color} 1px, transparent 1px) 0 0 / ${size}px ${size}px`;
}

function tokens(t: ThemeDef): Record<string, string> {
  const dark = t.scheme === "dark";
  const layers = [t.grid && gridLayers(t.grid), t.pageBg].filter(Boolean).join(", ");
  return {
    "--bg": t.bg,
    "--bg-2": t.bg2,
    "--panel": t.panel,
    "--panel-solid": t.panel,
    "--border": t.border,
    "--text": t.text,
    "--muted": t.muted,
    "--accent": t.accent,
    "--accent-2": t.accent2,
    "--accent-text": t.accentText ?? (dark ? "#0b0b10" : "#ffffff"),
    "--good": dark ? "#59e38f" : "#11804a",
    "--warn": dark ? "#ffd166" : "#8a5b00",
    "--bad": dark ? "#ff5c7a" : "#b3123a",
    "--radius": `${t.radius ?? 14}px`,
    "--glow": t.glow ?? (dark ? `0 0 22px color-mix(in srgb, ${t.accent} 30%, transparent)` : "0 6px 20px rgba(0, 0, 0, 0.08)"),
    "--page-bg": layers ? (layers.includes("gradient") ? `${layers}, ${t.bg}` : layers) : t.bg,
    "--font": t.font ?? '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
  };
}

function apply(id: string) {
  const t = DEFS.find((d) => d.id === id) ?? DEFS[0]!;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens(t))) root.style.setProperty(k, v);
  root.style.colorScheme = t.scheme;
  root.dataset.theme = t.id;
  if (t.family) root.dataset.family = t.family;
  else delete root.dataset.family;
  root.dataset.scheme = t.scheme;
  // The desktop app's minimize, maximize and close buttons sit on the top bar, in its colours.
  void desktop?.titleBarColors?.(t.bg, t.text).catch(() => {});
  // The offline library (a page in the app itself) wears the same colours when the server is away.
  const { bg, bg2, panel, border, text, muted, accent, accent2 } = t;
  void desktop?.offlineTheme?.({ bg, bg2, panel, border, text, muted, accent, accent2, accentText: t.accentText ?? (t.scheme === "dark" ? "#0b0b10" : "#ffffff") }).catch(() => {});
}

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the choice just isn't remembered
  }
}

/** Theme and touch mode live on <html>; the theme as CSS variables, touch as a data attribute. */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeId>(() => read("gm-theme", "wavelength"));
  const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  const [touch, setTouch] = useState<"on" | "off">(() => (read("gm-touch", coarse ? "on" : "off") as "on" | "off"));

  const [logo, setLogo] = useState<LogoStyle>(() => (read("gm-logo", "theme") === "raccoon" ? "raccoon" : "theme"));

  useEffect(() => {
    apply(theme);
    write("gm-theme", theme);
  }, [theme]);
  // The raccoon follows the theme's colours, or keeps a real raccoon's black, grey and white.
  useEffect(() => {
    document.documentElement.dataset.logo = logo;
    write("gm-logo", logo);
    updateFavicon(logo);
  }, [theme, logo]);
  useEffect(() => {
    document.documentElement.dataset.touch = touch;
    write("gm-touch", touch);
  }, [touch]);

  return { theme, setTheme, touch, setTouch, logo, setLogo };
}

/**
 * How big the Featured banner and a game page's poster are. "off" hides the banner (the game
 * page then uses the small poster). Kept on <html> as data-poster, so styles.css sizes both.
 */
export type PosterSize = "large" | "normal" | "small" | "off";
export const POSTER_SIZES: Array<[PosterSize, string]> = [
  ["small", "Small"],
  ["normal", "Normal"],
  ["large", "Large"],
  ["off", "Hide banner"],
];

function readPoster(): PosterSize {
  const v = read("gm-poster", "normal");
  return POSTER_SIZES.some(([id]) => id === v) ? (v as PosterSize) : "normal";
}
if (typeof document !== "undefined") document.documentElement.dataset.poster = readPoster();

export function usePosterSize(): [PosterSize, (v: PosterSize) => void] {
  const [size, setSize] = useState<PosterSize>(readPoster);
  useEffect(() => {
    document.documentElement.dataset.poster = size;
    write("gm-poster", size);
  }, [size]);
  return [size, setSize];
}
