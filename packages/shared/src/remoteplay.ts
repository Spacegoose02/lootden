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
    return u.protocol === "https:" && /^(www\.)?xbox\.com$/i.test(u.hostname) && /^\/([a-z]{2}-[a-z]{2}\/)?play(\/|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** A stream page (remote play or cloud gaming), where the fit mode applies. */
export function isXboxStreamUrl(url: string): boolean {
  return isXboxPlayUrl(url) && /\/play\/(consoles\/)?launch\//i.test(new URL(url).pathname);
}

/** A remote play stream itself (not the console list), where the controller should go straight to the game. */
export function isXboxRemoteStreamUrl(url: string): boolean {
  return isXboxPlayUrl(url) && /\/play\/consoles\/launch\//i.test(new URL(url).pathname);
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
export function streamFitCss(fit: StreamFit): string | null {
  if (fit === "fit") return null;
  const objectFit = fit === "zoom" ? "cover" : "fill";
  // The stream is the only <video> on a stream page, laid over the whole page with object-fit:
  // contain, which keeps it 16:9 (the way Better xCloud's aspect ratio option works too).
  return `video { width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important; object-fit: ${objectFit} !important; }`;
}
