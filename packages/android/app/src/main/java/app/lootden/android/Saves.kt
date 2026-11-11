package app.lootden.android

import android.os.Environment
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * RetroArch battery saves follow the player between this handheld, the desktop app and the
 * browser player: the backup holds saves/<rom name>.srm, the layout the desktop app and the web
 * player use (sharedSavePath in packages/shared). Standalone emulators keep their saves in their
 * own app folders, which Android doesn't let other apps read, so those stay on the device.
 */
class Saves(private val app: AppCore) {
    private fun base(rom: File) = rom.name.substringBeforeLast('.')

    /** Where RetroArch may keep the game's save: beside the game (its default) or in its saves folder, sorted or not. */
    fun candidates(rom: File): List<File> {
        val name = "${base(rom)}.srm"
        val out = mutableListOf(File(rom.parentFile, name))
        val roots = listOf(
            File(Environment.getExternalStorageDirectory(), "RetroArch/saves"),
            File(Environment.getExternalStorageDirectory(), "Android/data/com.retroarch/files/saves"),
            File(Environment.getExternalStorageDirectory(), "Android/data/com.retroarch.aarch64/files/saves"),
        )
        for (r in roots) {
            out += File(r, name)
            r.listFiles()?.filter { it.isDirectory }?.forEach { out += File(it, name) }
        }
        return out
    }

    fun snapshot(rom: File): Map<String, Long> = candidates(rom).filter { it.isFile }.associate { it.path to it.lastModified() }

    /** Before playing: the newest backup from another device, unless this device's save is newer. */
    fun restore(gameId: String, rom: File) {
        val list = app.server.array("/api/games/${Server.enc(gameId)}/saves")
        val latest = (0 until list.length()).map { list.getJSONObject(it) }.firstOrNull { it.isNull("runner") || it.optString("runner").isEmpty() } ?: return
        val id = latest.getLong("id")
        if (app.prefs.restoredSave(gameId) == id || latest.optString("device") == app.prefs.deviceName) return
        val zip = app.server.bytes("/api/games/${Server.enc(gameId)}/saves/$id")
        val wanted = "saves/${base(rom)}.srm"
        val data = ZipInputStream(zip.inputStream()).use { zin ->
            generateSequence { zin.nextEntry }.firstOrNull { it.name.replace('\\', '/') == wanted }?.let { zin.readBytes() }
        } ?: return
        val made = Iso.parse(latest.optString("createdAt"))
        val existing = candidates(rom).filter { it.isFile }
        val targets = existing.ifEmpty { listOf(File(rom.parentFile, "${base(rom)}.srm")) }
        for (t in targets) {
            if (t.isFile && t.lastModified() >= made) continue
            t.parentFile?.mkdirs()
            t.writeBytes(data)
            if (made > 0) t.setLastModified(made)
        }
        app.prefs.setRestoredSave(gameId, id)
    }

    /** After playing: uploads the save if it changed, as this player's backup. */
    fun backup(gameId: String, rom: File, before: Map<String, Long>): JSONObject? {
        val changed = candidates(rom).filter { it.isFile && before[it.path] != it.lastModified() }.maxByOrNull { it.lastModified() } ?: return null
        val bytes = ByteArrayOutputStream()
        ZipOutputStream(bytes).use { z ->
            z.putNextEntry(ZipEntry("saves/${changed.name}").apply { time = changed.lastModified() })
            changed.inputStream().use { it.copyTo(z) }
            z.closeEntry()
        }
        val backup = app.server.upload("/api/games/${Server.enc(gameId)}/saves?device=${Server.enc(app.prefs.deviceName)}", bytes.toByteArray())
        app.prefs.setRestoredSave(gameId, backup.optLong("id"))
        return backup
    }
}
