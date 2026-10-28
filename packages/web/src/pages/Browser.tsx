import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { bridgeError, desktop } from "../desktop";

/**
 * The desktop app's built-in web browser opens over LootDen in its own window. Picking Browser
 * in the menu opens it straight away; passing through with LB/RB only lands here.
 */
export function Browser() {
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const open = () => desktop?.openBrowser?.().catch((e) => setError(bridgeError(e)));

  useEffect(() => {
    if (!(location.state as { open?: boolean } | null)?.open) return;
    // Once only: coming back from the browser shouldn't open it again.
    navigate(location.pathname, { replace: true, state: null });
    void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  if (!desktop?.openBrowser) return <p className="muted center">The web browser is part of the LootDen desktop app. Update the app to use it.</p>;
  return (
    <div className="browser-page">
      <h1>Web browser</h1>
      <p className="muted">
        Browse YouTube, Discord, Twitch, store pages and cloud gaming without leaving LootDen, with a mouse, touch or a controller. It keeps its own sign-ins, apart
        from LootDen's.
      </p>
      <p>
        <button className="primary" autoFocus onClick={() => void open()}>
          Open the browser
        </button>
      </p>
      <ul className="muted small">
        <li>A selects, B goes back, Y jumps to the address bar, LB and RB switch tabs.</li>
        <li>On a page the left stick moves a pointer, A clicks and the right stick scrolls. View switches between the toolbar and the page.</li>
        <li>Menu hands the whole controller to the page for Xbox Cloud Gaming or GeForce NOW; View and Menu together take it back.</li>
        <li>B on the start page, or ✕ LootDen, closes it.</li>
      </ul>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
