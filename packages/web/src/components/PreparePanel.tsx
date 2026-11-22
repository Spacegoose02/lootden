import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GameDetail } from "@lootden/shared";
import { useAuth } from "../auth";
import { bridgeError, desktop } from "../desktop";
import { GameJobStatus, useGameJob } from "./BackgroundJobs";

/**
 * Disc images and installers: an admin installs the game once with the app, which zips the
 * installed folder and uploads it, so everyone else gets a normal download.
 */
export function PreparePanel({ game }: { game: GameDetail }) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<{ message: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState("");
  // The zip and upload run in the desktop app; coming back to this page picks them up again.
  const job = useGameJob(game.id);

  useEffect(() => {
    if (!desktop) return;
    void desktop.info().then((i) => setPlatform(i.platform));
    return desktop.onProgress((p) => {
      if (p.gameId !== game.id || p.type !== "prepare") return;
      setStatus({ message: p.message, error: p.error });
      if (p.done) setBusy(false);
      if (p.done && p.newId && p.newId !== game.id) navigate(`/games/${p.newId}`, { replace: true });
    });
  }, [game.id, navigate]);

  if (!game.needsSetup) return null;
  const what = game.needsSetup === "disc" ? "a disc image" : "an installer";
  const isAdmin = me?.role === "admin";

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setStatus(null);
    fn().then(
      (r) => r === null && setBusy(false), // the folder picker was closed
      (e) => {
      setStatus({ message: bridgeError(e), error: true });
      setBusy(false);
      },
    );
  };

  return (
    <section className="panel prepare">
      <h2>Needs setting up</h2>
      {!isAdmin ? (
        <p className="muted">This game is {what}. An admin can install it once and upload the installed copy so it installs like any other game. Until then, the app downloads the {game.needsSetup === "disc" ? "disc image" : "installer"} and offers Run installer instead of Play.</p>
      ) : !desktop ? (
        <p className="muted">
          This game is {what}. Open this page in the Windows app and choose <strong>Install here and upload</strong>: it runs the setup once, zips the installed game and puts it on the
          server in place of the {game.needsSetup === "disc" ? "disc image" : "installer"} (the original is kept in <code>.replaced</code> in the games folder).
        </p>
      ) : (
        <>
          <p className="muted">
            This game is {what}. Install it once on this PC and the app zips the installed folder and uploads it, so everyone else gets a normal download. The original is kept in{" "}
            <code>.replaced</code> in the games folder.
          </p>
          <div className="inline">
            {platform === "win32" && desktop.prepare && (
              <button className="primary" disabled={busy || !!job} onClick={() => run(() => desktop!.prepare!(game.id))}>
                Install here and upload
              </button>
            )}
            {desktop.uploadFolder && (
              <button disabled={busy || !!job} onClick={() => run(() => desktop!.uploadFolder!(game.id))}>
                Upload an installed folder
              </button>
            )}
          </div>
        </>
      )}
      {job ? <GameJobStatus job={job} last={null} notice /> : status && <p className={status.error ? "error" : "notice"}>{status.message}</p>}
    </section>
  );
}
