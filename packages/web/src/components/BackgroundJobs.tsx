import { Link, useLocation } from "react-router-dom";
import { formatBytes } from "../api";
import { desktop, useActivity, type ActivityItem } from "../desktop";

/** What a job is, in a few words: "Applying Patch 1.1 to", "Uploading". */
function headline(job: ActivityItem): string {
  switch (job.kind) {
    case "dlc":
      return `Adding ${job.title}`;
    case "upload":
      return "Uploading the installed game";
    case "verify":
      return "Checking files";
    case "repair":
      return "Repairing";
    case "uninstall":
      return "Deleting";
    default:
      return `Applying ${job.title}`;
  }
}

/** Percent done when the job can be counted, else null. */
export function jobPercent(job: Pick<ActivityItem, "received" | "total">): number | null {
  return job.received !== null && job.total ? Math.min(100, Math.round((job.received / Math.max(1, job.total)) * 100)) : null;
}

/**
 * One background job: what, which game, its step (with percent, amounts, speed and time
 * left when it can be counted), a slim bar, and a Cancel while it can stop.
 */
function JobLine({ job }: { job: ActivityItem }) {
  const pct = jobPercent(job);
  const ofGame = job.kind === "update" || job.kind === "dlc" ? "to" : "·";
  // Older desktop apps send a bare "Downloading" for updates; newer ones send the whole line.
  const status = pct !== null && job.message === "Downloading" ? `Downloading ${pct}% (${formatBytes(job.received!)} of ${formatBytes(job.total!)})` : job.message;
  return (
    <>
      <span>
        <strong>{headline(job)}</strong>
        {job.gameTitle && (
          <>
            {" "}
            {ofGame} {job.gameId ? <Link to={`/games/${job.gameId}`}>{job.gameTitle}</Link> : job.gameTitle}
          </>
        )}
        <span className="muted small">
          {" · "}
          {status}
        </span>
        {pct !== null && (
          <span className="job-meter" aria-hidden>
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
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
 * A slim bar across the app while a background job runs (an update, an upload, a delete), so
 * it stays in sight after you leave its game's page (where the game page shows it instead).
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

/** The game's own long job (uploading, checking, repairing, deleting), if one is running now. */
export function useGameJob(gameId: string): ActivityItem | null {
  const jobs = useActivity();
  return jobs.find((j) => j.gameId === gameId && j.kind !== "update" && j.kind !== "dlc") ?? null;
}

/**
 * The game page's status for a long job. The job lives in the desktop app, so leaving the page
 * and coming back picks it up again with its bar; the last message (an error, "Uploaded") shows
 * once it ends.
 */
export function GameJobStatus({ job, last, notice }: { job: ActivityItem | null; last: { message: string; error?: boolean; done?: boolean } | null; notice?: boolean }) {
  if (job) {
    const pct = jobPercent(job);
    return (
      <div className="progress" role="status">
        {pct !== null ? (
          <div className="meter meter-long">
            <div style={{ width: `${pct}%` }} />
            <span>{job.message}</span>
          </div>
        ) : (
          <p className={notice ? "notice small" : "muted small"}>{job.message}</p>
        )}
        {job.cancellable && (
          <button className="ghost small" onClick={() => void desktop?.cancel(job.id)}>
            Cancel
          </button>
        )}
      </div>
    );
  }
  if (!last) return null;
  return <p className={last.error ? "error small" : notice ? "notice small" : "muted small"}>{last.message}</p>;
}
