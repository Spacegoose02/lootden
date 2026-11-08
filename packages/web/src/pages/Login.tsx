import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { AuthProviders } from "@lootden/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { BrandLogo } from "../components/BrandLogo";
import { getPasskey, passkeysWork } from "../passkeys";

export function Login() {
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [params] = useSearchParams();
  const [error, setError] = useState(params.get("error") ?? "");
  const [busy, setBusy] = useState(false);
  // Signing in with a code from a device that's signed in already (Profile, Link another device).
  const [withCode, setWithCode] = useState(false);
  const [code, setCode] = useState("");
  // Two-step sign-in: the password was right, now a code or a passkey.
  const [mfa, setMfa] = useState<{ ticket: string; totp: boolean; passkey: boolean } | null>(null);
  const [otp, setOtp] = useState("");
  const { refresh } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    api.providers().then(setProviders, (e: Error) => setError(e.message));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (providers?.setupRequired) await api.setup(username, password);
      else if (withCode) await api.redeemPairingCode(code);
      else if (mfa) await api.loginCode(mfa.ticket, otp);
      else {
        const r = await api.login(username, password);
        if (r.mfa) {
          setMfa(r.mfa);
          setOtp("");
          return;
        }
      }
      await refresh();
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const passkey = async () => {
    setBusy(true);
    setError("");
    try {
      await api.loginPasskey(await getPasskey(await api.passkeyOptions(mfa?.ticket)), mfa?.ticket);
      await refresh();
      navigate("/");
    } catch (err) {
      const e = err as Error;
      setError(e.name === "NotAllowedError" ? "The passkey sign-in was cancelled" : e.message);
    } finally {
      setBusy(false);
    }
  };

  const setup = providers?.setupRequired;
  return (
    <div className="login">
      <form className="panel login-panel" onSubmit={submit}>
        {__BRAND__.mascot ? <img className="login-mascot" src={__BRAND__.mascot} alt="" width={160} height={160} /> : <BrandLogo size={88} />}
        <h1>{setup ? "Create the admin account" : "LootDen"}</h1>
        {setup && <p className="muted">This is the first start. The account you create here manages the library and other profiles.</p>}
        {error && <p className="error">{error}</p>}
        {mfa ? (
          <>
            <p className="muted small">
              {mfa.totp ? "Enter the code from your authenticator app, or one of your recovery codes." : "Use your passkey, or enter one of your recovery codes."}
            </p>
            <label>
              Code
              <input autoFocus autoComplete="one-time-code" inputMode={mfa.totp ? "numeric" : "text"} spellCheck={false} value={otp} onChange={(e) => setOtp(e.target.value)} required={!mfa.passkey} />
            </label>
          </>
        ) : withCode ? (
          <>
            <p className="muted small">On a device where you're signed in, open Profile and choose Link another device.</p>
            <label>
              Code
              <input
                autoFocus
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="ABCD-2345"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                required
                minLength={8}
                maxLength={9}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              Username
              <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </label>
            <label>
              Password
              <input type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={setup ? 8 : undefined} />
            </label>
          </>
        )}
        <button className="primary" disabled={busy}>
          {setup ? "Create admin" : mfa ? "Continue" : "Sign in"}
        </button>
        {!setup && passkeysWork() && (!mfa || mfa.passkey) && !withCode && (
          <button type="button" className="secondary" disabled={busy} onClick={() => void passkey()}>
            {mfa ? "Use my passkey" : "Sign in with a passkey"}
          </button>
        )}
        {mfa && (
          <button type="button" className="ghost" onClick={() => (setMfa(null), setError(""))}>
            Back
          </button>
        )}
        {!setup && !mfa && providers?.pairing && (
          <button type="button" className="ghost" onClick={() => (setWithCode((v) => !v), setError(""))}>
            {withCode ? "Sign in with a password" : "Sign in with a code"}
          </button>
        )}
        {!setup && providers?.oidc.enabled && (
          <a className="button secondary" href={`/api/auth/oidc/login?returnTo=${encodeURIComponent(params.get("returnTo") ?? "/")}`}>
            Sign in with {providers.oidc.name}
          </a>
        )}
      </form>
    </div>
  );
}
