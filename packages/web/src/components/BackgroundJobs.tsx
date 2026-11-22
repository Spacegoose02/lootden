import { Link, useLocation } from "react-router-dom";
import { formatBytes } from "../api";
import { desktop, useActivity, type ActivityItem } from "../desktop";

/** One update or DLC being applied: what, to which game, the step it's on and a Cancel while it can stop. */
function JobLine({ job }: { job: ActivityItem }) {
  const pct = job.received !== null && job.total ? Math.round((job.received / Math.max(1, job.total)) * 100) : null;
  return (
    <>
      <span>
        <strong>{job.kind === "dlc" ? "Adding" : "Applying"} {job.title}</strong>
        {job.gameTitle && (
          <>
            {" "}
            to {job.gameId ? <Link to={`/games/${job.gameId}`}>{job.gameTitle}</Link> : job.gameTitle}
          </>
        )}
        <span className="muted small">
          {" · "}
          {pct !== null ? `Downloading ${pct}% (${formatBytes(job.received!)} of ${formatBytes(job.total!)})` : job.message}
        </span>
      </span>
      {job.cancellable && (
        <button className="ghost small" onClick={() => void desktop?.cancel(job.id)}>
          Cancel
        </button>
      )}
    </>
  );
}

/**
 * A slim bar across the app while an update or DLC is applied, so it stays in sight after you
 * leave its game's page (where the game page shows it instead).
 */
export function BackgroundJobsBanner() {
  const jobs = useActivity();
  const { pathname } = useLocation();
  const shown = jobs.filter((j) => !j.gameId || pathname !== `/games/${j.gameId}`);
  if (!shown.length) return null;
  return (
    <>
      {shown.map((j) => (
        <div key={j.id} className="app-update-banner" role="status">
          <JobLine job={j} />
        </div>
      ))}
    </>
  );
}

/** The same list for the Downloads on this PC panel. */
export function BackgroundJobsList() {
  const jobs = useActivity();
  if (!jobs.length) return null;
  return (
    <ol className="list download-queue">
      {jobs.map((j) => (
        <li key={j.id} className="inline wrap">
          <JobLine job={j} />
        </li>
      ))}
    </ol>
  );
}
