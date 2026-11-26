// Xbox remote play: streaming games from your own Xbox console (not Game Pass cloud gaming) in
// LootDen's built-in browser through xbox.com/play, or in Greenlight, the open-source Xbox
// streaming app. The console sends a 16:9 picture whatever the screen; on an ultrawide or
// 16:10 screen the fit modes below decide what happens to the spare room.

/** Xbox's own remote play page: signs in, lists your consoles and starts the stream. */
export const XBOX_REMOTE_PLAY_URL = "https://www.xbox.com/play/consoles";

/** The add-on id of games installed on an Xbox console (Play remotely instead of Play). */
export const XBOX_CONSOLE_ADDON = "xbox-console";

/** An Xbox console's id as Xbox Live and xbox.com/play know it ("F4001A2B3C4D5E6F"). */
export const isXboxConsoleId = (id: string) => /^[A-F0-9]{16}$/i.test(id);

/** The stream page for one console (xbox.com/play/consoles/launch/<id>), or the console list without one. */
export function xboxRemotePlayUrl(consoleId?: string | null): string {
  return consoleId && isXboxConsoleId(consoleId) ? `https://www.xbox.com/play/consoles/launch/${consoleId.toUpperCase()}` : XBOX_REMOTE_PLAY_URL;
}

/** Pages of xbox.com/play (cloud gaming and remote play). */
export function isXboxPlayUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    // Xbox's own player now lives on play.xbox.com (xbox.com/play forwards there).
    if (/^play\.xbox\.com$/i.test(u.hostname)) return true;
    return /^(www\.)?xbox\.com$/i.test(u.hostname) && /^\/([a-z]{2}-[a-z]{2}\/)?play(\/|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

export function isXboxStreamUrl(url: string): boolean {
  return isXboxPlayUrl(url) && /\/(play\/(consoles\/)?launch|remoteplay|launch)\//i.test(new URL(url).pathname);
}

/** A remote play stream itself (not the console list), where the controller should go straight to the game. */
export function isXboxRemoteStreamUrl(url: string): boolean {
  return isXboxPlayUrl(url) && /\/(play\/consoles\/launch|remoteplay)\//i.test(new URL(url).pathname);
}

/**
 * How the 16:9 stream fills the screen:
 * - fit: the whole picture, black bars at the sides on an ultrawide (Xbox's own look)
 * - zoom: fills the screen keeping the shape, cutting off the top and bottom (on 21:9 about a quarter of the height)
 * - stretch: fills the screen by widening the picture, nothing cut off but everything looks wider
 */
export const STREAM_FITS = ["fit", "zoom", "stretch"] as const;
export type StreamFit = (typeof STREAM_FITS)[number];

export const STREAM_FIT_LABELS: Record<StreamFit, string> = {
  fit: "Fit (16:9, bars on wide screens)",
  zoom: "Zoom to fill (crops top and bottom)",
  stretch: "Stretch to fill",
};

export const isStreamFit = (v: unknown): v is StreamFit => typeof v === "string" && (STREAM_FITS as readonly string[]).includes(v);

/** The next fit mode, for a button or shortcut that steps through them. */
export const nextStreamFit = (fit: StreamFit): StreamFit => STREAM_FITS[(STREAM_FITS.indexOf(fit) + 1) % STREAM_FITS.length]!;

/**
 * The style LootDen's browser adds to a stream page for a fit mode. Null for fit, which leaves
 * Xbox's own layout alone.
 */
export function streamFitCss(fit: StreamFit): string {
  const objectFit = fit === "zoom" ? "cover" : fit === "stretch" ? "fill" : "contain";
  // The stream is the only <video> on a stream page. It's pinned to the whole window in every
  // mode: Xbox's page can size and place the video's box itself, which on a wide window left it
  // off to one side, part covered, with the bars kept whatever the fit. A transform, filter or
  // containment on any box around the video would pin it to that box instead of the window, so
  // those come off the video's ancestors.
  return `html, body { background: #000 !important; overflow: hidden !important; } :has(> video), :has(video) { transform: none !important; filter: none !important; perspective: none !important; contain: none !important; will-change: auto !important; } video { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important; transform: none !important; object-fit: ${objectFit} !important; z-index: 0 !important; }`;
}
