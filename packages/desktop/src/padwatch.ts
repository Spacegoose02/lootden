import { spawn, type ChildProcess } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";

/**
 * Reads the controller while a game has focus, so a button combo can bring up LootDen's in-game
 * menu. The web page's Gamepad API stops the moment LootDen loses focus, so this runs in the
 * main process: XInput through a small PowerShell helper on Windows (no native module to
 * build), and the joystick devices (/dev/input/js*) on Linux.
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
 * Polls XInput's four pads 30 times a second and prints the buttons held (all pads together)
 * whenever they change. XInputGetStateEx (ordinal 100) also reports the Xbox button; older
 * Windows without it falls back to XInputGetState.
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
  static bool ex = true;
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
$last = -1
while ($true) {
  $b = [LootDenPad]::Held()
  if ($b -ne $last) { [Console]::Out.WriteLine($b); [Console]::Out.Flush(); $last = $b }
  Start-Sleep -Milliseconds 33
}
`;

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

  constructor(
    private readonly combo: () => OverlayCombo,
    private readonly onCombo: () => void,
    private readonly log: (msg: string) => void = () => {},
  ) {}

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
      this.onCombo();
    }
  }

  private startWindows(): void {
    // -EncodedCommand: a script read from stdin runs line by line, which breaks the here-string.
    const encoded = Buffer.from(XINPUT_SCRIPT, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const n = Number(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
        if (Number.isFinite(n)) this.buttons = n;
      }
    });
    child.stderr?.on("data", (d: Buffer) => this.log(`controller watcher: ${String(d).trim().slice(0, 200)}`));
    child.on("exit", () => {
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
