import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { avatarUrl } from "../api";
import { useAuth } from "../auth";
import { AlertsBell } from "./AlertsBell";
import { BrandLogo } from "./BrandLogo";
import { AppUpdateBanner } from "./AppOptions";
import { desktop } from "../desktop";
import { SECTION_EVENT } from "../gamepad";
import { FunLayer } from "./FunLayer";
import { Bandit } from "./Bandit";
import { PadHints } from "./PadHints";
import { Keyboard } from "./Keyboard";
import { QuickMenus } from "./QuickMenus";
import { GameOverlay } from "./GameOverlay";
import { useScrollMemory } from "../scrollMemory";

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  /** Passed to the page when the link itself is picked (not when LB/RB pass through it). */
  state?: unknown;
  /** The pages inside this section, shown as a second row of links under the top bar. */
  pages?: NavItem[];
}

/** Whether a path is this item's page, or one of its section's pages. */
const isOn = (i: NavItem, path: string): boolean =>
  (i.end ? path === i.to : path === i.to || path.startsWith(`${i.to}/`) || (i.to === "/library" && (path.startsWith("/games/") || path.startsWith("/store/") || path.startsWith("/play/")))) || !!i.pages?.some((p) => p.to !== i.to && isOn(p, path));

/** The last page opened in each section this session, so LB/RB come back to it. */
const lastPage = new Map<string, string>();

/**
 * The main links. As many as fit sit in the bar; the rest go in a More menu, so every page
 * stays reachable at any window size. On phones the whole menu is behind one button.
 */
function MainNav({ items, onSignOut }: { items: NavItem[]; onSignOut: () => void }) {
  const bar = useRef<HTMLElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(items.length);
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useLayoutEffect(() => {
    const el = bar.current;
    const m = measure.current;
    if (!el || !m) return;
    const update = () => {
      const widths = [...m.children].map((c) => (c as HTMLElement).offsetWidth + 2);
      const room = el.clientWidth;
      const all = widths.reduce((a, b) => a + b, 0);
      if (all <= room) return setFit(items.length);
      const more = (m.lastElementChild as HTMLElement | null)?.offsetWidth ?? 90;
      let used = more + 4;
      let n = 0;
      for (const w of widths.slice(0, items.length)) {
        if (used + w > room) break;
        used += w;
        n++;
      }
      setFit(n);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length]);

  // A new page closes the menu.
  useEffect(() => setOpen(false), [location.pathname]);
  // LB and RB on a controller: the previous or next section, wrapping round, More's included.
  const navigate = useNavigate();
  useEffect(() => {
    const onSection = (e: Event) => {
      const by = (e as CustomEvent<number>).detail;
      const at = items.findIndex((i) => isOn(i, location.pathname));
      const next = items[at < 0 ? (by > 0 ? 0 : items.length - 1) : (at + by + items.length) % items.length];
      if (next) navigate(lastPage.get(next.to) ?? next.to);
    };
    window.addEventListener(SECTION_EVENT, onSection);
    return () => window.removeEventListener(SECTION_EVENT, onSection);
  }, [items, location.pathname, navigate]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as HTMLElement).closest(".nav-menu, .nav-more")) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const hidden = items.slice(fit);
  const activeHidden = hidden.some((i) => isOn(i, location.pathname));
  return (
    <>
      <nav className="nav" ref={bar} aria-label="Main">
        {items.slice(0, fit).map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end} state={i.state} className={() => (isOn(i, location.pathname) ? "active" : "")}>
            {i.label}
          </NavLink>
        ))}
        {hidden.length > 0 && (
          <button className={`nav-more${activeHidden ? " active" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            More ▾
          </button>
        )}
        <div className="nav-measure" ref={measure} aria-hidden="true">
          {items.map((i) => (
            <a key={i.to}>{i.label}</a>
          ))}
          <button className="nav-more">More ▾</button>
        </div>
      </nav>
      <button className="nav-burger" aria-label="Menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">☰</span>
      </button>
      {open && (
        <div className="nav-menu" role="menu">
          {/* On phones every link is here; on wider screens only the ones that didn't fit. */}
          {items.map((i, n) => (
            <NavLink key={i.to} to={i.to} end={i.end} state={i.state} role="menuitem" className={() => `${n < fit ? "nav-menu-fits" : ""}${isOn(i, location.pathname) ? " active" : ""}`}>
              {i.label}
            </NavLink>
          ))}
          <button className="ghost nav-menu-signout" role="menuitem" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </>
  );
}

export function Layout() {
  const { me, logout } = useAuth();
  // Back lands where you were on the page before (the library's spot and selected game).
  useScrollMemory();
  const navigate = useNavigate();
  const user = me?.user;
  const admin = me?.role === "admin";
  // A few sections, like a console's home menu (LB and RB go round them); each section's pages
  // are a second row of links under the top bar.
  const links: NavItem[] = [
    { to: "/", label: "Home", end: true },
    {
      to: "/library",
      label: "Library",
      pages: [
        { to: "/library", label: "Games" },
        { to: "/emulation", label: "Emulation" },
        { to: "/updates", label: "Updates" },
        // Inside the desktop app the page is still there (Profile links to it for the Playnite extension), just not in the menu.
        ...(desktop ? [] : [{ to: "/apps", label: "Get the app" }]),
      ],
    },
    {
      // Kids too: they ask for games from these, and an admin approves.
      to: "/discover",
      label: "Discover",
      pages: [
        { to: "/discover", label: "Discover" },
        { to: "/wishlist", label: "Wishlist" },
        { to: "/calendar", label: "Calendar" },
        { to: "/requests", label: "Requests" },
        { to: "/news", label: "News" },
        // The desktop app's built-in web browser, for handhelds and the Xbox full screen experience. Kid-safe on kid profiles.
        ...(desktop?.openBrowser ? [{ to: "/browser", label: "Browser", state: { open: true } }] : []),
      ],
    },
    {
      to: "/game-night",
      label: "Family",
      pages: [
        { to: "/game-night", label: "Game night" },
        { to: "/screenshots", label: "Family wall" },
      ],
    },
    ...(admin ? [{ to: "/downloads", label: "Downloads" }] : []),
    // Everyone gets Settings for their own tab; the other tabs are admin only.
    { to: "/settings", label: "Settings" },
  ];
  const signOut = async () => {
    await logout();
    navigate("/login");
  };
  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="Home">
          {__BRAND__.wordmark ? (
            <img src={__BRAND__.wordmark} alt="LootDen" height={36} className="wordmark" />
          ) : (
            <>
              <BrandLogo size={36} />
              <span>LootDen</span>
            </>
          )}
        </NavLink>
        <MainNav items={links} onSignOut={signOut} />
        <div className="topbar-right">
          {me?.role === "admin" && <AlertsBell />}
          {desktop && <Battery />}
          {desktop && <Clock />}
          {user ? (
            <NavLink to="/profile" className="me" aria-label="Profile">
              <img src={avatarUrl(user.avatar)} alt="" width={36} height={36} className="avatar" />
              <span className="me-name">{user.displayName}</span>
            </NavLink>
          ) : (
            <span className="muted">Service token</span>
          )}
          <button className="ghost topbar-signout" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main>
        <SubNav items={links} />
        <AppUpdateBanner />
        <Outlet />
      </main>
      <PadHints />
      {/* Before Bandit, so Bandit opens over the in-game menu. */}
      <GameOverlay />
      <Bandit />
      <QuickMenus />
      <Keyboard />
      <FunLayer />
    </div>
  );
}

/** The pages of the section you're in (Library: Games, Emulation, Updates), remembered for LB/RB. */
function SubNav({ items }: { items: NavItem[] }) {
  const location = useLocation();
  const hub = items.find((i) => isOn(i, location.pathname));
  useEffect(() => {
    if (hub) lastPage.set(hub.to, location.pathname + location.search);
  }, [hub, location.pathname, location.search]);
  if (!hub?.pages || hub.pages.length < 2) return null;
  return (
    <nav className="subnav" aria-label={hub.label}>
      {hub.pages.map((p) => (
        <NavLink key={p.to} to={p.to} state={p.state} className={() => (isOn(p, location.pathname) ? "active" : "")}>
          {p.label}
        </NavLink>
      ))}
    </nav>
  );
}

interface BatteryInfo {
  level: number;
  charging: boolean;
}
type BatteryManager = BatteryInfo & EventTarget;

/** Battery left on a handheld or laptop, beside the clock. Nothing on a desktop PC without one. */
function Battery() {
  const [b, setB] = useState<BatteryInfo | null>(null);
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
    if (!nav.getBattery) return;
    let mgr: BatteryManager | null = null;
    const read = () => mgr && setB({ level: mgr.level, charging: mgr.charging });
    void nav.getBattery().then((m) => {
      mgr = m;
      // Desktops report a full battery that's always charging: no battery at all.
      if (m.level === 1 && m.charging && (m as unknown as { chargingTime: number }).chargingTime === 0) return;
      read();
      m.addEventListener("levelchange", read);
      m.addEventListener("chargingchange", read);
    }, () => {});
    return () => {
      mgr?.removeEventListener("levelchange", read);
      mgr?.removeEventListener("chargingchange", read);
    };
  }, []);
  if (!b) return null;
  const pct = Math.round(b.level * 100);
  const low = !b.charging && pct <= 15;
  return (
    <span className={`topbar-battery${low ? " low" : ""}`} title={`${pct}%${b.charging ? ", charging" : ""}`} aria-label={`Battery ${pct}%${b.charging ? ", charging" : ""}`}>
      <span className="battery-shell" aria-hidden="true">
        <span className="battery-fill" style={{ width: `${pct}%` }} />
      </span>
      {b.charging ? "⚡" : ""}
      {pct}%
    </span>
  );
}

/** The time, in the app's top bar, like a console's. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <time className="topbar-clock" dateTime={now.toISOString()}>
      {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
    </time>
  );
}
