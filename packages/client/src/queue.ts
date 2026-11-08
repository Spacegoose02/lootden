import { inWindow } from "./throttle.js";

export type QueueState = "queued" | "waiting" | "running" | "paused";

export interface QueueItem {
  id: string;
  title: string;
  state: QueueState;
  /** Set when the item is held back: "Waits for 01:00" or "Paused". */
  note: string | null;
}

export interface QueueOptions {
  /** Downloads at once (1 is like Steam: one after another). */
  maxConcurrent: () => number;
  /** Only download in this daily window, e.g. overnight; null is any time. */
  window: () => { from: string; to: string } | null;
  clock?: () => Date;
  /** Called whenever the list or a state changes. */
  onChange?: (items: QueueItem[]) => void;
}

/** Thrown into a job when the queue stops it to resume later (outside the window, or paused). */
export class QueueHold extends Error {
  constructor(message = "Held back by the download queue") {
    super(message);
    this.name = "QueueHold";
  }
}

interface Job {
  id: string;
  title: string;
  run: (signal: AbortSignal) => Promise<unknown>;
  state: QueueState;
  /** Paused by hand: stays put until resumed. */
  held: boolean;
  controller: AbortController | null;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/**
 * The PC's download queue: downloads run in order, so many at a time, only inside the
 * download window if there is one, and can be moved up, paused and resumed. A job that's
 * stopped (window closed, paused) is aborted and started again later; downloads resume from
 * their .part files, so nothing already fetched is lost.
 */
export class DownloadQueue {
  private jobs: Job[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: QueueOptions) {}

  private now(): Date {
    return this.opts.clock?.() ?? new Date();
  }

  list(): QueueItem[] {
    const open = inWindow(this.opts.window(), this.now());
    const w = this.opts.window();
    return this.jobs.map((j) => ({
      id: j.id,
      title: j.title,
      state: j.state,
      note: j.held ? "Paused" : j.state === "waiting" && !open && w ? `Waits for ${w.from}` : null,
    }));
  }

  has(id: string): boolean {
    return this.jobs.some((j) => j.id === id);
  }

  /** Adds a download; resolves or rejects when it finally finishes (or is cancelled). */
  add(id: string, title: string, run: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    if (this.has(id)) return Promise.reject(new Error("Already in the download queue"));
    return new Promise((resolve, reject) => {
      this.jobs.push({ id, title, run, state: "queued", held: false, controller: null, resolve, reject });
      this.pump();
    });
  }

  /** Moves a download up or down one place, or to the top. */
  move(id: string, where: "up" | "down" | "top"): void {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i < 0) throw new Error("Not in the download queue");
    const [job] = this.jobs.splice(i, 1);
    const to = where === "top" ? 0 : where === "up" ? Math.max(0, i - 1) : Math.min(this.jobs.length, i + 1);
    this.jobs.splice(to, 0, job!);
    this.pump();
  }

  pause(id: string): void {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new Error("Not in the download queue");
    j.held = true;
    if (j.state === "running") this.stop(j);
    else j.state = "paused";
    this.pump();
  }

  resume(id: string): void {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new Error("Not in the download queue");
    j.held = false;
    if (j.state === "paused") j.state = "queued";
    this.pump();
  }

  /** Cancels a download for good (its .part files stay for a later install). */
  cancel(id: string): void {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    this.jobs = this.jobs.filter((x) => x !== j);
    j.controller?.abort(new Error("Cancelled"));
    j.reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
    this.pump();
  }

  private stop(j: Job): void {
    j.state = j.held ? "paused" : "waiting";
    const c = j.controller;
    j.controller = null;
    c?.abort(new QueueHold());
  }

  /** Starts, stops and re-checks what should run now. */
  pump(): void {
    const open = inWindow(this.opts.window(), this.now());
    const max = Math.max(1, Math.floor(this.opts.maxConcurrent() || 1));
    let slots = max;
    for (const j of this.jobs) {
      if (j.held) {
        if (j.state === "running") this.stop(j);
        j.state = "paused";
        continue;
      }
      const shouldRun = open && slots > 0;
      if (shouldRun) slots--;
      if (shouldRun && j.state !== "running") this.start(j);
      else if (!shouldRun && j.state === "running") this.stop(j);
      else if (!shouldRun) j.state = open ? "queued" : "waiting";
    }
    // Check the window again each minute while anything is waiting.
    const waiting = this.jobs.some((j) => j.state !== "running" && !j.held);
    if (waiting && !this.timer) {
      this.timer = setInterval(() => this.pump(), 60_000);
      this.timer.unref?.();
    } else if (!waiting && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.opts.onChange?.(this.list());
  }

  private start(j: Job): void {
    const controller = new AbortController();
    j.controller = controller;
    j.state = "running";
    j.run(controller.signal).then(
      (v) => this.finish(j, controller, () => j.resolve(v)),
      (err) => {
        // Stopped by the queue: it stays in the list and starts again later.
        if (controller.signal.aborted && controller.signal.reason instanceof QueueHold) {
          if (j.controller === controller) j.controller = null;
          this.pump();
          return;
        }
        this.finish(j, controller, () => j.reject(err));
      },
    );
  }

  private finish(j: Job, controller: AbortController, settle: () => void): void {
    if (j.controller !== controller && j.controller !== null) return;
    this.jobs = this.jobs.filter((x) => x !== j);
    settle();
    this.pump();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
