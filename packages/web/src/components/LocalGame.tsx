import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { platformFor, versionLabel, type GameSummary } from "@lootden/shared";
import { api, formatBytes } from "../api";
import { bridgeError, desktop, type LocalGameCopy } from "../desktop";
import { Cover } from "./Cover";
import { stub } from "./InstalledGames";

/**
 * A game's page from this PC's copy, for a game the server no longer has (or while it can't
 * be reached): the details it last had, and Play, Run installer, Open folder and Uninstall,
 * which all work without the server.
 */
export function LocalGame({ copy, removed }: { copy: LocalGameCopy; removed: boolean }) {
  const navigate = useNavigate();
  const l = copy.game;
  const d = copy.detail;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [message, setMessage] = useState<{ message: string; error?: boolean } | null>(null);
  /** The same game under a new id (an admin replaced the download), when the server has one. */
  const [moved, setMoved] = useState<GameSummary | null>(null);

  useEffect(() => {
    if (!removed) return;
    const platform = l.platform ?? "pc";
    const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
    api.games({ search: l.title }).then(
      (games) => setMoved(games.find((g) => g.id !== l.gameId && g.platform === platform && (same(g.title, l.title) || same(g.source, d?.source))) ?? null),
      () => {},
    );
  }, [l.gameId, l.title, l.platform, d?.source, removed]);

  useEffect(
    () =>
      desktop?.onProgress((p) => {
        if (p.gameId !== l.gameId) return;
        if (p.type === "playing") setPlaying(true);
        else if (p.type === "stopped" || p.type === "error") setPlaying(false);
        if (p.type === "prepare") setMessage({ message: p.message, error: p.error });
      }),
    [l.gameId],
  );

  if (!desktop) return null;
  const bridge = desktop;
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(bridgeError(e));
    } finally {
      setBusy(false);
    }
  };

  const game = d ?? stub(l);
  const cover = { id: l.gameId, title: game.title, coverUrl: copy.cover, backgroundUrl: null };
  const platform = l.platform ?? "pc";
  const needsSetup = !!l.needsSetup && !l.installedDir && platform === "pc";
  const facts = [game.releaseYear, game.genres.join(", "), game.sizeBytes ? formatBytes(game.sizeBytes) : "", l.version ? `${versionLabel(l.version)}` : ""].filter(Boolean).join(" · ");

  return (
    <article className="detail">
      {copy.cover && <div className="detail-bg" style={{ backgroundImage: `url(${copy.cover})` }} />}
      <div className="detail-head">
        <Cover game={cover} size="hero" />
        <div className="detail-info">
          <h1>{game.title}</h1>
          {facts && <p className="muted">{facts}</p>}
          <div className="notice">
            {removed ? (
              <>
                <strong>This game was removed from the LootDen server.</strong> Your copy on this PC still plays
                {d ? ", and its details here are the last ones the server had." : "."}
                {moved && (
                  <>
                    {" "}
                    It looks like it changed on the server: <Link to={`/games/${moved.id}`}>open the new version</Link>.
                  </>
                )}
              </>
            ) : (
              <>
                <strong>Can't reach the server.</strong> This is the copy on this PC, and it still plays.
              </>
            )}
          </div>
          {d?.metadata?.summary && <p className="summary">{d.metadata.summary}</p>}
          <div className="install panel">
            <div className="inline">
              {needsSetup ? (
                bridge.runSetup && (
                  <button className="primary" disabled={busy} onClick={() => run(() => bridge.runSetup!(l.gameId))}>
                    {busy ? "Installing…" : "Run installer"}
                  </button>
                )
              ) : (
                <button className="primary" disabled={playing} onClick={() => run(() => bridge.play(l.gameId))}>
                  {playing ? "Playing…" : platform !== "pc" ? `▶ Play ${platformFor(platform).short}` : "▶ Play"}
                </button>
              )}
              <button className="secondary" onClick={() => run(() => bridge.openFolder(l.gameId))}>
                Open folder
              </button>
              <button className="ghost" onClick={() => run(async () => (await bridge.uninstall(l.gameId)) && navigate("/library?tab=installed"))}>
                Uninstall
              </button>
            </div>
            {needsSetup && (
              <p className="muted small">
                This download is still {l.needsSetup === "disc" ? "a disc image" : "an installer"}. Run installer sets it up in <code>{l.dir}</code>, then Play starts the game.
              </p>
            )}
            {message && <p className={message.error ? "error small" : "notice small"}>{message.message}</p>}
            {error && <p className="error small">{error}</p>}
          </div>
        </div>
      </div>
    </article>
  );
}
