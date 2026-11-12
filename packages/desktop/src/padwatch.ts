import { spawn, type ChildProcess } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";

/**
 * Reads the controller while a game has focus, so a button combo can bring up LootDen's in-game
 * menu. The web page's Gamepad API stops the moment LootDen loses focus, so this runs in the
 * main process: XInput through a small PowerShell helper on Windows (no native module to
 * build), and the joystick devices (/dev/input/js*) on Linux.
 *
 * On Windows the helper also says which window was in front when the buttons changed (the game,
 * when the combo is pressed) and can bring a window to the front on request. That matters in the
 * Xbox full screen experience: it shows one app at a time and ignores always-on-top and minimize,
 * so the menu has to become the app in front, and going back to the game means putting the game
 * in front again, not just minimizing LootDen.
 */

/** Which combo opens the menu. "view-menu": hold View (Back) and Menu (Start); "guide": the Xbox button. */
export type OverlayCombo = "view-menu" | "guide" | "off";

/** Buttons we care about, as XInput's bits. */
export const BTN = { start: 0x0010, back: 0x0020, guide: 0x0400 } as const;

/** True when the buttons held make the combo. */
export function comboHeld(combo: OverlayCombo, buttons: number): boolean {
  if (combo === "view-menu") return (buttons & BTN.start) !== 0 && (buttons & BTN.back) !== 0;
  if (combo === "guide") return (buttons & BTN.guide) !== 0;
  return false;
}

/**
 * Polls XInput's four pads 30 times a second and prints the buttons held (all pads together), the
 * window in front and its program whenever the buttons change. XInputGetStateEx (ordinal 100) also
 * reports the Xbox button; older Windows without it falls back to XInputGetState. Lines on stdin of
 * the form "focus <hwnd>" bring that window to the front and answer "focus <hwnd> <how> <front now>
 * <its program>", where how is the step that worked or "refused"; "front" answers "front <hwnd>
 * <program>" for the window in front now.
 */
const XINPUT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LootDenPad {
  [StructLayout(LayoutKind.Sequential)] public struct State { public uint Packet; public ushort Buttons; public byte LT; public byte RT; public short LX; public short LY; public short RX; public short RY; }
  [DllImport("xinput1_4.dll", EntryPoint = "#100")] static extern int GetEx(int i, out State s);
  [DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")] static extern int Get(int i, out State s);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static bool ex = true;
  static readonly object outLock = new object();
  public static void Say(string line) { lock (outLock) { Console.Out.WriteLine(line); Console.Out.Flush(); } }
  // The program that owns a window, for the log ("?" when it can't be read).
  public static string Owner(IntPtr h) {
    try { uint pid; GetWindowThreadProcessId(h, out pid); return pid == 0 ? "-" : System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.Replace(' ', '_'); }
    catch (Exception) { return "?"; }
  }
  // Windows only lets the app in front hand the front to another window. Each step is tried only
  // when the one before didn't do it: a plain request, then joining the input of the window in
  // front, then an Alt tap (which lifts the foreground lock), then the Alt+Tab switcher's call.
  public static string Focus(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h)) return "gone";
    if (IsIconic(h)) ShowWindow(h, 9);
    BringWindowToTop(h);
    if (SetForegroundWindow(h) && GetForegroundWindow() == h) return "plain";
    uint me = GetCurrentThreadId();
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    bool joined = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    try { BringWindowToTop(h); SetForegroundWindow(h); }
    finally { if (joined) AttachThreadInput(me, fg, false); }
    if (GetForegroundWindow() == h) return "joined";
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(30);
    if (GetForegroundWindow() == h) return "alt";
    SwitchToThisWindow(h, true);
    System.Threading.Thread.Sleep(60);
    return GetForegroundWindow() == h ? "switch" : "refused";
  }
  public static void Listen() {
    var t = new System.Threading.Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        var parts = line.Trim().Split(' ');
        long h;
        if (parts.Length == 2 && parts[0] == "focus" && long.TryParse(parts[1], out h)) {
          string how;
          try { how = Focus(new IntPtr(h)); } catch (Exception e) { how = "error:" + e.GetType().Name; }
          IntPtr now = GetForegroundWindow();
          Say("focus " + h + " " + how + " " + now.ToInt64() + " " + Owner(now));
        } else if (parts.Length == 1 && parts[0] == "front") {
          IntPtr now = GetForegroundWindow();
          Say("front " + now.ToInt64() + " " + Owner(now));
        }
      }
      Environment.Exit(0);
    });
    t.IsBackground = true;
    t.Start();
  }
  public static int Held() {
    int all = 0;
    for (int i = 0; i < 4; i++) {
      State s; int r;
      if (ex) { try { r = GetEx(i, out s); } catch (EntryPointNotFoundException) { ex = false; r = Get(i, out s); } }
      else r = Get(i, out s);
      if (r == 0) all |= s.Buttons;
    }
    return all;
  }
}
'@
[LootDenPad]::Listen()
[LootDenPad]::Say("ready")
$last = -1
while ($true) {
  $b = [LootDenPad]::Held()
  if ($b -ne $last) { $w = [LootDenPad]::GetForegroundWindow(); [LootDenPad]::Say("$b " + $w.ToInt64() + " " + [LootDenPad]::Owner($w)); $last = $b }
  Start-Sleep -Milliseconds 33
}
`;

/** One line from the Windows helper: the buttons held and the window in front (and its program). */
export function parseHelperLine(line: string): [buttons: number | null, foreground: number | null, program: string | null] {
  const [b, w, p] = line.trim().split(/\s+/);
  const buttons = b ? Number(b) : NaN;
  const fg = w ? Number(w) : NaN;
  return [Number.isInteger(buttons) ? buttons : null, Number.isSafeInteger(fg) ? fg : null, p || null];
}

/** Linux joystick events (struct js_event): button numbers on the xpad driver. */
const JS_BUTTONS: Record<number, number> = { 6: BTN.back, 7: BTN.start, 8: BTN.guide };

export class PadWatcher {
  private child: ChildProcess | null = null;
  private files: FileHandle[] = [];
  private buttons = 0;
  private perPad = new Map<number, number>();
  private heldSince = 0;
  private fired = false;
  private timer: NodeJS.Timeout | null = null;
  /** The window in front when the buttons last changed (Windows), as a number. */
  private foreground = 0;
  /** The window that was in front when the combo fired: the game, usually. */
  private comboWindow = 0;
  private foregroundProgram: string | null = null;

  constructor(
    private readonly combo: () => OverlayCombo,
    private readonly onCombo: () => void,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** The window that was in front when the combo last fired (0 when unknown). */
  get windowAtCombo(): number {
    return this.comboWindow;
  }

  private frontWaiters: Array<(hwnd: number) => void> = [];

  /**
   * The window in front right now (Windows, while the watcher runs), for the keyboard shortcut,
   * which has no button change to go by. 0 when unknown or the helper is slow to answer.
   */
  frontWindow(timeoutMs = 300): Promise<number> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return Promise.resolve(0);
    return new Promise((resolve) => {
      const done = (hwnd: number) => {
        clearTimeout(timer);
        this.frontWaiters = this.frontWaiters.filter((w) => w !== done);
        resolve(hwnd);
      };
      const timer = setTimeout(() => done(0), timeoutMs);
      this.frontWaiters.push(done);
      stdin.write("front\n");
    });
  }

  /** Brings a window to the front (Windows, while the watcher runs). False when it couldn't ask. */
  focusWindow(hwnd: number): boolean {
    const stdin = this.child?.stdin;
    if (!hwnd || !stdin || stdin.destroyed) return false;
    stdin.write(`focus ${hwnd}\n`);
    return true;
  }

  get running(): boolean {
    return !!this.child || this.files.length > 0;
  }

  start(): void {
    if (this.running || this.combo() === "off") return;
    if (process.platform === "win32") this.startWindows();
    else if (process.platform === "linux") void this.startLinux();
    // The combo has to be held a moment, so pressing Start then Back in a game doesn't open it.
    this.timer = setInterval(() => this.check(), 50);
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    for (const f of this.files) void f.close().catch(() => {});
    this.files = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.buttons = 0;
    this.perPad.clear();
  }

  private check(): void {
    if (!comboHeld(this.combo(), this.buttons)) {
      this.heldSince = 0;
      this.fired = false;
      return;
    }
    const now = Date.now();
    if (!this.heldSince) this.heldSince = now;
    if (!this.fired && now - this.heldSince >= 350) {
      this.fired = true;
      this.comboWindow = this.foreground;
      this.log(`combo held; in front: window ${this.foreground} (${this.foregroundProgram ?? "unknown"})`);
      this.onCombo();
    }
  }

  private startWindows(): void {
    // -EncodedCommand: a script read from stdin runs line by line, which breaks the here-string.
    const encoded = Buffer.from(XINPUT_SCRIPT, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin?.on("error", () => {});
    this.child = child;
    let buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("front ")) {
          const [, w, prog] = line.split(/\s+/);
          this.log(`shortcut pressed; in front: window ${w} (${prog ?? "unknown"})`);
          for (const done of [...this.frontWaiters]) done(Number(w) || 0);
          continue;
        }
        if (line === "ready" || line.startsWith("focus ")) {
          this.log(`controller helper: ${line}`);
          continue;
        }
        const [n, fg, prog] = parseHelperLine(line);
        if (n !== null) this.buttons = n;
        if (fg !== null) this.foreground = fg;
        if (prog) this.foregroundProgram = prog;
      }
    });
    child.stderr?.on("data", (d: Buffer) => this.log(`controller watcher: ${String(d).trim().slice(0, 200)}`));
    child.on("exit", (code) => {
      this.log(`controller helper stopped (${code})`);
      if (this.child === child) this.child = null;
    });
  }

  private async startLinux(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      const f = await open(`/dev/input/js${i}`, "r").catch(() => null);
      if (!f) continue;
      this.files.push(f);
      void this.readJs(f, i);
    }
  }

  private async readJs(f: FileHandle, pad: number): Promise<void> {
    const ev = Buffer.alloc(8);
    for (;;) {
      const { bytesRead } = await f.read(ev, 0, 8, null).catch(() => ({ bytesRead: 0 }));
      if (bytesRead < 8 || !this.files.includes(f)) return;
      const value = ev.readInt16LE(4);
      const type = ev.readUInt8(6) & ~0x80; // 0x80: the initial state
      const bit = JS_BUTTONS[ev.readUInt8(7)];
      if (type !== 1 || !bit) continue;
      const held = this.perPad.get(pad) ?? 0;
      this.perPad.set(pad, value ? held | bit : held & ~bit);
      this.buttons = [...this.perPad.values()].reduce((a, b) => a | b, 0);
    }
  }
}
