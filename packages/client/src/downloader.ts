import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RateLimiter } from "./throttle.js";

export interface DownloadOptions {
  url: string;
  headers: Record<string, string>;
  dest: string;
  expectedSize: number;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  /** The PC's download speed limit, shared by every download. */
  limiter?: RateLimiter;
}

async function sizeOf(p: string): Promise<number | null> {
  try {
    return (await stat(p)).size;
  } catch {
    return null;
  }
}

/**
 * Downloads to "<dest>.part" and renames on completion. An existing .part file
 * is resumed with a Range request, so an interrupted 80 GB download picks up
 * where it stopped. Returns false when the file was already complete.
 */
export async function downloadFile(opts: DownloadOptions): Promise<boolean> {
  const { url, headers, dest, expectedSize, onProgress, signal, limiter } = opts;
  if ((await sizeOf(dest)) === expectedSize) return false;

  await mkdir(path.dirname(dest), { recursive: true });
  const partPath = `${dest}.part`;
  let offset = (await sizeOf(partPath)) ?? 0;
  if (offset > expectedSize) {
    await unlink(partPath);
    offset = 0;
  }

  if (offset < expectedSize || expectedSize === 0) {
    const res = await fetch(url, { headers: offset > 0 ? { ...headers, Range: `bytes=${offset}-` } : headers, signal });
    if (res.status === 416) {
      // The server's copy changed under us; start over.
      await unlink(partPath).catch(() => {});
      return downloadFile(opts);
    }
    if (!res.ok || !res.body) throw new Error(`Download failed with ${res.status} for ${path.basename(dest)}`);

    const resumed = res.status === 206;
    if (!resumed) offset = 0;
    let received = offset;
    onProgress?.(received, expectedSize);
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        received += chunk.length;
        onProgress?.(received, expectedSize);
        done(null, chunk);
      },
    });
    const source = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    const sink = createWriteStream(partPath, { flags: resumed ? "a" : "w" });
    if (limiter) await pipeline(source, limiter.stream(), meter, sink, { signal });
    else await pipeline(source, meter, sink, { signal });
  }

  const finalSize = await sizeOf(partPath);
  if (finalSize !== expectedSize) {
    throw new Error(`Size mismatch for ${path.basename(dest)}: expected ${expectedSize}, got ${finalSize}. Run install again to resume.`);
  }
  await rename(partPath, dest);
  return true;
}
