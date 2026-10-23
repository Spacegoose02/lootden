import { randomInt } from "node:crypto";
import { sha256 } from "./crypto.js";

/** No 0/O, 1/I/L: codes are read off one screen and typed (or picked with a controller) on another. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LIFETIME_MS = 10 * 60_000;

/**
 * Short codes that sign a new device in as someone who is already signed in elsewhere, so a
 * handheld or a TV PC doesn't need the password typed with a controller. A code works once and
 * for ten minutes; only its hash is kept, in memory (a restart drops the open ones).
 */
export class PairingCodes {
  private readonly codes = new Map<string, { userId: number; expires: number }>();

  issue(userId: number, at = Date.now()): { code: string; expiresAt: string } {
    this.prune(at);
    // One open code per person: asking again replaces it.
    for (const [k, v] of this.codes) if (v.userId === userId) this.codes.delete(k);
    let code = "";
    for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    this.codes.set(sha256(code), { userId, expires: at + LIFETIME_MS });
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: new Date(at + LIFETIME_MS).toISOString() };
  }

  /** The person the code belongs to, once; null for a wrong, used or expired code. */
  redeem(code: string, at = Date.now()): number | null {
    const clean = String(code).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean.length !== 8) return null;
    const key = sha256(clean);
    const entry = this.codes.get(key);
    this.codes.delete(key);
    return entry && entry.expires > at ? entry.userId : null;
  }

  private prune(at: number): void {
    for (const [k, v] of this.codes) if (v.expires <= at) this.codes.delete(k);
  }
}
