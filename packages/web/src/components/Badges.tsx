import { platformFor, togetherLabel, type GameSummary } from "@lootden/shared";

export function Badges({ game, compact = false }: { game: GameSummary; compact?: boolean }) {
  return (
    <div className={`badges${compact ? " badges-compact" : ""}`}>
      {game.platform && game.platform !== "pc" && (
        <span className="badge badge-platform" style={{ borderColor: platformFor(game.platform).color }} title={platformFor(game.platform).name}>
          {platformFor(game.platform).short}
        </span>
      )}
      {game.controllerSupport === "full" && <span className="badge badge-pad" title="Full controller support">🎮 {compact ? "" : "Controller"}</span>}
      {game.controllerSupport === "partial" && <span className="badge badge-pad-partial" title="Partial controller support">🎮 {compact ? "½" : "Partial"}</span>}
      {game.kidSafe === true && <span className="badge badge-kid" title="Suitable for kids">{compact ? "★" : "Kid-safe"}</span>}
      {!!game.together?.length &&
        (compact ? (
          <span className="badge badge-together" title={game.together.map(togetherLabel).join(", ")}>
            👥
          </span>
        ) : (
          game.together.map((t) => (
            <span key={t} className="badge badge-together">
              👥 {togetherLabel(t)}
            </span>
          ))
        ))}
      {game.rating != null && !compact && <span className="badge">{game.rating}/100</span>}
      {game.packed && !compact && <span className="badge badge-muted" title="Unpacked automatically after download">Packed</span>}
      {game.needsSetup && <span className="badge badge-muted" title="Install once with the app, then it installs like any other game">{game.needsSetup === "disc" ? "Disc image" : "Installer"}</span>}
    </div>
  );
}
