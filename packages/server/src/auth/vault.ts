import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PREFIX = "enc:v1:";

/**
 * Encrypts secrets kept in the database (store accounts' API keys and sign-in tokens) with
 * AES-256-GCM, so a copied database file doesn't hand them out. The key comes from
 * GM_SECRET_KEY, or else a random one kept in <data>/secret.key (created on first start,
 * readable by the server's user only). Losing the key means people connect their stores again.
 */
export class Vault {
  private constructor(private readonly key: Buffer) {}

  /** Any passphrase; it's hashed down to the 32-byte key. */
  static fromSecret(secret: string): Vault {
    return new Vault(createHash("sha256").update(secret).digest());
  }

  static open(dataDir: string, secret?: string): Vault {
    if (secret) return Vault.fromSecret(secret);
    const file = path.join(dataDir, "secret.key");
    if (existsSync(file)) return Vault.fromSecret(readFileSync(file, "utf8").trim());
    mkdirSync(dataDir, { recursive: true });
    const fresh = randomBytes(32).toString("base64");
    writeFileSync(file, fresh, { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
    return Vault.fromSecret(fresh);
  }

  static isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `${PREFIX}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
  }

  /** Values saved before encryption came in are returned as they are. */
  decrypt(value: string): string {
    if (!Vault.isEncrypted(value)) return value;
    const [iv, tag, data] = value.slice(PREFIX.length).split(".");
    if (!iv || !tag || data === undefined) throw new Error("Damaged secret");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  }
}
