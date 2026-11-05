/** Where a link sent to LootDen's downloads goes: the torrent client, SABnzbd, or the Download Manager (file hosts and direct files). */
export type DownloadLinkKind = "torrent" | "usenet" | "direct";

/** Which downloader takes a link, or null for one LootDen can't download (a web page in another scheme, say). */
export function downloadLinkKind(url: string): DownloadLinkKind | null {
  const u = url.trim();
  if (/^magnet:\?/i.test(u)) return /[?&]xt=urn:bt[im]h:/i.test(u) ? "torrent" : null;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (/\.torrent$/i.test(parsed.pathname)) return "torrent";
  if (/\.nzb$/i.test(parsed.pathname)) return "usenet";
  return "direct";
}

/** A name for a download from its link: a magnet's display name, else the file name in the address. */
export function downloadLinkTitle(url: string): string {
  const u = url.trim();
  if (/^magnet:\?/i.test(u)) {
    const dn = new URLSearchParams(u.slice(u.indexOf("?") + 1)).get("dn");
    if (dn?.trim()) return dn.trim().slice(0, 200);
    const hash = u.match(/xt=urn:bt[im]h:([a-z0-9]+)/i)?.[1];
    return hash ? `Magnet ${hash.slice(0, 12)}` : "Magnet link";
  }
  try {
    const parsed = new URL(u);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    const name = last ? decodeURIComponent(last).replace(/\.(torrent|nzb)$/i, "") : "";
    return (name || parsed.hostname).slice(0, 200);
  } catch {
    return "Download";
  }
}
