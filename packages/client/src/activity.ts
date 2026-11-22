/** A long job the desktop app runs in the background, such as applying an update. */
export interface ActivityItem {
  /** The job's id: the update's game id for an update or DLC. */
  id: string;
  kind: "update" | "dlc";
  /** What's being done: the update's title. */
  title: string;
  /** The installed game it's for, to link to. */
  gameId: string | null;
  gameTitle: string | null;
  /** The latest status line ("Downloading", "Copying the update into ..."). */
  message: string;
  /** Bytes so far and in all while downloading; null otherwise. */
  received: number | null;
  total: number | null;
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

  constructor(private readonly onChange?: (items: ActivityItem[]) => void, private readonly clock: () => Date = () => new Date()) {}

  list(): ActivityItem[] {
    return [...this.items.values()].map((i) => ({ ...i }));
  }

  get(id: string): ActivityItem | null {
    const i = this.items.get(id);
    return i ? { ...i } : null;
  }

  start(id: string, item: Pick<ActivityItem, "kind" | "title"> & Partial<Pick<ActivityItem, "gameId" | "gameTitle" | "message">>): void {
    this.items.set(id, {
      id,
      kind: item.kind,
      title: item.title,
      gameId: item.gameId ?? null,
      gameTitle: item.gameTitle ?? null,
      message: item.message ?? "Starting…",
      received: null,
      total: null,
      cancellable: true,
      startedAt: this.clock().toISOString(),
    });
    this.changed();
  }

  update(id: string, patch: Partial<Pick<ActivityItem, "message" | "received" | "total" | "cancellable">>): void {
    const cur = this.items.get(id);
    if (!cur) return;
    this.items.set(id, { ...cur, ...patch });
    this.changed();
  }

  end(id: string): void {
    if (this.items.delete(id)) this.changed();
  }

  private changed(): void {
    this.onChange?.(this.list());
  }
}
