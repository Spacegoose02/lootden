import { randomBytes } from "node:crypto";
import { now, type Db } from "../db/database.js";
import { newSecret, safeEqual, sha256 } from "./crypto.js";
import { otpauthUri, newTotpSecret, verifyTotp } from "./totp.js";
import type { Vault } from "./vault.js";
import { newChallenge, verifyAssertion, verifyRegistration, type AssertionResponse, type Expected, type RegistrationResponse } from "./webauthn.js";

const TICKET_MS = 5 * 60_000;
const CHALLENGE_MS = 5 * 60_000;

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface MfaStatus {
  totp: boolean;
  passkeys: PasskeyInfo[];
  recoveryLeft: number;
}

interface MfaRow {
  user_id: number;
  totp_secret: string | null;
  totp_pending: string | null;
  totp_step: number;
  recovery: string;
}
interface PasskeyRow {
  id: string;
  user_id: number;
  name: string;
  public_key: string;
  alg: number;
  sign_count: number;
  rp_id: string;
  created_at: string;
  last_used_at: string | null;
}

/** Two-step sign-in: authenticator app codes, recovery codes and passkeys. */
export class MfaService {
  /** Password checked, second step still to do: ticket -> who and until when. */
  private readonly tickets = new Map<string, { userId: number; until: number }>();
  private readonly challenges = new Map<string, { userId: number | null; until: number; kind: "create" | "get" }>();

  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
  ) {}

  private row(userId: number): MfaRow | undefined {
    return this.db.prepare("SELECT * FROM user_mfa WHERE user_id = ?").get(userId) as MfaRow | undefined;
  }

  private passkeyRows(userId: number): PasskeyRow[] {
    return this.db.prepare("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at").all(userId) as unknown as PasskeyRow[];
  }

  status(userId: number): MfaStatus {
    const r = this.row(userId);
    return {
      totp: !!r?.totp_secret,
      passkeys: this.passkeyRows(userId).map((p) => ({ id: p.id, name: p.name, createdAt: p.created_at, lastUsedAt: p.last_used_at })),
      recoveryLeft: r ? (JSON.parse(r.recovery) as string[]).length : 0,
    };
  }

  /** Whether signing in with a password needs a second step. */
  required(userId: number): { totp: boolean; passkey: boolean } | null {
    const s = this.status(userId);
    return s.totp || s.passkeys.length ? { totp: s.totp, passkey: s.passkeys.length > 0 } : null;
  }

  // ---- Authenticator app ----------------------------------------------------------

  /** Starts adding an authenticator app: a new secret to scan, confirmed by its first code. */
  beginTotp(userId: number, account: string): { secret: string; uri: string } {
    const secret = newTotpSecret();
    this.db
      .prepare("INSERT INTO user_mfa (user_id, totp_pending) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET totp_pending = excluded.totp_pending")
      .run(userId, this.vault.encrypt(secret));
    return { secret, uri: otpauthUri(secret, account) };
  }

  /** Turns the app on once it shows the right code. Answers fresh recovery codes. */
  confirmTotp(userId: number, code: string): string[] {
    const r = this.row(userId);
    if (!r?.totp_pending) throw new Error("Start setting up the authenticator app first");
    const secret = this.vault.decrypt(r.totp_pending);
    const step = verifyTotp(secret, code);
    if (step === null) throw new Error("That code isn't right; check the phone's clock and try the newest code");
    this.db.prepare("UPDATE user_mfa SET totp_secret = ?, totp_pending = NULL, totp_step = ? WHERE user_id = ?").run(r.totp_pending, step, userId);
    return JSON.parse(r.recovery).length ? [] : this.newRecoveryCodes(userId);
  }

  disableTotp(userId: number): void {
    this.db.prepare("UPDATE user_mfa SET totp_secret = NULL, totp_pending = NULL, totp_step = -1 WHERE user_id = ?").run(userId);
    this.dropRecoveryIfUnused(userId);
  }

  /** Ten one-time codes for when the phone is lost; only their hashes are kept. */
  newRecoveryCodes(userId: number): string[] {
    const codes = Array.from({ length: 10 }, () => {
      const s = randomBytes(5).toString("hex");
      return `${s.slice(0, 5)}-${s.slice(5)}`;
    });
    this.db
      .prepare("INSERT INTO user_mfa (user_id, recovery) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET recovery = excluded.recovery")
      .run(userId, JSON.stringify(codes.map((c) => sha256(c))));
    return codes;
  }

  private dropRecoveryIfUnused(userId: number): void {
    const s = this.status(userId);
    if (!s.totp && !s.passkeys.length) this.db.prepare("UPDATE user_mfa SET recovery = '[]' WHERE user_id = ?").run(userId);
  }

  /** An authenticator code or a recovery code (used up). */
  checkCode(userId: number, code: string): boolean {
    const r = this.row(userId);
    if (!r) return false;
    if (r.totp_secret) {
      const step = verifyTotp(this.vault.decrypt(r.totp_secret), code, Date.now(), r.totp_step);
      if (step !== null) {
        this.db.prepare("UPDATE user_mfa SET totp_step = ? WHERE user_id = ?").run(step, userId);
        return true;
      }
    }
    const hashes = JSON.parse(r.recovery) as string[];
    const h = sha256(code.trim().toLowerCase());
    const at = hashes.findIndex((x) => safeEqual(x, h));
    if (at < 0) return false;
    hashes.splice(at, 1);
    this.db.prepare("UPDATE user_mfa SET recovery = ? WHERE user_id = ?").run(JSON.stringify(hashes), userId);
    return true;
  }

  // ---- Tickets: between the password and the second step -----------------------------

  issueTicket(userId: number): string {
    const at = Date.now();
    for (const [k, v] of this.tickets) if (v.until < at) this.tickets.delete(k);
    const t = newSecret("mfa");
    this.tickets.set(t, { userId, until: at + TICKET_MS });
    return t;
  }

  /** Who the ticket is for, without using it up. */
  ticketUser(ticket: string): number | null {
    const t = this.tickets.get(ticket);
    return t && t.until > Date.now() ? t.userId : null;
  }

  endTicket(ticket: string): void {
    this.tickets.delete(ticket);
  }

  // ---- Passkeys --------------------------------------------------------------------

  private challenge(userId: number | null, kind: "create" | "get"): string {
    const at = Date.now();
    for (const [k, v] of this.challenges) if (v.until < at) this.challenges.delete(k);
    const c = newChallenge();
    this.challenges.set(c, { userId, until: at + CHALLENGE_MS, kind });
    return c;
  }

  /** Takes a challenge out of the client data, checking it was issued for this. */
  private takeChallenge(clientDataJSON: string, kind: "create" | "get"): { challenge: string; userId: number | null } {
    let challenge = "";
    try {
      challenge = String(JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")).challenge ?? "");
    } catch {
      /* checked below */
    }
    const c = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    if (!c || c.until < Date.now() || c.kind !== kind) throw new Error("The passkey request expired; try again");
    return { challenge, userId: c.userId };
  }

  /** Options for navigator.credentials.create(). */
  registrationOptions(user: { id: number; username: string; displayName: string }, rpId: string) {
    return {
      challenge: this.challenge(user.id, "create"),
      rp: { id: rpId, name: "LootDen" },
      user: { id: Buffer.from(String(user.id)).toString("base64url"), name: user.username, displayName: user.displayName },
      pubKeyCredParams: [-7, -8, -257].map((alg) => ({ type: "public-key", alg })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      excludeCredentials: this.passkeyRows(user.id).map((p) => ({ type: "public-key", id: p.id })),
      attestation: "none",
      timeout: CHALLENGE_MS,
    };
  }

  addPasskey(userId: number, r: RegistrationResponse, rpId: string, name: string): PasskeyInfo {
    const { challenge, userId: forUser } = this.takeChallenge(r?.response?.clientDataJSON ?? "", "create");
    if (forUser !== userId) throw new Error("The passkey request was for someone else");
    const key = verifyRegistration(r, { challenge, rpId });
    const created = now();
    this.db
      .prepare("INSERT INTO passkeys (id, user_id, name, public_key, alg, sign_count, rp_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(key.id, userId, name.trim().slice(0, 60) || "Passkey", key.publicKey, key.alg, key.signCount, rpId, created);
    return { id: key.id, name: name.trim().slice(0, 60) || "Passkey", createdAt: created, lastUsedAt: null };
  }

  removePasskey(userId: number, id: string): boolean {
    const gone = this.db.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
    if (gone) this.dropRecoveryIfUnused(userId);
    return gone;
  }

  /** Options for navigator.credentials.get(): any of the person's passkeys, or (no one yet) whichever the device offers. */
  assertionOptions(userId: number | null, rpId: string) {
    return {
      challenge: this.challenge(userId, "get"),
      rpId,
      allowCredentials: userId === null ? [] : this.passkeyRows(userId).filter((p) => p.rp_id === rpId).map((p) => ({ type: "public-key", id: p.id })),
      userVerification: userId === null ? "required" : "preferred",
      timeout: CHALLENGE_MS,
    };
  }

  /** Checks a passkey sign-in and answers whose it is. */
  usePasskey(r: AssertionResponse, rpId: string): number {
    const { challenge, userId } = this.takeChallenge(r?.response?.clientDataJSON ?? "", "get");
    const row = this.db.prepare("SELECT * FROM passkeys WHERE id = ?").get(String(r.id)) as PasskeyRow | undefined;
    if (!row || row.rp_id !== rpId) throw new Error("LootDen doesn't know that passkey");
    if (userId !== null && row.user_id !== userId) throw new Error("That passkey belongs to someone else");
    const want: Expected = { challenge, rpId };
    const count = verifyAssertion(r, want, { publicKey: row.public_key, alg: row.alg, signCount: row.sign_count });
    this.db.prepare("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?").run(count, now(), row.id);
    return row.user_id;
  }

  /** An admin resets a locked-out person's second step. */
  reset(userId: number): void {
    this.db.prepare("DELETE FROM user_mfa WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM passkeys WHERE user_id = ?").run(userId);
  }
}
