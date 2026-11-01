import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Alert } from "../api";
import { useLive } from "../live";
import { useEscape } from "../escape";

const ICON: Record<Alert["kind"], string> = { released: "🎉", found: "🔎", grabbed: "⬇️", imported: "✅", updates: "🔄", flagged: "🛡️", sources: "📰", failed: "⚠️", test: "🔔" };

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString();
};

/** Admins' alerts: releases, finds, downloads, imports, updates and scan results. */
export function AlertsBell() {
  const [data, setData] = useState<{ alerts: Alert[]; unread: number }>({ alerts: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const load = () => void api.alerts().then(setData, () => {});
  useLive("alerts", load);
  useEffect(() => {
    load();
    // New alerts arrive live; this only catches anything a dropped connection missed.
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  // Esc, and B on a controller (sent as Esc while a pop-up is open), close it; it used to trap the d-pad.
  useEscape(() => setOpen(false), open);
  const toggle = () => {
    setOpen(!open);
    if (!open && data.unread) void api.readAlerts().then(() => setData((d) => ({ ...d, unread: 0 })));
  };
  return (
    <div className="alerts" ref={box}>
      <button className="ghost bell" onClick={toggle} aria-label={`Alerts${data.unread ? `, ${data.unread} new` : ""}`} aria-expanded={open}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z" />
        </svg>
        {data.unread > 0 && <span className="bell-count">{data.unread > 99 ? "99+" : data.unread}</span>}
      </button>
      {open && (
        <div className="alerts-menu" role="dialog" aria-label="Alerts">
          <header>
            <strong>Alerts</strong>
            <Link to="/settings/safety" onClick={() => setOpen(false)} className="small">
              Alert settings
            </Link>
          </header>
          {data.alerts.length === 0 ? (
            <p className="muted small">Nothing yet. Wishlist releases, finds, downloads, imports and updates show up here.</p>
          ) : (
            <ul>
              {data.alerts.slice(0, 30).map((a) => {
                const body = (
                  <>
                    <span aria-hidden="true">{ICON[a.kind]}</span>
                    <span>
                      <strong>{a.title}</strong>
                      {a.body && <small className="muted">{a.body}</small>}
                      <small className="muted">{ago(a.createdAt)}</small>
                    </span>
                  </>
                );
                return (
                  <li key={a.id} className={a.read ? "" : "unread"}>
                    {a.link ? (
                      <Link to={a.link} onClick={() => setOpen(false)}>
                        {body}
                      </Link>
                    ) : (
                      <div>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
