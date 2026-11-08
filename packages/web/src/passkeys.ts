/** Passkeys in the browser: the server's JSON options to WebAuthn's buffers, and the answer back to JSON. */

const fromB64 = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
};
const toB64 = (b: ArrayBuffer | null) => {
  if (!b) return null;
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Passkeys need a secure page (https, or localhost) and a browser that has them. */
export const passkeysWork = () => typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window;

type Json = Record<string, unknown>;

export async function createPasskey(options: Json): Promise<Json> {
  const o = options as { challenge: string; user: { id: string }; excludeCredentials?: Array<{ id: string; type: string }> };
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...(options as unknown as PublicKeyCredentialCreationOptions),
      challenge: fromB64(o.challenge),
      user: { ...(options.user as PublicKeyCredentialUserEntity), id: fromB64(o.user.id) },
      excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({ type: "public-key" as const, id: fromB64(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was made");
  const r = cred.response as AuthenticatorAttestationResponse;
  return { id: cred.id, response: { clientDataJSON: toB64(r.clientDataJSON), attestationObject: toB64(r.attestationObject) } };
}

export async function getPasskey(options: Json): Promise<Json> {
  const o = options as { challenge: string; allowCredentials?: Array<{ id: string }> };
  const cred = (await navigator.credentials.get({
    publicKey: {
      ...(options as unknown as PublicKeyCredentialRequestOptions),
      challenge: fromB64(o.challenge),
      allowCredentials: (o.allowCredentials ?? []).map((c) => ({ type: "public-key" as const, id: fromB64(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was picked");
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    response: { clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.authenticatorData), signature: toB64(r.signature), userHandle: toB64(r.userHandle) },
  };
}
