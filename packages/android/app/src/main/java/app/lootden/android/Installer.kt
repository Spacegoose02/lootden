package app.lootden.android

import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipInputStream

class Cancelled : IOException("Cancelled")

/**
 * Downloads a console game from the server into <installDir>/<platform>/<game>, unpacks zips the
 * emulator can't open itself, and records it. Partly downloaded files carry on where they stopped.
 */
class Installer(private val app: AppCore) {
    private val running = ConcurrentHashMap<String, Boolean>()

    fun installing(): List<String> = running.keys.toList()

    fun cancel(gameId: String) {
        if (running.containsKey(gameId)) running[gameId] = true
    }

    fun install(gameId: String, dirArg: String?): JSONObject {
        if (running.putIfAbsent(gameId, false) != null) throw IllegalStateException("Already installing")
        try {
            return doInstall(gameId, dirArg)
        } catch (err: Cancelled) {
            app.emit(JSONObject().put("gameId", gameId).put("type", "cancelled").put("message", "Cancelled"))
            throw err
        } catch (err: Exception) {
            app.emit(JSONObject().put("gameId", gameId).put("type", "error").put("message", err.message ?: err.toString()))
            throw err
        } finally {
            running.remove(gameId)
        }
    }

    private fun checkCancel(gameId: String) {
        if (running[gameId] == true) throw Cancelled()
    }

    private fun doInstall(gameId: String, dirArg: String?): JSONObject {
        val game = app.server.obj("/api/games/${Server.enc(gameId)}")
        val platformId = game.optString("platform", "pc")
        if (platformId == "pc") throw IllegalStateException("PC games can't run on Android. Use Stream to play it from a PC with Moonlight, or Send to PC.")
        if (game.optString("kind", "game") != "game") throw IllegalStateException("Updates and DLC are for PC games")
        val platform = (if (platformId == AndroidApps.PLATFORM) AndroidApps.APK_PLATFORM else platformById(platformId))
            ?: throw IllegalStateException("LootDen can't play ${platformId.uppercase()} games on Android yet")
        app.requireStorage()

        val root = File(dirArg?.takeIf { it.isNotBlank() } ?: app.prefs.installDir)
        val gameDir = File(File(root, platform.id), safeFolderName(game.optString("title", gameId)))
        if (!gameDir.mkdirs() && !gameDir.isDirectory) throw IOException("Can't make the folder $gameDir. Check LootDen may manage files (Android settings, Apps, LootDen).")
        val files = game.getJSONArray("files")
        var total = 0L
        for (i in 0 until files.length()) total += files.getJSONObject(i).optLong("size")
        val free = gameDir.usableSpace
        if (free in 1 until total) throw IOException("Not enough space: ${formatBytes(total)} needed, ${formatBytes(free)} free")
        app.emit(JSONObject().put("gameId", gameId).put("type", "start").put("gameDir", gameDir.path).put("totalBytes", total))

        val count = files.length()
        for (i in 0 until count) {
            checkCancel(gameId)
            val f = files.getJSONObject(i)
            val rel = f.getString("path")
            val dest = inside(gameDir, rel)
            val size = f.optLong("size")
            if (dest.isFile && dest.length() == size) {
                app.emit(JSONObject().put("gameId", gameId).put("type", "downloaded").put("file", rel).put("skipped", true))
                continue
            }
            dest.parentFile?.mkdirs()
            download(gameId, "/api/games/${Server.enc(gameId)}/files/${f.getInt("index")}", dest, size, rel, i, count)
            app.emit(JSONObject().put("gameId", gameId).put("type", "downloaded").put("file", rel).put("skipped", false))
        }

        // Zips the emulator can't open: unpack them and remove the zip. 7z and rar stay as they are.
        val removed = mutableListOf<String>()
        for (i in 0 until count) {
            val f = files.getJSONObject(i)
            val rel = f.getString("path")
            val kind = f.optString("archive", "")
            if (kind.isEmpty() || kind in platform.extensions) continue
            if (kind != "zip") {
                app.emit(JSONObject().put("gameId", gameId).put("type", "warning").put("message", "$rel is a ${kind} archive, which the Android app can't unpack yet. Ask an admin for a zip or the unpacked game."))
                continue
            }
            checkCancel(gameId)
            app.emit(JSONObject().put("gameId", gameId).put("type", "extract").put("archive", rel))
            val zip = inside(gameDir, rel)
            unzip(zip, zip.parentFile!!)
            zip.delete()
            removed += rel
        }
        if (removed.isNotEmpty()) app.emit(JSONObject().put("gameId", gameId).put("type", "removed").put("files", org.json.JSONArray(removed)))

        // Android games are APKs: Android's package installer puts them on the handheld.
        if (platform.id == AndroidApps.PLATFORM) {
            app.library.put(app.apps.finishInstall(gameId, game, gameDir))
            app.server.activity(gameId, app.prefs.deviceName, "installed")
            app.emit(JSONObject().put("gameId", gameId).put("type", "done").put("gameDir", gameDir.path))
            return JSONObject().put("gameDir", gameDir.path)
        }

        val all = gameDir.walkTopDown().filter { it.isFile && !it.name.endsWith(".part") }.map { it.relativeTo(gameDir).path.replace('\\', '/') }.toList()
        val rom = pickRom(all, platform) ?: all.maxByOrNull { File(gameDir, it).length() }
            ?: throw IOException("The download has no game file in it")
        val record = JSONObject()
            .put("gameId", gameId)
            .put("title", game.optString("title", gameId))
            .put("dir", gameDir.path)
            .put("installedAt", Iso.now())
            .put("platform", platform.id)
            .put("needsSetup", JSONObject.NULL)
            .put("version", game.opt("version") ?: JSONObject.NULL)
            .put("rom", File(gameDir, rom).path)
        // A PS3 package downloaded again goes to ARMSX3's installer again on its next play.
        if (platform.id == "ps3") app.prefs.setPs3PackageSent(File(gameDir, rom).path, false)
        app.library.put(record)
        app.server.activity(gameId, app.prefs.deviceName, "installed")
        app.emit(JSONObject().put("gameId", gameId).put("type", "done").put("gameDir", gameDir.path))
        return JSONObject().put("gameDir", gameDir.path)
    }

    private fun download(gameId: String, path: String, dest: File, size: Long, rel: String, index: Int, count: Int) {
        val part = File(dest.path + ".part")
        var have = if (part.isFile && part.length() < size) part.length() else 0L
        val c = app.server.open(path, from = have)
        val code = c.responseCode
        if (code !in 200..299) throw app.server.fail(c)
        if (code == 200) have = 0 // The server ignored the range: start over.
        var last = 0L
        c.inputStream.use { input ->
            java.io.FileOutputStream(part, have > 0).use { out ->
                val buf = ByteArray(256 * 1024)
                var received = have
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    received += n
                    val now = System.currentTimeMillis()
                    if (now - last > 300) {
                        last = now
                        checkCancel(gameId)
                        app.emit(JSONObject().put("gameId", gameId).put("type", "download").put("file", rel).put("index", index).put("count", count).put("received", received).put("total", size))
                    }
                }
            }
        }
        c.disconnect()
        if (size > 0 && part.length() != size) throw IOException("$rel stopped downloading at ${formatBytes(part.length())} of ${formatBytes(size)}. Install again to carry on.")
        if (dest.exists()) dest.delete()
        if (!part.renameTo(dest)) throw IOException("Couldn't save $dest")
    }

    companion object {
        /** A path from the server, kept inside the game's folder. */
        fun inside(dir: File, rel: String): File {
            val f = File(dir, rel)
            if (!f.canonicalPath.startsWith(dir.canonicalPath + File.separator)) throw IOException("Unsafe file name in the game: $rel")
            return f
        }

        fun unzip(zip: File, into: File) {
            ZipInputStream(zip.inputStream().buffered()).use { zin ->
                while (true) {
                    val e = zin.nextEntry ?: break
                    val out = inside(into, e.name)
                    if (e.isDirectory) out.mkdirs()
                    else {
                        out.parentFile?.mkdirs()
                        out.outputStream().use { zin.copyTo(it, 256 * 1024) }
                    }
                }
            }
        }

        /** Same rules as safeFolderName in packages/shared: no characters Windows or Android refuse. */
        fun safeFolderName(name: String): String =
            name.replace(Regex("[<>:\"/\\\\|?*\\u0000-\\u001f]"), " ").replace(Regex("\\s+"), " ").trim().trimEnd('.').ifEmpty { "Game" }.take(120)

        fun formatBytes(n: Long): String {
            val units = listOf("B", "KB", "MB", "GB", "TB")
            var v = n.toDouble()
            var u = 0
            while (v >= 1024 && u < units.size - 1) { v /= 1024; u++ }
            return if (u == 0) "$n B" else String.format(java.util.Locale.US, "%.1f %s", v, units[u])
        }
    }
}
