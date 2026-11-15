import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { SsoLinkStatus } from "@lootden/shared";
import { api } from "../api";

/** Profile: link this account to a TinyAuth sign-in, so TinyAuth opens it instead of making a new one. */
export function SsoLink({ hasPassword }: { hasPassword: boolean }) {
  const [status, setStatus] = useState<SsoLinkStatus | null>(null);
  const [params, setParams] = useSearchParams();
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.sso().then(setStatus, () => {});
    // Back from the provider after "Link with ...".
    const linked = params.get("linked");
    const error = params.get("linkError");
    if (linked || error) {
      setMsg(error ? error : "Linked. Signing in with TinyAuth now opens this account.");
      params.delete("linked");
      params.delete("linkError");
      setParams(params, { replace: true });
    }
  }, []);

  if (!status || (!status.oidcEnabled && !status.headerEnabled)) return null;
  const linked = !!status.username || status.oidc;
  const act = async (fn: () => Promise<SsoLinkStatus>, done: string) => {
    try {
      setStatus(await fn());
      setMsg(done);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <section className="panel">
      <h2>TinyAuth sign-in</h2>
      <p className="muted small">
        {linked ? (
          <>
            Linked{status.username && (
              <>
                {" "}to <strong>{status.username}</strong>
              </>
            )}
            {status.oidc && ` through ${status.oidcName}`}. Signing in with TinyAuth opens this account.
          </>
        ) : (
          "Not linked. Link it so signing in with TinyAuth opens this account instead of making a new one."
        )}
      </p>
      {msg && <p className="notice small">{msg}</p>}
      <div className="inline wrap">
        {status.headerEnabled && status.seen && status.seen.toLowerCase() !== (status.username ?? "").toLowerCase() && (
          <button className="primary" disabled={status.seenTaken} title={status.seenTaken ? "Another account is linked to it; an admin can move it" : undefined} onClick={() => act(api.linkSsoHeader, `Linked to ${status.seen}`)}>
            Link TinyAuth account {status.seen}
          </button>
        )}
        {status.oidcEnabled && (
          <a className="button secondary" href={`/api/auth/oidc/link?returnTo=${encodeURIComponent("/profile")}`}>
            {status.oidc ? `Link a different ${status.oidcName} account` : `Link with ${status.oidcName}`}
          </a>
        )}
        {linked && (
          <button
            className="ghost"
            disabled={!hasPassword}
            title={hasPassword ? undefined : "Set a password first so you can still sign in"}
            onClick={() => confirm("Unlink TinyAuth from this account?") && act(api.unlinkSso, "Unlinked")}
          >
            Unlink
          </button>
        )}
      </div>
      {status.headerEnabled && !status.seen && !status.oidcEnabled && !linked && (
        <p className="muted small">Open LootDen through your TinyAuth address and sign in there, then come back here to link it.</p>
      )}
    </section>
  );
}
