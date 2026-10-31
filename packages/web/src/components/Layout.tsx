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
import { useScrollMemory } from "../scrollMemory";

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  /** Passed to the page when the link itself is picked (not when LB/RB pass through it). */
  state?: unknown;
}

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
      const at = items.findIndex((i) => (i.end ? location.pathname === i.to : location.pathname.startsWith(i.to)));
      const next = items[at < 0 ? (by > 0 ? 0 : items.length - 1) : (at + by + items.length) % items.length];
      if (next) navigate(next.to);
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
  const activeHidden = hidden.some((i) => (i.end ? location.pathname === i.to : location.pathname.startsWith(i.to)));
  return (
    <>
      <nav className="nav" ref={bar} aria-label="Main">
        {items.slice(0, fit).map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end} state={i.state}>
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
            <NavLink key={i.to} to={i.to} end={i.end} state={i.state} role="menuitem" className={n < fit ? "nav-menu-fits" : ""}>
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
  const links: NavItem[] = [
    { to: "/", label: "Home", end: true },
    { to: "/library", label: "Library" },
    { to: "/updates", label: "Updates" },
    { to: "/emulation", label: "Emulation" },
    // Kids too: they ask for games from these, and an admin approves.
    { to: "/discover", label: "Discover" },
    { to: "/wishlist", label: "Wishlist" },
    { to: "/calendar", label: "Calendar" },
    { to: "/requests", label: "Requests" },
    { to: "/news", label: "News" },
    // The desktop app's built-in web browser, for handhelds and the Xbox full screen experience. Kid-safe on kid profiles.
    ...(desktop?.openBrowser ? [{ to: "/browser", label: "Browser", state: { open: true } }] : []),
    // Inside the desktop app the page is still there (Profile links to it for the Playnite extension), just not in the menu.
    ...(desktop ? [] : [{ to: "/apps", label: "Get the app" }]),
    ...(admin ? [{ to: "/downloads", label: "Downloads" }] : []),
    // Everyone gets Settings for the Themes tab; the other sections are admin only.
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
        <AppUpdateBanner />
        <Outlet />
      </main>
      <PadHints />
      <Bandit />
      <FunLayer />
    </div>
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

/** What the controller buttons do, along the bottom while a controller is in use (shown by CSS). */
function PadHints() {
  return (
    <footer className="pad-hints" aria-hidden="true">
      <span>
        <kbd className="pad-a">A</kbd>Select
      </span>
      <span>
        <kbd className="pad-b">B</kbd>Back
      </span>
      <span className="pad-hint-helper">
        <kbd className="pad-x">X</kbd>Bandit
      </span>
      <span>
        <kbd className="pad-y">Y</kbd>Filters and games
      </span>
      <span>
        <kbd className="pad-shoulder">LT RT</kbd>Tabs
      </span>
      <span>
        <kbd className="pad-shoulder">LB RB</kbd>Sections
      </span>
    </footer>
  );
}
