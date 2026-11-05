import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { bridgeError, desktop } from "../desktop";
import { feel } from "../feedback";
import { GAME_MENU_EVENT, HELPER_EVENT, HOME_EVENT, LETTER_EVENT, QUICK_MENU_EVENT } from "../gamepad";
import { useMarks } from "./Marks";

/** Which game a card or link is for: a library game, or another store's. */
type Target = { kind: "game"; id: string; title: string } | { kind: "store"; addon: string; externalId: string; title: string; href: string };

function targetOf(el: Element | null): Target | null {
  const link = el?.closest<HTMLAnchorElement>('a[href*="/games/"], a[href*="/store/"]');
  if (!link) return null;
  const url = new URL(link.href, location.href);
  const title = link.getAttribute("aria-label") || link.querySelector(".card-title")?.textContent || link.textContent?.trim() || "Game";
  const game = /^\/games\/([^/?#]+)$/.exec(url.pathname);
  if (game) return { kind: "game", id: decodeURIComponent(game[1]!), title };
  const store = /^\/store\/([^/]+)\/([^/?#]+)$/.exec(url.pathname);
  if (store) return { kind: "store", addon: decodeURIComponent(store[1]!), externalId: decodeURIComponent(store[2]!), title, href: url.pathname };
  return null;
}

/** A small menu that closes on B, Esc or a click outside and gives focus back to where it was. */
function Sheet({ label, at, onClose, children }: { label: string; at?: { x: number; y: number }; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const closing = useRef(onClose);
  closing.current = onClose;
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("button, a")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closing.current();
    };
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && closing.current();
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, []);
  // Next to the pointer for a right-click, kept on screen; in the middle for a controller.
  const style = at ? { left: Math.min(at.x, window.innerWidth - 260), top: Math.min(at.y, window.innerHeight - 340) } : undefined;
  return (
    <div className={`quick-sheet panel${at ? " at-pointer" : ""}`} role="menu" aria-label={label} ref={box} style={style}>
      <strong className="quick-sheet-title">{label}</strong>
      {children}
    </div>
  );
}

function Item({ onClick, children, danger }: { onClick: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" className={`quick-item${danger ? " danger" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

/** A game's options: Menu (Start) on its card, or a right-click on it. */
function GameMenu({ target, at, onClose }: { target: Target; at?: { x: number; y: number }; onClose: () => void }) {
  const navigate = useNavigate();
  const marks = useMarks();
  const key = target.kind === "game" ? target.id : `store:${target.addon}:${target.externalId}`;
  const m = marks.get(key);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (target.kind !== "game" || !desktop) return;
    void desktop.installed().then((list) => setInstalled(list.some((g) => g.gameId === target.id)), () => setInstalled(false));
  }, [target]);
  const page = target.kind === "game" ? `/games/${encodeURIComponent(target.id)}` : target.href;
  const run = (fn: () => Promise<unknown> | void) => async () => {
    try {
      await fn();
      onClose();
    } catch (e) {
      setError(bridgeError(e));
    }
  };
  return (
    <Sheet label={target.title} at={at} onClose={onClose}>
      <Item onClick={run(() => navigate(page))}>Open</Item>
      {target.kind === "game" && desktop && installed && <Item onClick={run(() => desktop!.play(target.id))}>▶ Play</Item>}
      {target.kind === "game" && desktop && installed === false && <Item onClick={run(() => navigate(`${page}?install=1`))}>⬇ Install</Item>}
      {target.kind === "game" && desktop && installed && <Item onClick={run(() => desktop!.openFolder(target.id))}>Open folder</Item>}
      <Item onClick={run(() => marks.set(key, { favourite: !m.favourite }))}>{m.favourite ? "♥ Remove from favourites" : "♡ Add to favourites"}</Item>
      <Item onClick={run(() => marks.set(key, { hidden: !m.hidden }))}>{m.hidden ? "Show in the library again" : "Hide from the library"}</Item>
      <Item onClick={run(() => navigator.clipboard?.writeText(new URL(page, location.href).href))}>Copy link</Item>
      {error && <p className="error small">{error}</p>}
    </Sheet>
  );
}

/** View (Select): the places and switches you want from anywhere. */
function QuickMenu({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { me, logout } = useAuth();
  const admin = me?.role === "admin";
  const go = (to: string) => () => {
    navigate(to);
    onClose();
  };
  return (
    <Sheet label="Quick menu" onClose={onClose}>
      <Item onClick={go("/")}>Home</Item>
      <Item onClick={go("/library?tab=installed")}>Installed games</Item>
      <Item onClick={go("/library")}>Library</Item>
      {admin && <Item onClick={go("/downloads")}>Downloads</Item>}
      <Item
        onClick={() => {
          onClose();
          window.dispatchEvent(new Event(HELPER_EVENT));
        }}
      >
        Ask Bandit
      </Item>
      {desktop?.openBrowser && <Item onClick={go("/browser")}>Browser</Item>}
      <Item onClick={go("/settings/controller")}>Controller settings</Item>
      <Item onClick={go("/profile")}>Profile</Item>
      {desktop && (
        <Item
          onClick={() => {
            void desktop!.toggleFullscreen();
            onClose();
          }}
        >
          Full screen on or off
        </Item>
      )}
      <Item
        onClick={async () => {
          onClose();
          await logout();
          navigate("/login");
        }}
      >
        Switch profile (sign out)
      </Item>
      {desktop?.quit && (
        <Item danger onClick={() => void desktop!.quit!()}>
          Quit LootDen
        </Item>
      )}
    </Sheet>
  );
}

/** L3 in a list of games: pick a letter and the selection jumps to the first game starting with it. */
function LetterJump({ onClose }: { onClose: () => void }) {
  const cards = [...document.querySelectorAll<HTMLElement>("main a.card[aria-label], main .collection a[href*='/games/']")];
  const first = new Map<string, HTMLElement>();
  for (const c of cards) {
    const t = (c.getAttribute("aria-label") || c.textContent || "").trim().replace(/^(the|a)\s+/i, "");
    const ch = t[0]?.toUpperCase() ?? "";
    const letter = /[A-Z]/.test(ch) ? ch : "#";
    if (!first.has(letter)) first.set(letter, c);
  }
  const letters = [..."#ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  return (
    <Sheet label="Jump to a letter" onClose={onClose}>
      <div className="letter-grid">
        {letters.map((l) => (
          <button
            key={l}
            type="button"
            role="menuitem"
            disabled={!first.has(l)}
            onClick={() => {
              const el = first.get(l);
              onClose();
              // After the sheet gives focus back, so it lands on the game.
              setTimeout(() => {
                el?.focus({ preventScroll: true });
                el?.scrollIntoView({ block: "center", behavior: "smooth" });
              }, 0);
            }}
          >
            {l}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

type Open = { kind: "game"; target: Target; at?: { x: number; y: number } } | { kind: "quick" } | { kind: "letters" } | null;

/** The controller's Menu, View and L3 menus, and right-clicking a game. Mounted once in Layout. */
export function QuickMenus() {
  const [open, setOpen] = useState<Open>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const onGame = (e: Event) => {
      const target = targetOf((e as CustomEvent<Element | null>).detail);
      if (!target) return;
      feel("open");
      setOpen({ kind: "game", target });
    };
    const onQuick = () => {
      feel("open");
      setOpen((o) => (o?.kind === "quick" ? null : { kind: "quick" }));
    };
    const onLetters = () => {
      if (!document.querySelector("main a.card[aria-label], main .collection a[href*='/games/']")) return;
      feel("open");
      setOpen({ kind: "letters" });
    };
    const onHome = () => navigate("/");
    // A right-click on a game; a right-click anywhere else keeps the usual menu.
    const onContext = (e: MouseEvent) => {
      if ((e.target as Element).closest("input, textarea, [contenteditable]")) return;
      const target = targetOf(e.target as Element);
      if (!target) return;
      e.preventDefault();
      setOpen({ kind: "game", target, at: { x: e.clientX, y: e.clientY } });
    };
    window.addEventListener(GAME_MENU_EVENT, onGame);
    window.addEventListener(QUICK_MENU_EVENT, onQuick);
    window.addEventListener(LETTER_EVENT, onLetters);
    window.addEventListener(HOME_EVENT, onHome);
    document.addEventListener("contextmenu", onContext);
    return () => {
      window.removeEventListener(GAME_MENU_EVENT, onGame);
      window.removeEventListener(QUICK_MENU_EVENT, onQuick);
      window.removeEventListener(LETTER_EVENT, onLetters);
      window.removeEventListener(HOME_EVENT, onHome);
      document.removeEventListener("contextmenu", onContext);
    };
  }, [navigate]);
  const close = () => setOpen(null);
  if (!open) return null;
  if (open.kind === "game") return <GameMenu target={open.target} at={open.at} onClose={close} />;
  if (open.kind === "quick") return <QuickMenu onClose={close} />;
  return <LetterJump onClose={close} />;
}
