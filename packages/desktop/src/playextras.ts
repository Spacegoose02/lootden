import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, screen } from "electron";

// ---- Discord Rich Presence ------------------------------------------------------

/**
 * Shows "Playing <game>" on Discord through the desktop Discord app's local IPC pipe
 * (discord-ipc-0..9). Needs a Discord application's id (made once at discord.com/developers).
 * Everything fails quietly: Discord closed, not installed, or a wrong id just shows nothing.
 */
export class DiscordPresence {
  private sock: net.Socket | null = null;
  private ready = false;
  private connecting: Promise<boolean> | null = null;
  private clientId = "";

  private static pipe(n: number): string {
    if (process.platform === "win32") return `\\\\?\\pipe\\discord-ipc-${n}`;
    const base = process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? os.tmpdir();
    return path.join(base, `discord-ipc-${n}`);
  }

  private static frame(op: number, body: object): Buffer {
    const json = Buffer.from(JSON.stringify(body));
    const head = Buffer.alloc(8);
    head.writeInt32LE(op, 0);
    head.writeInt32LE(json.length, 4);
    return Buffer.concat([head, json]);
  }

  private connect(clientId: string): Promise<boolean> {
    if (this.ready && this.clientId === clientId) return Promise.resolve(true);
    if (this.connecting) return this.connecting;
    this.close();
    this.clientId = clientId;
    this.connecting = (async () => {
      for (let n = 0; n < 10; n++) {
        const ok = await new Promise<boolean>((resolve) => {
          const s = net.createConnection(DiscordPresence.pipe(n));
          const fail = () => {
            s.destroy();
            resolve(false);
          };
          s.once("error", fail);
          s.setTimeout(3000, fail);
          s.once("connect", () => {
            s.write(DiscordPresence.frame(0, { v: 1, client_id: clientId }));
            // The first answer is READY (or an error frame for a bad id).
            s.once("data", (d: Buffer) => {
              s.setTimeout(0);
              s.removeListener("error", fail);
              const op = d.length >= 8 ? d.readInt32LE(0) : -1;
              if (op !== 1) return fail();
              s.on("error", () => this.close());
              s.on("close", () => this.close());
              this.sock = s;
              this.ready = true;
              resolve(true);
            });
          });
        });
        if (ok) return true;
      }
      return false;
    })().finally(() => (this.connecting = null));
    return this.connecting;
  }

  /** Shows a game, or clears the status with null. */
  async set(clientId: string, game: { title: string; startedAt: number; detail?: string } | null): Promise<void> {
    if (!clientId) return;
    if (!game && !this.ready) return;
    if (!(await this.connect(clientId)) || !this.sock) return;
    const activity = game
      ? {
          details: game.title.slice(0, 120),
          state: (game.detail ?? "via LootDen").slice(0, 120),
          timestamps: { start: game.startedAt },
          assets: { large_image: "lootden", large_text: "LootDen" },
          type: 0,
        }
      : null;
    this.sock.write(DiscordPresence.frame(1, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity }, nonce: `${Date.now()}-${Math.random()}` }));
  }

  close(): void {
    this.ready = false;
    this.sock?.destroy();
    this.sock = null;
  }
}

/** A Discord application id: a long number. */
export const cleanDiscordId = (v: unknown) => (/^\d{15,22}$/.test(String(v ?? "").trim()) ? String(v).trim() : "");

// ---- Launch splash -------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The splash page: the game's art full screen, its title and "Starting…". */
export function splashHtml(title: string, image: string | null, line = "Starting…"): string {
  const safeImage = image && /^(https?:|data:image\/)/i.test(image) ? image.replace(/["'()\\\s]/g, encodeURIComponent) : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'"><style>
html,body{margin:0;height:100%;background:#0d0820;color:#f3eeff;font-family:system-ui,sans-serif;overflow:hidden;cursor:none}
.bg{position:fixed;inset:0;background:#0d0820 center/cover no-repeat;${safeImage ? `background-image:url("${safeImage}");` : ""}filter:brightness(.55);animation:zoom 14s ease-out forwards}
.fade{position:fixed;inset:0;background:linear-gradient(transparent 40%,rgba(0,0,0,.85))}
.t{position:fixed;left:6vw;bottom:9vh;right:6vw}
h1{font-size:clamp(28px,6vw,72px);margin:0 0 .3em;text-shadow:0 4px 24px #000}
p{font-size:clamp(16px,2vw,24px);margin:0;opacity:.85;display:flex;align-items:center;gap:.6em}
.dot{width:.7em;height:.7em;border-radius:50%;background:currentColor;animation:pulse 1.2s ease-in-out infinite}
@keyframes zoom{from{transform:scale(1.08)}to{transform:scale(1)}}
@keyframes pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.bg,.dot{animation:none}}
</style></head><body><div class="bg"></div><div class="fade"></div><div class="t"><h1>${esc(title)}</h1><p><span class="dot"></span>${esc(line)}</p></div></body></html>`;
}

/**
 * Covers the screen while a game loads (handheld mode), so it doesn't flash the desktop.
 * Closes itself after `ms`, or earlier through the returned function.
 */
export function showSplash(title: string, image: string | null, ms = 12_000): () => void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = new BrowserWindow({
    ...display.bounds,
    frame: false,
    fullscreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: "#0d0820",
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  w.setIgnoreMouseEvents(true);
  w.once("ready-to-show", () => w.showInactive());
  void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(title, image))}`).catch(() => {});
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (!w.isDestroyed()) w.close();
  };
  const timer = setTimeout(close, ms);
  return close;
}
