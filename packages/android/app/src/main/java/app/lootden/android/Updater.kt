package app.lootden.android

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.io.File

/**
 * The app updates itself from the server's Get the app page, like the desktop app: the release
 * workflow attaches LootDen-<version>.apk and an admin's Get latest release puts it on the server.
 */
class Updater(private val app: AppCore) {
    @Volatile private var state = JSONObject().put("current", BuildConfig.VERSION_NAME).put("state", "idle").put("kind", "installer")
    @Volatile private var file: String? = null

    private fun set(patch: JSONObject.() -> Unit): JSONObject {
        val next = JSONObject(state.toString()).apply(patch)
        state = next
        app.emit(JSONObject(next.toString()).put("gameId", "lootden-app").put("type", "appUpdate"))
        return next
    }

    fun handle(action: String?): JSONObject = when (action) {
        "check" -> check()
        "install" -> install()
        else -> state
    }

    fun check(): JSONObject {
        set { put("state", "checking") }
        return try {
            val files = app.server.array("/api/clients")
            val apk = (0 until files.length()).map { files.getJSONObject(it).getString("name") }
                .mapNotNull { n -> Regex("(\\d+\\.\\d+\\.\\d+)").find(n)?.let { n to it.value }.takeIf { n.lowercase().endsWith(".apk") } }
                .maxWithOrNull { a, b -> compare(a.second, b.second) }
            if (apk != null && compare(apk.second, BuildConfig.VERSION_NAME) > 0) {
                file = apk.first
                set { put("state", "available").put("version", apk.second).remove("error") }
            } else set { put("state", "none").put("checkedAt", Iso.now()).remove("error") }
        } catch (err: Exception) {
            set { put("state", "error").put("error", err.message ?: err.toString()) }
        }
    }

    private fun install(): JSONObject {
        if (file == null) check()
        val name = file ?: return state
        val out = File(app.context.cacheDir, "update.apk")
        try {
            val c = app.server.open("/api/clients/${Server.enc(name)}")
            if (c.responseCode !in 200..299) throw app.server.fail(c)
            val total = c.contentLengthLong
            var received = 0L
            var last = 0L
            set { put("state", "downloading").put("received", 0).put("total", total) }
            c.inputStream.use { input ->
                out.outputStream().use { o ->
                    val buf = ByteArray(128 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        o.write(buf, 0, n)
                        received += n
                        if (System.currentTimeMillis() - last > 300) {
                            last = System.currentTimeMillis()
                            set { put("received", received) }
                        }
                    }
                }
            }
            c.disconnect()
            val ready = set { put("state", "ready").put("received", received) }
            app.ui {
                val ctx = app.context
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.packageManager.canRequestPackageInstalls()) {
                    ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    app.notice("Allow LootDen to install updates", "Then choose Restart to update again.")
                } else {
                    ctx.startActivity(
                        Intent(Intent.ACTION_VIEW).setDataAndType(app.emulators.uriFor(out), "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                }
            }
            return ready
        } catch (err: Exception) {
            return set { put("state", "error").put("error", err.message ?: err.toString()) }
        }
    }

    companion object {
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
