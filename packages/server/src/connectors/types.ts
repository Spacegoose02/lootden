import type { TorrentPayload } from "./torrent.js";

export interface ActiveDownload {
  client: "qbittorrent" | "transmission" | "deluge" | "sabnzbd";
  /** Torrent hash or SABnzbd nzo id. */
  id: string;
  name: string;
  sizeBytes: number;
  progress: number; // 0..1
  downloadSpeed: number; // bytes/s
  etaSeconds: number | null;
  state: "downloading" | "paused" | "queued" | "completed" | "seeding" | "failed" | "checking";
  /** Where the client put the files (in the client's own path space). */
  path: string | null;
  /** In the client but outside our category: only used to follow a download we sent there. */
  outsideCategory?: boolean;
}

export interface DownloadClient {
  readonly name: ActiveDownload["client"];
  readonly configured: boolean;
  test(): Promise<string>;
  add(url: string, name?: string): Promise<string | null>;
  list(): Promise<ActiveDownload[]>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  remove(id: string, deleteFiles: boolean): Promise<void>;
}

/** A torrent client: takes a magnet or a .torrent file and reports the info hash it's tracked by. */
export interface TorrentClient extends DownloadClient {
  readonly name: "qbittorrent" | "transmission" | "deluge";
  addTorrent(payload: TorrentPayload, tag: string): Promise<string>;
}

/** How long to wait for a client to show a torrent it accepted (GM_TORRENT_VERIFY_MS for tests). */
export const verifyDelay = () => Number(process.env.GM_TORRENT_VERIFY_MS ?? 1000);
