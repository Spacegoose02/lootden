import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { api, type MfaStatus } from "../api";
import { createPasskey, passkeysWork } from "../passkeys";

/** An otpauth:// link as a QR code for an authenticator app to scan. */
function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  }, [text]);
  return <div className="totp-qr" role="img" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="notice">
      <p>
        <strong>Recovery codes.</strong> Each one signs you in once if your phone or passkey is lost. Keep them somewhere safe; they aren't shown again.
      </p>
      <pre className="code-block">{codes.join("\n")}</pre>
      <div className="inline">
        <button className="secondary small" onClick={() => void navigator.clipboard?.writeText(codes.join("\n"))}>
          Copy
        </button>
        <button className="ghost small" onClick={onDone}>
          I've saved them
        </button>
      </div>
    </div>
  );
}

/** Profile: authenticator app, passkeys and recovery codes. */
export function SignInSecurity() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api.security().then(setStatus, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      const err = e as Error;
      setError(err.name === "NotAllowedError" ? "Cancelled" : err.message);
    } finally {
      setBusy(false);
    }
  };
  if (!status) return error ? <p className="error">{error}</p> : null;
  const on = status.totp || status.passkeys.length > 0;
  return (
    <section className="panel">
      <h2>Two-step sign-in</h2>
      <p className="muted small">
        {on
          ? `On. Signing in with your password also takes ${status.totp ? "a code from your authenticator app" : "your passkey"}. ${status.recoveryLeft} recovery codes left.`
          : "Off. Add an authenticator app or a passkey so a password alone isn't enough to get in."}
      </p>
      {error && <p className="error">{error}</p>}
      {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

      <h3>Authenticator app</h3>
      {status.totp ? (
        <div className="inline wrap">
          <input placeholder="Current code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Current code" />
          <button className="secondary" disabled={busy || !code} onClick={() => void act(async () => (setCodes((await api.newRecoveryCodes(code)).recoveryCodes), setCode("")))}>
            New recovery codes
          </button>
          <button className="danger" disabled={busy || !code} onClick={() => void act(async () => (await api.disableTotp(code), setCode("")))}>
            Turn off
          </button>
        </div>
      ) : setup ? (
        <div className="totp-setup">
          <Qr text={setup.uri} />
          <div>
            <p className="small">
              Scan this with Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden or any authenticator app, or{" "}
              <a href={setup.uri}>open it on this phone</a>. The key is <code>{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>.
            </p>
            <div className="inline">
              <input autoFocus placeholder="123456" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code from the app" />
              <button
                className="primary"
                disabled={busy || code.length < 6}
                onClick={() =>
                  void act(async () => {
                    const r = await api.confirmTotp(code);
                    if (r.recoveryCodes.length) setCodes(r.recoveryCodes);
                    setSetup(null);
                    setCode("");
                  })
                }
              >
                Turn on
              </button>
              <button className="ghost" onClick={() => setSetup(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button className="secondary" disabled={busy} onClick={() => void act(async () => setSetup(await api.beginTotp()))}>
          Set up an authenticator app
        </button>
      )}

      <h3>Passkeys</h3>
      <p className="muted small">Sign in with your fingerprint, face or PIN on this device, a phone, or a security key, without typing a password.</p>
      {status.passkeys.length > 0 && (
        <ul className="list">
          {status.passkeys.map((p) => (
            <li key={p.id}>
              <span>
                {p.name} <small className="muted">added {new Date(p.createdAt).toLocaleDateString()}{p.lastUsedAt ? `, last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : ""}</small>
              </span>
              <button className="ghost" disabled={busy} onClick={() => confirm(`Remove the passkey "${p.name}"?`) && void act(() => api.removePasskey(p.id))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {passkeysWork() ? (
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const credential = await createPasskey(await api.passkeyRegistration());
              const name = prompt("Name this passkey (like Mum's phone)", navigator.platform || "Passkey") ?? "Passkey";
              const r = await api.addPasskey(credential, name);
              if (r.recoveryCodes.length) setCodes(r.recoveryCodes);
            })
          }
        >
          Add a passkey
        </button>
      ) : (
        <p className="muted small">Passkeys need LootDen on https (or localhost) in a browser that has them.</p>
      )}
    </section>
  );
}
