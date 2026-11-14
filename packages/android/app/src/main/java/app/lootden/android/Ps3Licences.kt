package app.lootden.android

import java.io.File

/**
 * PS3 licence files (.rap) an admin uploaded for a game. They're kept in the game's folder under
 * licences/, and handed to ARMSX3's installer, which copies them into its own exdata folder (the
 * emulator's storage is private to it, so LootDen can't copy them there itself).
 */
object Ps3Licences {
    const val FOLDER = "licences"

    /** A RAP is one 16-byte key. */
    private const val RAP_BYTES = 16L

    /** <CONTENT_ID>.rap, as RPCS3 and ARMSX3 look for it. */
    private val CONTENT_ID = Regex("[A-Z]{2}[0-9]{4}-[A-Z]{4}[0-9]{5}_[0-9]{2}-[A-Z0-9_]{16}")

    /** Fetches the game's licences from the server into <gameDir>/licences; returns the names that changed. */
    fun pull(server: Server, gameId: String, gameDir: File): List<String> {
        val list = server.array("/api/games/${Server.enc(gameId)}/licences")
        if (list.length() == 0) return emptyList()
        val dir = File(gameDir, FOLDER)
        dir.mkdirs()
        val changed = mutableListOf<String>()
        for (i in 0 until list.length()) {
            val name = list.getJSONObject(i).getString("name")
            if (!name.endsWith(".rap") || CONTENT_ID.find(name.uppercase()) == null) continue
            val data = server.bytes("/api/games/${Server.enc(gameId)}/licences/${Server.enc(name)}")
            val dest = Installer.inside(dir, name)
            if (dest.isFile && dest.readBytes().contentEquals(data)) continue
            dest.writeBytes(data)
            changed += name
        }
        return changed
    }

    /** Every licence in an installed game: the server's and any that came with the game's own files. */
    fun inFolder(gameDir: File): List<File> =
        gameDir.walkTopDown()
            .filter { it.isFile && it.name.lowercase().endsWith(".rap") && it.length() == RAP_BYTES && CONTENT_ID.containsMatchIn(it.name.uppercase()) }
            .sortedBy { it.path.lowercase() }
            .toList()

    /** Changes when the file does, so a replaced licence goes to ARMSX3 again. */
    fun key(file: File): String = "${file.path}|${file.length()}|${file.lastModified()}"
}
