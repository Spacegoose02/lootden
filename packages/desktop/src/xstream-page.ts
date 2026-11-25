// The Xbox stream window's page (setup/xstream.html), bundled for the browser into
// dist/xstream-page.js. It plays the stream with xbox-xcloud-player (MIT, the WebRTC player
// Greenlight uses): video, audio, the controller and rumble. The main process holds the sign-in
// and the session, and passes the connection offers back and forth.

import * as playerLib from "xbox-xcloud-player";

type StreamFit = "fit" | "zoom" | "stretch";
const FITS: StreamFit[] = ["fit", "zoom", "stretch"];
const FIT_LABELS: Record<StreamFit, string> = { fit: "⬛ Fit", zoom: "⤢ Zoom", stretch: "↔ Stretch" };
const FIT_HINTS: Record<StreamFit, string> = {
  fit: "16:9 with bars on a wide screen",
  zoom: "Fills a wide screen, cutting off the top and bottom",
  stretch: "Fills a wide screen by widening the picture",
};

interface Bridge {
  info(): Promise<{ consoleName: string; game: string | null; fit: StreamFit; rumble: boolean }>;
  start(): Promise<void>;
  sdp(offer: string, chat?: boolean): Promise<string>;
  ice(candidates: Array<{ candidate: string; sdpMLineIndex: number | null; sdpMid: string | null }>): Promise<unknown[]>;
  keepalive(): Promise<void>;
  setFit(fit: StreamFit): Promise<void>;
  fullscreen(): Promise<void>;
  close(): Promise<void>;
  onState(cb: (state: string) => void): void;
}

/** The player object, as much of its API as this page uses. */
interface Player {
  bind(): void;
  createOffer(): Promise<{ sdp: string }>;
  setRemoteOffer(sdp: string): void;
  setSdpHandler(fn: (client: unknown, offer: { sdp: string }) => void): void;
  getIceCandidates(): RTCIceCandidate[];
  setIceCandidates(candidates: unknown[]): void;
  setControllerRumble(on: boolean): void;
  getEventBus(): { on(event: string, fn: (e: { state: string }) => void): void };
  getChannelProcessor(name: string): { pressButton(index: number, button: string): void } | undefined;
  close(): void;
}
type PlayerClass = new (elementId: string, config?: Record<string, unknown>) => Player;

// The library is CommonJS with its class as `default`; esbuild may wrap it once more.
const lib = playerLib as unknown as { default?: PlayerClass | { default?: PlayerClass } };
const XCloudPlayer = (typeof lib.default === "function" ? lib.default : (lib.default as { default?: PlayerClass } | undefined)?.default) as PlayerClass;

const xs = (window as unknown as { lootdenXstream: Bridge }).lootdenXstream;
const $ = (id: string) => document.getElementById(id)!;

let player: Player | null = null;
let keepalive: ReturnType<typeof setInterval> | undefined;
let fit: StreamFit = "fit";
let consoleName = "your Xbox";
let ending = false;

function showStatus(title: string, detail: string, opts: { error?: boolean; busy?: boolean } = {}) {
  $("status").hidden = false;
  $("title").textContent = title;
  $("detail").textContent = detail;
  $("detail").className = opts.error ? "error" : "";
  $("spinner").hidden = !opts.busy;
  $("actions").hidden = !opts.error;
}

function applyFit(next: StreamFit, save = true) {
  fit = next;
  document.body.dataset.fit = fit;
  $("fit").textContent = FIT_LABELS[fit];
  $("fit").title = `${FIT_HINTS[fit]}. Click for the next one (Ctrl+Shift+F)`;
  if (save) void xs.setFit(fit);
}

const STATE_LINES: Record<string, string> = {
  Provisioning: `Waking ${consoleName} if it's asleep…`,
  WaitingForResources: "Xbox is getting the stream ready…",
  ReadyToConnect: "Handing the console to this PC…",
  Provisioned: "Connecting…",
};

async function connect(): Promise<void> {
  showStatus(`Connecting to ${consoleName}…`, "Waking the console if it's asleep. This takes a few seconds.", { busy: true });
  try {
    await xs.start();
  } catch (e) {
    return showStatus("Couldn't start remote play", cleanError(e), { error: true });
  }
  $("player").replaceChildren();
  const p = new XCloudPlayer("player", { ui_systemui: [], input_touch: false, input_mousekeyboard: false, input_legacykeyboard: true });
  player = p;
  p.bind();
  const info = await xs.info().catch(() => null);
  p.setControllerRumble(info?.rumble ?? true);
  // The console asks again when chat (the headset) starts.
  p.setSdpHandler((_client, offer) => {
    xs.sdp(offer.sdp, true).then(
      (answer) => p.setRemoteOffer(answer),
      () => {},
    );
  });
  p.getEventBus().on("connectionstate", (event) => {
    if (event.state === "connected") {
      $("status").hidden = true;
      clearInterval(keepalive);
      // Without these the console ends the session after a minute or so.
      keepalive = setInterval(() => void xs.keepalive().catch(() => {}), 30_000);
    } else if (event.state === "failed") {
      showStatus("The stream stopped", "The connection to the console dropped. Check both are online, then try again.", { error: true });
    } else if (event.state === "closed" && !ending) {
      showStatus("The stream ended", "The console ended the stream.", { error: true });
    }
  });
  try {
    const offer = await p.createOffer();
    p.setRemoteOffer(await xs.sdp(offer.sdp));
    const candidates = p.getIceCandidates().map((c) => ({ candidate: c.candidate, sdpMLineIndex: c.sdpMLineIndex, sdpMid: c.sdpMid }));
    p.setIceCandidates(await xs.ice(candidates));
  } catch (e) {
    showStatus("Couldn't connect to the console", cleanError(e), { error: true });
  }
}

function cleanError(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function end() {
  ending = true;
  clearInterval(keepalive);
  try {
    player?.close();
  } catch {
    // Already closed.
  }
  void xs.close();
}

// ---- The bar: the mouse at the top, or View + Menu held on a controller ---------------

let barTimer: ReturnType<typeof setTimeout> | undefined;
function showBar(ms = 4000) {
  document.body.classList.add("bar");
  clearTimeout(barTimer);
  barTimer = setTimeout(() => document.body.classList.remove("bar"), ms);
}
document.addEventListener("mousemove", (e) => {
  if (e.clientY < 80) showBar();
});

$("fit").addEventListener("click", () => applyFit(FITS[(FITS.indexOf(fit) + 1) % FITS.length]!));
$("guide").addEventListener("click", () => player?.getChannelProcessor("input")?.pressButton(0, "Nexus"));
$("full").addEventListener("click", () => void xs.fullscreen());
$("close").addEventListener("click", end);
$("close2").addEventListener("click", end);
$("retry").addEventListener("click", () => {
  try {
    player?.close();
  } catch {
    // Already closed.
  }
  player = null;
  void connect();
});

document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    applyFit(FITS[(FITS.indexOf(fit) + 1) % FITS.length]!);
    showBar(2000);
  } else if (ctrl && e.key.toLowerCase() === "q") {
    e.preventDefault();
    end();
  } else if (e.key === "F11") {
    e.preventDefault();
    void xs.fullscreen();
  }
});

// View + Menu held for a second shows the bar and gives it the controller's focus; the presses
// still reach the console too, as they would with Greenlight.
let comboSince = 0;
function poll() {
  const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p);
  const combo = !!pad && !!pad.buttons[8]?.pressed && !!pad.buttons[9]?.pressed;
  if (combo && !comboSince) comboSince = performance.now();
  if (!combo) comboSince = 0;
  if (comboSince && performance.now() - comboSince > 1000) {
    comboSince = Number.POSITIVE_INFINITY;
    showBar(8000);
    $("fit").focus();
  }
  requestAnimationFrame(poll);
}
requestAnimationFrame(poll);

xs.onState((state) => {
  if (!$("status").hidden && STATE_LINES[state]) $("detail").textContent = STATE_LINES[state]!.replace("your Xbox", consoleName);
});

void xs.info().then((info) => {
  consoleName = info.consoleName || consoleName;
  applyFit(info.fit, false);
  document.title = `${info.game ? `${info.game} · ` : ""}${consoleName} · LootDen`;
  void connect();
});
