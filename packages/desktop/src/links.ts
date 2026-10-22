import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Links the app hands to the system: web pages and mail. Anything else (file:, smb:,
 * search-ms:, ms-msdt: ...) can open or run programs on Windows, so a link in a news feed
 * or a mod listing must never reach shell.openExternal with one of those.
 */
export function isExternalLink(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Whether url is on the server: the same scheme, host and port, not a name that merely starts the same. */
export function onOrigin(url: string, origin: string): boolean {
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Whether url is the given local file (ignoring ?query and #hash), such as the bundled setup page. */
export function isFile(url: string, file: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "file:") return false;
    u.search = "";
    u.hash = "";
    const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
    return same(path.resolve(fileURLToPath(u)), path.resolve(file));
  } catch {
    return false;
  }
}

/** Permissions the server's pages may have; the rest (camera, microphone, location ...) are refused. */
const SERVER_PERMISSIONS = new Set(["fullscreen", "pointerLock", "clipboard-sanitized-write", "notifications"]);

/** Embedded players (YouTube trailers) may go full screen; nothing else is granted outside the server. */
export function permissionAllowed(permission: string, requestingUrl: string, origin: string): boolean {
  if (permission === "fullscreen") return true;
  return SERVER_PERMISSIONS.has(permission) && onOrigin(requestingUrl, origin);
}
