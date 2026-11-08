import type { Db } from "../db/database.js";

/** Readings further apart than this aren't joined up: the plug or the broker was away. */
const MAX_GAP_MS = 5 * 60_000;
/** A reading older than this no longer counts as the PC's power draw. */
const STALE_MS = 10 * 60_000;

/** Energy is kept in five-minute slots, so a play session gets close to what its PC really used. */
const SLOT_MS = 5 * 60_000;
const slotOf = (t: number) => new Date(Math.floor(t / SLOT_MS) * SLOT_MS).toISOString().slice(0, 16);

/**
 * Power use per gaming PC, from a smart plug that reports watts over MQTT (Shelly, Tasmota,
 * Zigbee2MQTT...). Readings are added up into watt-hours per PC per hour, so a play session can
 * be given the energy its PC used while it ran.
 */
export class PowerMeter {
  private last = new Map<string, { at: number; watts: number }>();

  constructor(
    private readonly db: Db,
    private readonly clock: () => number = Date.now,
  ) {}

  /** A reading from a PC's plug. */
  record(device: string, watts: number): void {
    if (!Number.isFinite(watts) || watts < 0 || watts > 5000) return;
    const t = this.clock();
    const prev = this.last.get(device);
    this.last.set(device, { at: t, watts });
    if (!prev || t <= prev.at || t - prev.at > MAX_GAP_MS) return;
    // Average of the two readings over the time between them, split at slot boundaries.
    const avg = (prev.watts + watts) / 2;
    let from = prev.at;
    while (from < t) {
      const next = Math.min(t, (Math.floor(from / SLOT_MS) + 1) * SLOT_MS);
      const wh = (avg * (next - from)) / 3_600_000;
      this.db
        .prepare("INSERT INTO pc_energy (device, hour, wh) VALUES (?, ?, ?) ON CONFLICT(device, hour) DO UPDATE SET wh = wh + excluded.wh")
        .run(device, slotOf(from), wh);
      from = next;
    }
  }

  /** The PC's power draw right now, in watts; null when its plug hasn't reported lately. */
  watts(device: string): number | null {
    const l = this.last.get(device);
    return l && this.clock() - l.at < STALE_MS ? l.watts : null;
  }

  /** Watt-hours the PC used between two times, from the five-minute totals (slots partly inside count in part). */
  between(device: string, startIso: string, endIso: string): number | null {
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const rows = this.db.prepare("SELECT hour, wh FROM pc_energy WHERE device = ? AND hour >= ? AND hour <= ?").all(device, slotOf(start), slotOf(end)) as Array<{ hour: string; wh: number }>;
    if (!rows.length) return null;
    let total = 0;
    for (const r of rows) {
      const s0 = Date.parse(`${r.hour}:00.000Z`);
      const overlap = Math.min(end, s0 + SLOT_MS) - Math.max(start, s0);
      // Within a slot the energy is taken as spread evenly up to now (the current slot isn't over).
      const span = Math.min(SLOT_MS, Math.max(1, Math.min(this.clock(), s0 + SLOT_MS) - s0));
      if (overlap > 0) total += r.wh * Math.min(1, overlap / span);
    }
    return Math.round(total * 10) / 10;
  }

  /** kWh the PC used since a time (today, for Home Assistant's energy sensor). */
  kwhSince(device: string, sinceIso: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(wh), 0) AS wh FROM pc_energy WHERE device = ? AND hour >= ?").get(device, slotOf(Date.parse(sinceIso))) as { wh: number };
    return Math.round(row.wh / 10) / 100;
  }
}

/** Reads watts out of a plug's message: a bare number, or a JSON field such as power or ENERGY.Power. */
export function readWatts(payload: string, field: string): number | null {
  const text = payload.trim();
  if (!field) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  try {
    let v: unknown = JSON.parse(text);
    for (const part of field.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[part] : undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
