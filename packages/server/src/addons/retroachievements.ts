import type { LibraryAddon } from "./types.js";

export const RA_API = "https://retroachievements.org/API";

/**
 * RetroAchievements: achievements for console games played in RetroArch, DuckStation, PCSX2 and
 * other emulators. Connecting it lists no store games; it adds achievements to the emulated
 * games' pages and the profile.
 */
export const retroAchievements: LibraryAddon = {
  id: "retroachievements",
  name: "RetroAchievements",
  description: "Achievements for console games you play in emulators (sign in to RetroAchievements in RetroArch, DuckStation or PCSX2 too). Adds no games to the library, only their achievements.",
  homepage: "https://retroachievements.org/settings",
  fields: [
    { key: "username", label: "RetroAchievements user name", required: true, placeholder: "YourName" },
    {
      key: "apiKey",
      label: "Web API key",
      required: true,
      secret: true,
      link: { url: "https://retroachievements.org/settings", label: "Find it under Settings, Keys" },
      help: "Your personal Web API key from retroachievements.org, Settings, Keys",
    },
  ],
  async games({ config, fetch }) {
    // Only checks the account works: RetroAchievements games aren't games to start.
    const url = new URL(`${RA_API}/API_GetUserProfile.php`);
    url.searchParams.set("u", config.username ?? "");
    url.searchParams.set("y", config.apiKey ?? "");
    const res = await fetch(url);
    if (res.status === 401 || res.status === 403) throw new Error("RetroAchievements refused the key; copy it again from Settings, Keys");
    if (!res.ok) throw new Error(`RetroAchievements answered ${res.status}`);
    const body = (await res.json().catch(() => null)) as { User?: string } | null;
    if (!body?.User) throw new Error("RetroAchievements doesn't know that user name");
    return [];
  },
};
