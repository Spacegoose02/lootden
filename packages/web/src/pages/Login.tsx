import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { AuthProviders } from "@lootden/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { BrandLogo } from "../components/BrandLogo";

export function Login() {
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [params] = useSearchParams();
  const [error, setError] = useState(params.get("error") ?? "");
  const [busy, setBusy] = useState(false);
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
      else await api.login(username, password);
      await refresh();
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
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
        <label>
          Username
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={setup ? 8 : undefined} />
        </label>
        <button className="primary" disabled={busy}>
          {setup ? "Create admin" : "Sign in"}
        </button>
        {!setup && providers?.oidc.enabled && (
          <a className="button secondary" href={`/api/auth/oidc/login?returnTo=${encodeURIComponent(params.get("returnTo") ?? "/")}`}>
            Sign in with {providers.oidc.name}
          </a>
        )}
      </form>
    </div>
  );
}
