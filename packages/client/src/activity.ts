import { RateMeter } from "./rate.js";

/**
 * What a background job is doing: applying an update or DLC, zipping and uploading an
 * installed game to the server, checking or repairing a game's files, or deleting a game.
 */
export type ActivityKind = "update" | "dlc" | "upload" | "verify" | "repair" | "uninstall";

/** A long job the desktop app runs in the background, such as applying an update. */
export interface ActivityItem {
  /** The job's id: the update's game id for an update or DLC, else the job's own key. */
  id: string;
  kind: ActivityKind;
  /** What's being done: the update's title, or the game's. */
  title: string;
  /** The installed game it's for, to link to. */
  gameId: string | null;
  gameTitle: string | null;
  /** The latest status line ("Downloading", "Copying the update into ..."). */
  message: string;
  /** Done so far and in all (bytes, or files when unit is "files"); null when there's no measure. */
  received: number | null;
  total: number | null;
  /** What received and total count. */
  unit: "bytes" | "files";
  /** Units per second lately, and seconds left at that rate; null until there's a rate. */
  rate: number | null;
  etaSeconds: number | null;
  /** It can still be stopped (downloading or unpacking, not while files are copied in). */
  cancellable: boolean;
  startedAt: string;
}

/**
 * The background jobs running on this PC, kept by the desktop app rather than the page, so a
 * job started on one page keeps going (and stays visible) after you move to another.
 */
export class ActivityBoard {
  private items = new Map<string, ActivityItem>();
  private meters = new Map<string, RateMeter>();

  constructor(private readonly onChange?: (items: ActivityItem[]) => void, private readonly clock: () => Date = () => new Date()) {}

  list(): ActivityItem[] {
    return [...this.items.values()].map((i) => ({ ...i }));
  }

  get(id: string): ActivityItem | null {
    const i = this.items.get(id);
    return i ? { ...i } : null;
  }

  start(id: string, item: Pick<ActivityItem, "kind" | "title"> & Partial<Pick<ActivityItem, "gameId" | "gameTitle" | "message" | "cancellable" | "unit">>): void {
    this.meters.set(id, new RateMeter(() => this.clock().getTime()));
    this.items.set(id, {
      id,
      kind: item.kind,
      title: item.title,
      gameId: item.gameId ?? null,
      gameTitle: item.gameTitle ?? null,
      message: item.message ?? "Starting…",
      received: null,
      total: null,
      unit: item.unit ?? "bytes",
      rate: null,
      etaSeconds: null,
      cancellable: item.cancellable ?? true,
      startedAt: this.clock().toISOString(),
    });
    this.changed();
  }

  /**
   * Changes a job's status. A new received count feeds its speed and time left; a step with
   * nothing to count (received null) clears them, and a new total starts the speed afresh.
   */
  update(id: string, patch: Partial<Pick<ActivityItem, "message" | "received" | "total" | "cancellable" | "unit">>): void {
    const cur = this.items.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    if ("received" in patch || "total" in patch) {
      if (next.received === null || next.total === null || next.total !== cur.total || next.unit !== cur.unit) this.meters.set(id, new RateMeter(() => this.clock().getTime()));
      const meter = this.meters.get(id)!;
      next.rate = next.received === null ? null : meter.sample(next.received);
      next.etaSeconds = next.received === null || next.total === null ? null : meter.eta(next.received, next.total);
    }
    this.items.set(id, next);
    this.changed();
  }

  end(id: string): void {
    this.meters.delete(id);
    if (this.items.delete(id)) this.changed();
  }

  private changed(): void {
    this.onChange?.(this.list());
  }
}
