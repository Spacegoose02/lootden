import { createHash, createPublicKey, randomBytes, verify as verifySig, type KeyObject } from "node:crypto";

/**
 * Just enough WebAuthn for passkeys: "none" attestation on sign-up (the household trusts its own
 * devices; no vendor lists needed), and ES256, RS256 or EdDSA signatures on sign-in.
 */

// ---- CBOR (the subset authenticators send) -------------------------------------------

type Cbor = number | bigint | string | Buffer | boolean | null | undefined | Cbor[] | Map<Cbor, Cbor>;

export function decodeCbor(buf: Buffer): { value: Cbor; length: number } {
  let p = 0;
  const arg = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return buf.readUInt8(p++);
    if (info === 25) return (p += 2), buf.readUInt16BE(p - 2);
    if (info === 26) return (p += 4), buf.readUInt32BE(p - 4);
    if (info === 27) return (p += 8), Number(buf.readBigUInt64BE(p - 8));
    throw new Error("Unsupported CBOR length");
  };
  const item = (): Cbor => {
    const first = buf.readUInt8(p++);
    const major = first >> 5;
    const info = first & 31;
    switch (major) {
      case 0:
        return arg(info);
      case 1:
        return -1 - arg(info);
      case 2: {
        const n = arg(info);
        p += n;
        return buf.subarray(p - n, p);
      }
      case 3: {
        const n = arg(info);
        p += n;
        return buf.subarray(p - n, p).toString("utf8");
      }
      case 4: {
        const n = arg(info);
        const out: Cbor[] = [];
        for (let i = 0; i < n; i++) out.push(item());
        return out;
      }
      case 5: {
        const n = arg(info);
        const out = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) {
          const k = item();
          out.set(k, item());
        }
        return out;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new Error("Unsupported CBOR value");
      default:
        throw new Error("Unsupported CBOR type");
    }
  };
  const value = item();
  return { value, length: p };
}

// ---- Authenticator data ------------------------------------------------------------

export interface AuthData {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  credentialId?: Buffer;
  publicKey?: Map<Cbor, Cbor>;
}

export function parseAuthData(data: Buffer): AuthData {
  if (data.length < 37) throw new Error("Authenticator data is too short");
  const flags = data[32]!;
  const out: AuthData = { rpIdHash: data.subarray(0, 32), userPresent: !!(flags & 1), userVerified: !!(flags & 4), signCount: data.readUInt32BE(33) };
  if (flags & 0x40) {
    const len = data.readUInt16BE(53);
    out.credentialId = data.subarray(55, 55 + len);
    const key = decodeCbor(data.subarray(55 + len)).value;
    if (!(key instanceof Map)) throw new Error("Bad credential key");
    out.publicKey = key;
  }
  return out;
}

/** A COSE key as an SPKI public key, and its algorithm (-7 ES256, -257 RS256, -8 EdDSA). */
export function coseToKey(cose: Map<Cbor, Cbor>): { key: KeyObject; alg: number } {
  const kty = cose.get(1);
  const alg = Number(cose.get(3));
  const b64 = (v: Cbor) => (v as Buffer).toString("base64url");
  if (kty === 2 && cose.get(-1) === 1) return { alg, key: createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: b64(cose.get(-2)), y: b64(cose.get(-3)) } }) };
  if (kty === 3) return { alg, key: createPublicKey({ format: "jwk", key: { kty: "RSA", n: b64(cose.get(-1)), e: b64(cose.get(-2)) } }) };
  if (kty === 1 && cose.get(-1) === 6) return { alg, key: createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: b64(cose.get(-2)) } }) };
  throw new Error("This passkey uses a key type LootDen doesn't support");
}

// ---- Ceremonies ------------------------------------------------------------------------

export const newChallenge = () => randomBytes(32).toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

export interface Expected {
  challenge: string;
  /** The site's host name. The page's origin must be on it (any port, so a reverse proxy in front doesn't matter). */
  rpId: string;
}

function checkClientData(json: string, type: string, want: Expected): void {
  let c: { type?: string; challenge?: string; origin?: string };
  try {
    c = JSON.parse(Buffer.from(json, "base64url").toString("utf8"));
  } catch {
    throw new Error("Bad client data");
  }
  if (c.type !== type) throw new Error("Wrong kind of passkey request");
  if (c.challenge !== want.challenge) throw new Error("The passkey request expired; try again");
  let host = "";
  try {
    host = new URL(String(c.origin)).hostname;
  } catch {
    /* checked below */
  }
  if (host !== want.rpId) throw new Error("The passkey was made for a different address");
}

export interface RegistrationResponse {
  id: string;
  response: { clientDataJSON: string; attestationObject: string };
}

/** Checks a new passkey and answers what to store. */
export function verifyRegistration(r: RegistrationResponse, want: Expected): { id: string; publicKey: string; alg: number; signCount: number } {
  checkClientData(r.response.clientDataJSON, "webauthn.create", want);
  const att = decodeCbor(Buffer.from(r.response.attestationObject, "base64url")).value;
  if (!(att instanceof Map)) throw new Error("Bad attestation");
  const auth = parseAuthData(att.get("authData") as Buffer);
  if (!auth.rpIdHash.equals(sha256(want.rpId))) throw new Error("The passkey was made for a different site");
  if (!auth.userPresent) throw new Error("The passkey wasn't confirmed");
  if (!auth.credentialId || !auth.publicKey) throw new Error("The passkey sent no key");
  const { key, alg } = coseToKey(auth.publicKey);
  if (auth.credentialId.toString("base64url") !== r.id) throw new Error("Passkey id mismatch");
  return { id: r.id, publicKey: (key.export({ format: "der", type: "spki" }) as Buffer).toString("base64url"), alg, signCount: auth.signCount };
}

export interface AssertionResponse {
  id: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}

/** Checks a sign-in with a stored passkey; answers the new signature counter. */
export function verifyAssertion(r: AssertionResponse, want: Expected, stored: { publicKey: string; alg: number; signCount: number }): number {
  checkClientData(r.response.clientDataJSON, "webauthn.get", want);
  const authData = Buffer.from(r.response.authenticatorData, "base64url");
  const auth = parseAuthData(authData);
  if (!auth.rpIdHash.equals(sha256(want.rpId))) throw new Error("The passkey was made for a different site");
  if (!auth.userPresent) throw new Error("The passkey wasn't confirmed");
  const signed = Buffer.concat([authData, sha256(Buffer.from(r.response.clientDataJSON, "base64url"))]);
  const key = createPublicKey({ key: Buffer.from(stored.publicKey, "base64url"), format: "der", type: "spki" });
  const sig = Buffer.from(r.response.signature, "base64url");
  const ok = stored.alg === -8 ? verifySig(null, signed, key, sig) : verifySig("sha256", signed, key, sig);
  if (!ok) throw new Error("The passkey's signature didn't check out");
  // Counters only ever go up; synced passkeys always send 0.
  if (auth.signCount !== 0 && auth.signCount <= stored.signCount) throw new Error("This passkey looks cloned; remove it and add it again");
  return auth.signCount;
}
