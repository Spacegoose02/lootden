import { useEffect, useRef } from "react";

/** What the server says changed (see packages/server/src/live.ts). */
export type LiveTopic = "library" | "alerts" | "downloads" | "playing" | "screenshots";
const TOPICS: LiveTopic[] = ["library", "alerts", "downloads", "playing", "screenshots"];

const listeners = new Map<LiveTopic, Set<() => void>>(TOPICS.map((t) => [t, new Set()]));
let source: EventSource | null = null;
let retry: number | undefined;
let lost = false;

const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
const fire = (topic: LiveTopic) => listeners.get(topic)!.forEach((f) => f());

/**
 * One EventSource for the whole page, open while any component listens. The browser
 * reconnects by itself after a dropped connection; when the server refuses outright (signed
 * out, restarting) it's tried again after a while. After a gap everything refreshes, since
 * events may have been missed.
 */
function connect(): void {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource("/api/events");
  for (const t of TOPICS) source.addEventListener(t, () => fire(t));
  source.onopen = () => {
    if (lost) TOPICS.forEach(fire);
    lost = false;
  };
  source.onerror = () => {
    lost = true;
    if (source?.readyState !== EventSource.CLOSED) return;
    source = null;
    retry = window.setTimeout(() => {
      retry = undefined;
      if (count()) connect();
    }, 15_000);
  };
}

function disconnect(): void {
  source?.close();
  source = null;
  window.clearTimeout(retry);
  retry = undefined;
}

/** Calls fn whenever the server says topic changed. */
export function useLive(topic: LiveTopic, fn: () => void): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const f = () => latest.current();
    listeners.get(topic)!.add(f);
    connect();
    return () => {
      listeners.get(topic)!.delete(f);
      if (!count()) disconnect();
    };
  }, [topic]);
}
