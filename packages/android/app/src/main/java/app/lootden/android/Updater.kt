package app.lootden.android

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * The app keeps itself up to date. Android won't let a sideloaded app replace itself silently, so
 * it does everything up to that point: it looks for a newer LootDen-<version>.apk on the server's
 * Get the app page and on the GitHub releases page the release workflow attaches it to, downloads
 * the newest in the background (when Install app updates automatically is on), and then one tap
 * on Install update brings up Android's own install screen.
 */
class Updater(private val app: AppCore) {
    /** Where a newer APK can be fetched from: a file on the LootDen server, or a GitHub release asset. */
    private data class Found(val version: String, val serverName: String?, val url: String?, val sha256: String?)

    @Volatile private var state = JSONObject().put("current", BuildConfig.VERSION_NAME).put("state", "idle").put("kind", "android")
    @Volatile private var found: Found? = null
    /** Waiting for the person to allow LootDen to install apps; the installer opens when they come back. */
    @Volatile private var awaitingPermission = false
    private val busy = Any()
    private val apk: File get() = File(app.context.cacheDir, "update.apk")

    private fun set(patch: JSONObject.() -> Unit): JSONObject {
        val next = JSONObject(state.toString()).apply(patch)
        state = next
        app.emit(JSONObject(next.toString()).put("gameId", "lootden-app").put("type", "appUpdate"))
        return next
    }

    fun handle(action: String?): JSONObject = when (action) {
        "check" -> check(download = false)
        "install" -> install()
        else -> state
    }

    /** At start-up: look, and with automatic updates on, have the APK downloaded and ready to install. */
    fun autoCheck() {
        cleanUp()
        check(download = true)
    }

    fun check(download: Boolean = false): JSONObject {
        if (state.optString("state") == "downloading") return state
        set { put("state", "checking") }
        val errors = mutableListOf<String>()
        val candidates = listOfNotNull(
            runCatching { fromServer() }.onFailure { errors += it.message ?: it.toString() }.getOrNull(),
            runCatching { fromGitHub() }.onFailure { errors += it.message ?: it.toString() }.getOrNull(),
        )
        // The newest wins; on a tie the server's copy, which is usually on the same network.
        val best = candidates.fold(null as Found?) { a, b -> if (a == null || compare(b.version, a.version) > 0) b else a }
        if (best == null || compare(best.version, BuildConfig.VERSION_NAME) <= 0) {
            found = null
            return if (candidates.isEmpty() && errors.isNotEmpty()) set { put("state", "error").put("error", errors.first()) }
            else set { put("state", "none").put("checkedAt", Iso.now()); remove("error"); remove("version") }
        }
        found = best
        if (ready(best.version)) return set { put("state", "ready").put("version", best.version).remove("error") }
        val available = set { put("state", "available").put("version", best.version).put("checkedAt", Iso.now()).remove("error") }
        return if (download) runCatching { fetch(best) }.getOrElse { err -> set { put("state", "error").put("error", err.message ?: err.toString()) } } else available
    }

    /** The newest APK on the server's Get the app page, if the app is connected to one. */
    private fun fromServer(): Found? {
        if (app.prefs.serverUrl.isEmpty()) return null
        val files = app.server.array("/api/clients")
        return (0 until files.length()).map { files.getJSONObject(it).getString("name") }
            .filter { it.lowercase().endsWith(".apk") }
            .mapNotNull { n -> VERSION.find(n)?.let { Found(it.value, n, null, null) } }
            .maxWithOrNull { a, b -> compare(a.version, b.version) }
    }

    /** The APK on the latest GitHub release: the repository the server mirrors, or LootDen's own. */
    private fun fromGitHub(): Found? {
        val repo = runCatching { app.server.obj("/api/clients/source").optString("repo") }.getOrNull()
            ?.takeIf { REPO.matches(it) } ?: DEFAULT_REPO
        val release = JSONObject(fetchText("https://api.github.com/repos/$repo/releases/latest", "application/vnd.github+json"))
        val assets = release.getJSONArray("assets")
        val names = (0 until assets.length()).map { assets.getJSONObject(it) }
        val asset = names.firstOrNull { it.getString("name").lowercase().endsWith(".apk") } ?: return null
        val name = asset.getString("name")
        val version = VERSION.find(name)?.value ?: VERSION.find(release.optString("tag_name"))?.value ?: return null
        // The release lists every file's checksum; the download is checked against it.
        val sha = names.firstOrNull { it.getString("name") == "SHA256SUMS" }?.let { sums ->
            runCatching { fetchText(sums.getString("browser_download_url"), "text/plain") }.getOrNull()
                ?.lineSequence()?.map { it.trim().split(Regex("\\s+\\*?")) }
                ?.firstOrNull { it.size == 2 && it[1] == name }?.get(0)?.lowercase()
        }
        return Found(version, null, asset.getString("browser_download_url"), sha)
    }

    private fun fetchText(url: String, accept: String): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 30_000
        c.setRequestProperty("Accept", accept)
        c.setRequestProperty("User-Agent", "LootDen-Android/${BuildConfig.VERSION_NAME}")
        try {
            if (c.responseCode == 404) throw IOException("No published release on GitHub")
            if (c.responseCode !in 200..299) throw IOException("GitHub answered ${c.responseCode}")
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }

    /** The downloaded APK is there and is the version on offer. */
    private fun ready(version: String): Boolean {
        val f = apk
        if (!f.isFile) return false
        val info = archiveInfo(f) ?: return false
        return info.packageName == app.context.packageName && info.versionName == version
    }

    @Suppress("DEPRECATION")
    private fun archiveInfo(f: File) = runCatching { app.context.packageManager.getPackageArchiveInfo(f.path, 0) }.getOrNull()

    /** Downloads the APK to the cache, checks it, and marks it ready to install. */
    private fun fetch(update: Found): JSONObject {
        synchronized(busy) { return download(update) }
    }

    private fun download(update: Found): JSONObject {
        if (ready(update.version)) return set { put("state", "ready").put("version", update.version).remove("error") }
        val part = File(app.context.cacheDir, "update.apk.part")
        val c = if (update.serverName != null) app.server.open("/api/clients/${Server.enc(update.serverName)}")
        else (URL(update.url ?: throw IOException("No download for the update")).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 60_000
            setRequestProperty("User-Agent", "LootDen-Android/${BuildConfig.VERSION_NAME}")
        }
        if (c.responseCode !in 200..299) {
            if (update.serverName != null) throw app.server.fail(c)
            c.disconnect()
            throw IOException("Downloading the update failed (${c.responseCode})")
        }
        val total = c.contentLengthLong
        var received = 0L
        var last = 0L
        val digest = MessageDigest.getInstance("SHA-256")
        set { put("state", "downloading").put("version", update.version).put("received", 0).put("total", total).remove("error") }
        try {
            c.inputStream.use { input ->
                part.outputStream().use { o ->
                    val buf = ByteArray(128 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        o.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        received += n
                        if (System.currentTimeMillis() - last > 300) {
                            last = System.currentTimeMillis()
                            set { put("received", received) }
                        }
                    }
                }
            }
        } finally {
            c.disconnect()
        }
        val sha = digest.digest().joinToString("") { "%02x".format(it) }
        if (update.sha256 != null && sha != update.sha256) {
            part.delete()
            throw IOException("The downloaded update didn't match the release's checksum; try again")
        }
        val info = archiveInfo(part)
        if (info == null || info.packageName != app.context.packageName) {
            part.delete()
            throw IOException("The downloaded file isn't a LootDen app")
        }
        apk.delete()
        if (!part.renameTo(apk)) throw IOException("Couldn't save the update")
        return set { put("state", "ready").put("version", info.versionName ?: update.version).put("received", received) }
    }

    /** One tap: download if it isn't yet, then Android's install screen. */
    private fun install(): JSONObject {
        return try {
            var update = found
            if (update == null || !ready(update.version)) {
                if (update == null) check(download = false)
                update = found ?: return state
                fetch(update)
            }
            launch()
            state
        } catch (err: Exception) {
            set { put("state", "error").put("error", err.message ?: err.toString()) }
        }
    }

    private fun launch() {
        app.ui {
            val ctx = app.context
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.packageManager.canRequestPackageInstalls()) {
                awaitingPermission = true
                ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                app.notice("Allow LootDen to install updates", "Turn on Allow from this source, then go back and the update opens.")
            } else {
                awaitingPermission = false
                ctx.startActivity(
                    Intent(Intent.ACTION_VIEW).setDataAndType(app.emulators.uriFor(apk), "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }
    }

    /** Back from Android's settings: if installing apps is now allowed, carry on with the update. */
    fun resumed() {
        if (!awaitingPermission) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !app.context.packageManager.canRequestPackageInstalls()) return
        val update = found ?: return
        if (ready(update.version)) launch() else awaitingPermission = false
    }

    /** Drops a downloaded APK once it's installed (or older than what's running). */
    fun cleanUp() {
        val f = apk
        if (!f.isFile) return
        val v = archiveInfo(f)?.versionName
        if (v == null || compare(v, BuildConfig.VERSION_NAME) <= 0) f.delete()
    }

    companion object {
        const val DEFAULT_REPO = "Spacegoose02/lootden"
        private val VERSION = Regex("(\\d+\\.\\d+\\.\\d+)")
        private val REPO = Regex("^[\\w.-]+/[\\w.-]+$")

        fun compare(a: String, b: String): Int {
            val x = a.split(".").map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
            val y = b.split(".").map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
            for (i in 0 until maxOf(x.size, y.size)) {
                val d = x.getOrElse(i) { 0 } - y.getOrElse(i) { 0 }
                if (d != 0) return d
            }
            return 0
        }
    }
}
