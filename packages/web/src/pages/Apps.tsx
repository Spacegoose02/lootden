import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatBytes, type ClientFile } from "../api";
import { useAuth } from "../auth";
import { desktop } from "../desktop";

const GROUPS: Array<{ platform: ClientFile["platform"]; title: string; help: string }> = [
  { platform: "windows", title: "Windows", help: "Run the installer, or the portable .exe from any folder. Windows may warn that the app is unsigned: choose More info, then Run anyway." },
  { platform: "linux", title: "Linux and Steam Deck", help: "AppImage: make it executable (chmod +x) and run it. On Debian or Ubuntu you can install the .deb instead." },
  {
    platform: "android",
    title: "Android handhelds and phones",
    help: "For the Retroid Pocket, AYN Odin, Anbernic and other Android handhelds. Open the .apk (allow installs from your browser or file manager when asked), then enter this server's address. Console games install to a ROMs folder and play in RetroArch or a standalone emulator; PC games stream from a PC with Moonlight.",
  },
  { platform: "playnite", title: "Playnite", help: "Drag the .pext onto Playnite, or unzip into Playnite's Extensions folder, then add your server and a personal token in the add-on settings." },
  { platform: "other", title: "Other files", help: "" },
];

/** Downloads of the desktop app, command-line client and Playnite plugin, hosted by this server. */
export function Apps() {
  const { me } = useAuth();
  const [files, setFiles] = useState<ClientFile[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.clients().then(setFiles, (e: Error) => setError(e.message));
  }, []);

  return (
    <div className="apps">
      <h1>Get the app</h1>
      <p className="muted">
        The LootDen app downloads games to the drive you choose, unpacks zip, 7z and rar files and removes the archives afterwards. When it asks
        for a server, enter <code>{location.origin}</code>.
      </p>
      {desktop && <p className="notice">You're already using the app.</p>}
      {error && <p className="error">{error}</p>}
      {files && files.length === 0 && (
        <p className="panel muted">
          No downloads are hosted yet.{" "}
          {me?.role === "admin" ? (
            <>
              Add them in <Link to="/settings/content">Settings, News &amp; apps</Link>.
            </>
          ) : (
            "Ask the server admin to add them."
          )}
        </p>
      )}
      {GROUPS.map((g) => {
        const list = files?.filter((f) => f.platform === g.platform) ?? [];
        if (!list.length) return null;
        return (
          <section key={g.platform} className="panel">
            <h2>{g.title}</h2>
            {g.help && <p className="muted small">{g.help}</p>}
            <ul className="list">
              {list.map((f) => (
                <li key={f.name}>
                  <span>
                    <strong>{f.kind}</strong>
                    <br />
                    <small className="muted">
                      {f.name} · {formatBytes(f.size)} · {new Date(f.modifiedAt).toLocaleDateString()}
                    </small>
                  </span>
                  <a className="button primary" href={`/api/clients/${encodeURIComponent(f.name)}`} download>
                    Download
                  </a>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <p className="muted small">
        Note: 7-Zip comes with the app for zip and 7z. For RAR archives, install 7-Zip from 7-zip.org (Windows) or <code>7zip</code>/<code>p7zip-full</code> (Linux).
      </p>
    </div>
  );
}
