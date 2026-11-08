import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { now, type Db } from "../db/database.js";
import type { FetchLike } from "../metadata/http.js";

/** A browser's push subscription, as PushSubscription.toJSON() gives it. */
export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessage {
  title: string;
  body?: string | null;
  /** A page in LootDen to open when the notification is tapped. */
  link?: string | null;
  /** Notifications with the same tag replace each other. */
  tag?: string;
}

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
const b64 = (b: Buffer) => b.toString("base64url");

/** The server's VAPID key pair (RFC 8292), made on first use and kept in <data>/vapid.json. */
export class VapidKeys {
  readonly publicKey: string;
  private readonly privateKey: string;

  constructor(dataDir: string) {
    const file = path.join(dataDir, "vapid.json");
    if (existsSync(file)) {
      const k = JSON.parse(readFileSync(file, "utf8")) as { publicKey: string; privateKey: string };
      this.publicKey = k.publicKey;
      this.privateKey = k.privateKey;
    } else {
      mkdirSync(dataDir, { recursive: true });
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      this.publicKey = b64(ecdh.getPublicKey());
      this.privateKey = b64(ecdh.getPrivateKey());
      writeFileSync(file, JSON.stringify({ publicKey: this.publicKey, privateKey: this.privateKey }), { mode: 0o600 });
    }
  }

  /** The Authorization header for a push service: a signed JWT for its origin. */
  authorization(endpoint: string, subject: string): string {
    const pub = Buffer.from(this.publicKey, "base64url");
    const key = createPrivateKey({
      format: "jwk",
      key: { kty: "EC", crv: "P-256", d: this.privateKey, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) },
    });
    const header = b64(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = b64(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
    const sig = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
    return `vapid t=${header}.${claims}.${b64(sig)}, k=${this.publicKey}`;
  }
}

/** RFC 8291 message encryption (aes128gcm), so only the subscribed browser can read it. */
export function encryptPush(sub: PushSub, plaintext: Buffer, salt = randomBytes(16)): Buffer {
  const server = createECDH("prime256v1");
  server.generateKeys();
  const uaPublic = Buffer.from(sub.keys.p256dh, "base64url");
  const authSecret = Buffer.from(sub.keys.auth, "base64url");
  const asPublic = server.getPublicKey();
  const shared = server.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

interface SubRow {
  endpoint: string;
  user_id: number;
  p256dh: string;
  auth: string;
}

/**
 * Notifications on phones and desktops through the browser's own push service, when LootDen is
 * installed as an app (or the tab is closed): admins get the alerts the bell shows; anyone gets
 * news about their own requests and time asks.
 */
export class PushService {
  readonly vapid: VapidKeys;

  constructor(
    private readonly db: Db,
    dataDir: string,
    private readonly publicUrl: () => string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly log: { warn: (o: object, m: string) => void } = { warn: () => {} },
  ) {
    this.vapid = new VapidKeys(dataDir);
  }

  subscribe(userId: number, sub: PushSub, userAgent?: string): void {
    if (!/^https:\/\//.test(sub?.endpoint ?? "") || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("That isn't a push subscription");
    if (Buffer.from(sub.keys.p256dh, "base64url").length !== 65) throw new Error("That isn't a push subscription");
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
      )
      .run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 200) ?? null, now());
  }

  unsubscribe(userId: number, endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(endpoint, userId);
  }

  count(userId: number): number {
    return (this.db.prepare("SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ?").get(userId) as { n: number }).n;
  }

  /** Sends to every device a person turned notifications on for. Never throws. */
  async toUser(userId: number, msg: PushMessage): Promise<number> {
    const rows = this.db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(userId) as unknown as SubRow[];
    const sent = await Promise.all(rows.map((r) => this.send(r, msg)));
    return sent.filter(Boolean).length;
  }

  /** Sends to every admin's devices. */
  async toAdmins(msg: PushMessage): Promise<void> {
    const rows = this.db.prepare("SELECT s.* FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.role = 'admin'").all() as unknown as SubRow[];
    await Promise.all(rows.map((r) => this.send(r, msg)));
  }

  private async send(r: SubRow, msg: PushMessage): Promise<boolean> {
    try {
      const body = encryptPush({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, Buffer.from(JSON.stringify(msg)));
      const res = await this.fetchImpl(r.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "aes128gcm",
          TTL: "86400",
          Urgency: "normal",
          Authorization: this.vapid.authorization(r.endpoint, this.publicUrl() || "mailto:admin@lootden.local"),
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(15_000),
      });
      // Gone: the browser unsubscribed or the app was removed.
      if (res.status === 404 || res.status === 410) this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(r.endpoint);
      else if (!res.ok) this.log.warn({ status: res.status }, "Push notification refused");
      return res.ok;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "Push notification failed");
      return false;
    }
  }
}
