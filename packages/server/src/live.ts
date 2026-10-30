import { EventEmitter } from "node:events";

/** What changed. The event carries no data: pages that care fetch again with their own permissions. */
export type LiveTopic = "library" | "alerts" | "downloads";

export interface LiveEvent {
  topic: LiveTopic;
  /** Only admins hear it (alerts, downloads). */
  adminOnly: boolean;
}

/**
 * Tells open web pages that something changed, so they fetch again at once instead of on a
 * timer. Bursts go out as one event per topic a moment later; library changes wait longer,
 * since metadata arrives game by game and each event makes open pages fetch the game list.
 */
export class LiveEvents {
  private readonly bus = new EventEmitter().setMaxListeners(0);
  private readonly pending = new Map<LiveTopic, NodeJS.Timeout>();

  constructor(private readonly delayMs: Record<LiveTopic, number> = { library: 2000, alerts: 250, downloads: 250 }) {}

  publish(topic: LiveTopic, adminOnly = false): void {
    if (this.pending.has(topic)) return;
    this.pending.set(
      topic,
      setTimeout(() => {
        this.pending.delete(topic);
        this.bus.emit("event", { topic, adminOnly } satisfies LiveEvent);
      }, this.delayMs[topic]).unref(),
    );
  }

  /** Returns the unsubscribe function. */
  subscribe(listener: (e: LiveEvent) => void): () => void {
    this.bus.on("event", listener);
    return () => this.bus.off("event", listener);
  }

  /** Ends every open stream (server shutdown). */
  close(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.bus.emit("close");
  }

  onClose(listener: () => void): () => void {
    this.bus.once("close", listener);
    return () => this.bus.off("close", listener);
  }
}
