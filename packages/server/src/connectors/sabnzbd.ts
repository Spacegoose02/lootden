import type { FetchLike } from "../metadata/http.js";
import type { ConnectorSettings } from "./settings.js";
import type { ActiveDownload, DownloadClient } from "./types.js";

interface QueueSlot {
  nzo_id: string;
  filename: string;
  mb: string;
  mbleft: string;
  percentage: string;
  status: string;
  timeleft: string;
  cat: string;
}

interface HistorySlot {
  nzo_id: string;
  name: string;
  bytes: number;
  status: string;
  storage: string | null;
  category: string;
  fail_message?: string;
}

const seconds = (t: string) => t.split(":").reduce((acc, n) => acc * 60 + Number(n), 0);

/**
 * A queue slot's status. SABnzbd marks only the job it's on right now "Downloading" and can work
 * on several at once; "Fetching"/"Grabbing" is it fetching the NZB, and the checks run in the queue.
 */
function queueState(status: string, queuePaused: boolean): ActiveDownload["state"] {
  if (status === "Paused" || queuePaused) return "paused";
  if (status === "Downloading" || status === "Fetching" || status === "Grabbing") return "downloading";
  if (status === "Checking" || status === "QuickCheck" || status === "Verifying" || status === "Repairing") return "checking";
  return "queued";
}

/** SABnzbd JSON API. */
export class SabnzbdClient implements DownloadClient {
  readonly name = "sabnzbd" as const;

  constructor(
    private readonly s: ConnectorSettings["sabnzbd"],
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get configured(): boolean {
    return !!(this.s.url && this.s.apiKey);
  }

  private async api<T>(params: Record<string, string>): Promise<T> {
    const q = new URLSearchParams({ ...params, apikey: this.s.apiKey, output: "json" });
    const res = await this.fetchImpl(`${this.s.url}/api?${q}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`SABnzbd answered ${res.status}`);
    const body = (await res.json()) as T & { status?: boolean; error?: string };
    if (body.error) throw new Error(`SABnzbd: ${body.error}`);
    return body;
  }

  async test(): Promise<string> {
    const r = await this.api<{ version: string }>({ mode: "version" });
    // "version" works without a valid key, so also touch the queue to check the key.
    await this.api({ mode: "queue", limit: "1" });
    return `SABnzbd ${r.version}`;
  }

  async add(url: string, name?: string): Promise<string | null> {
    const r = await this.api<{ status: boolean; nzo_ids?: string[] }>({ mode: "addurl", name: url, cat: this.s.category, ...(name ? { nzbname: name } : {}) });
    if (!r.status) throw new Error("SABnzbd did not accept the NZB");
    return r.nzo_ids?.[0] ?? null;
  }

  async list(): Promise<ActiveDownload[]> {
    // Not filtered by category: SABnzbd files a job under its default category when ours doesn't
    // exist there (or a sorter/indexer rule changes it), and a filtered list then never shows the
    // job we're tracking, so it sat as "Waiting for client" while SABnzbd downloaded it.
    const [{ queue }, ours, all] = await Promise.all([
      this.api<{ queue: { slots: QueueSlot[]; kbpersec: string; paused?: boolean } }>({ mode: "queue", limit: "500" }),
      this.s.category
        ? this.api<{ history: { slots: HistorySlot[] } }>({ mode: "history", category: this.s.category, limit: "50" })
        : Promise.resolve({ history: { slots: [] as HistorySlot[] } }),
      this.api<{ history: { slots: HistorySlot[] } }>({ mode: "history", limit: "100" }),
    ]);
    const speed = Number(queue.kbpersec) * 1024;
    const outside = (cat: string | undefined) => !!this.s.category && (cat ?? "").toLowerCase() !== this.s.category.toLowerCase();
    const active = queue.slots.map((s): ActiveDownload => {
      const state = queueState(s.status, !!queue.paused);
      return {
        client: this.name,
        id: s.nzo_id,
        name: s.filename,
        sizeBytes: Number(s.mb) * 1024 * 1024,
        progress: Number(s.percentage) / 100,
        downloadSpeed: state === "downloading" && s.status === "Downloading" ? speed : 0,
        etaSeconds: state === "downloading" && s.timeleft ? seconds(s.timeleft) : null,
        state,
        path: null,
        ...(outside(s.cat) ? { outsideCategory: true } : {}),
      };
    });
    const seen = new Set(queue.slots.map((s) => s.nzo_id));
    const done: ActiveDownload[] = [];
    for (const s of [...ours.history.slots, ...all.history.slots]) {
      if (seen.has(s.nzo_id)) continue;
      seen.add(s.nzo_id);
      done.push({
        client: this.name,
        id: s.nzo_id,
        name: s.name,
        sizeBytes: s.bytes,
        progress: s.status === "Completed" ? 1 : 0.99,
        downloadSpeed: 0,
        etaSeconds: null,
        state: s.status === "Completed" ? "completed" : s.status === "Failed" ? "failed" : "checking",
        path: s.storage,
        ...(outside(s.category) ? { outsideCategory: true } : {}),
      });
    }
    return [...active, ...done];
  }

  async pause(id: string) {
    await this.api({ mode: "queue", name: "pause", value: id });
  }

  async resume(id: string) {
    await this.api({ mode: "queue", name: "resume", value: id });
  }

  async remove(id: string, deleteFiles: boolean) {
    const del = deleteFiles ? "1" : "0";
    await this.api({ mode: "queue", name: "delete", value: id, del_files: del });
    await this.api({ mode: "history", name: "delete", value: id, del_files: del });
  }
}
