package app.lootden.android

import android.os.Environment
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * The BIOS and firmware files an admin uploaded to the server, on this handheld. Android keeps
 * each emulator's own folders private, so they go to one BIOS folder beside the games
 * (<installDir>/bios) that DuckStation, ARMSX2, NetherSX2, ARMSX3 and the rest can be pointed at
 * once. RetroArch's files also go straight into its system folder when LootDen can reach it.
 */
class Bios(private val app: AppCore) {
    fun folder(): File = File(app.prefs.installDir, "bios")

    fun pull(): JSONObject {
        app.requireStorage()
        val files = app.server.array("/api/emulation/bios")
        val dir = folder()
        if (!dir.mkdirs() && !dir.isDirectory) throw IOException("Can't make the folder $dir. Check LootDen may manage files (Android settings, Apps, LootDen).")
        val added = JSONArray()
        val already = JSONArray()
        val skipped = JSONArray()
        val problems = JSONArray()
        val emulators = mutableSetOf<String>()
        val retroarch = retroarchSystemDirs()
        for (i in 0 until files.length()) {
            val f = files.getJSONObject(i)
            val name = File(f.getString("name")).name
            val size = f.optLong("size")
            val sha1 = f.optString("sha1")
            val emulator = f.optString("emulator")
            try {
                val dest = File(dir, name)
                val same = sameFile(dest, size, sha1)
                if (!same) download("/api/emulation/bios/${Server.enc(name)}", dest, size)
                // RetroArch looks in its system folder (Dreamcast files in system/dc).
                if (emulator == "retroarch") {
                    val sub = if (name.lowercase().startsWith("dc_")) "dc" else ""
                    for (sys in retroarch) runCatching {
                        val target = File(if (sub.isEmpty()) sys else File(sys, sub), name)
                        if (!sameFile(target, size, sha1)) {
                            target.parentFile?.mkdirs()
                            dest.copyTo(target, overwrite = true)
                        }
                    }
                }
                emulators += emulator
                (if (same) already else added).put(name)
            } catch (err: Exception) {
                skipped.put(name)
                problems.put(JSONObject().put("name", name).put("reason", err.message ?: err.toString()))
            }
        }
        return JSONObject()
            .put("added", added)
            .put("already", already)
            .put("skipped", skipped)
            .put("problems", problems)
            .put("folder", dir.path)
            .put("notes", JSONArray(notes(emulators, dir, retroarch)))
    }

    /** What to do in each emulator, once, so it finds the files. */
    private fun notes(emulators: Set<String>, dir: File, retroarch: List<File>): List<String> {
        val out = mutableListOf<String>()
        val shown = dir.path.removePrefix(Environment.getExternalStorageDirectory().path).trimStart('/').ifEmpty { dir.path }
        if ("duckstation" in emulators) out += "PS1: in DuckStation, Settings, BIOS, pick the $shown folder as the BIOS directory (RetroArch's PS1 core finds it in its system folder)."
        if ("pcsx2" in emulators) out += "PS2: in ARMSX2 or NetherSX2, Settings, BIOS, pick the $shown folder and choose the BIOS there."
        if ("rpcs3" in emulators) out += "PS3: in ARMSX3, install the firmware from its menu and pick PS3UPDAT.PUP in $shown. That's needed once."
        if ("retroarch" in emulators) {
            out += if (retroarch.isNotEmpty()) "RetroArch: copied into its system folder too." else "RetroArch: set its System/BIOS directory (Settings, Directory) to $shown."
        }
        return out
    }

    /** RetroArch's system folders that LootDen can write to: the one its settings name, and the usual ones. */
    private fun retroarchSystemDirs(): List<File> {
        val root = Environment.getExternalStorageDirectory()
        val pkg = EMULATORS.first { it.id == "retroarch" }.let { app.emulators.installedPackage(it) } ?: return emptyList()
        val candidates = mutableListOf<File>()
        // The folder in RetroArch's own settings, when its settings file is readable.
        val cfg = File(root, "Android/data/$pkg/files/retroarch.cfg")
        runCatching {
            cfg.readLines().firstOrNull { it.trimStart().startsWith("system_directory") }
                ?.substringAfter('=')?.trim()?.trim('"')
                ?.takeIf { it.isNotEmpty() && it != "default" }
                ?.let { candidates += File(it.replace("~", root.path)) }
        }
        candidates += File(root, "RetroArch/system")
        candidates += File(root, "Android/data/$pkg/files/system")
        return candidates.distinctBy { it.path }.filter { dir ->
            runCatching { (dir.isDirectory || (dir.parentFile?.isDirectory == true && dir.mkdirs())) && dir.canWrite() }.getOrDefault(false)
        }
    }

    private fun sameFile(f: File, size: Long, sha1: String): Boolean {
        if (!f.isFile || f.length() != size) return false
        if (sha1.isEmpty()) return true
        return runCatching { sha1Of(f).equals(sha1, ignoreCase = true) }.getOrDefault(false)
    }

    private fun download(path: String, dest: File, size: Long) {
        val part = File(dest.path + ".part")
        val c = app.server.open(path)
        if (c.responseCode !in 200..299) throw app.server.fail(c)
        c.inputStream.use { input -> part.outputStream().use { input.copyTo(it, 256 * 1024) } }
        c.disconnect()
        val got = part.length()
        if (size > 0 && got != size) {
            part.delete()
            throw IOException("The download stopped at ${Installer.formatBytes(got)} of ${Installer.formatBytes(size)}")
        }
        if (dest.exists()) dest.delete()
        if (!part.renameTo(dest)) throw IOException("Couldn't save $dest")
    }

    companion object {
        fun sha1Of(f: File): String {
            val md = MessageDigest.getInstance("SHA-1")
            f.inputStream().use { input ->
                val buf = ByteArray(256 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
