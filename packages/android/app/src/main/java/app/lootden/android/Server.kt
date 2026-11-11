package app.lootden.android

import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class ApiException(message: String, val status: Int) : IOException(message)

/**
 * Calls to the LootDen server as the person signed in to the web page: the WebView's session
 * cookie goes along, so there's no separate sign-in for the app.
 */
class Server(private val prefs: Prefs) {
    val base: String get() = prefs.serverUrl.trimEnd('/')

    fun open(path: String, method: String = "GET", body: ByteArray? = null, contentType: String? = null, from: Long = 0): HttpURLConnection {
        if (base.isEmpty()) throw IOException("Connect to a LootDen server first")
        val c = URL(base + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15_000
        c.readTimeout = 60_000
        c.instanceFollowRedirects = true
        CookieManager.getInstance().getCookie(base)?.let { c.setRequestProperty("Cookie", it) }
        c.setRequestProperty("User-Agent", "LootDen-Android/${BuildConfig.VERSION_NAME}")
        if (from > 0) c.setRequestProperty("Range", "bytes=$from-")
        if (body != null) {
            c.doOutput = true
            contentType?.let { c.setRequestProperty("Content-Type", it) }
            c.setFixedLengthStreamingMode(body.size)
            c.outputStream.use { it.write(body) }
        }
        return c
    }

    /** The server's own message for a failed call, without the HTML of a proxy's error page. */
    fun fail(c: HttpURLConnection): ApiException {
        val text = runCatching { c.errorStream?.bufferedReader()?.readText() }.getOrNull().orEmpty()
        val msg = runCatching { JSONObject(text).optString("error") }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: text.replace(Regex("<[^>]+>"), " ").replace(Regex("\\s+"), " ").trim().take(160)
        val status = c.responseCode
        c.disconnect()
        return ApiException(if (status == 401) "Sign in to LootDen first" else "${c.requestMethod} ${c.url.path} failed with $status${if (msg.isNotEmpty()) ": $msg" else ""}", status)
    }

    fun text(path: String, method: String = "GET", json: Any? = null): String {
        val c = open(path, method, json?.toString()?.toByteArray(), if (json != null) "application/json" else null)
        if (c.responseCode !in 200..299) throw fail(c)
        return c.inputStream.bufferedReader().use { it.readText() }.also { c.disconnect() }
    }

    fun obj(path: String, method: String = "GET", json: Any? = null) = JSONObject(text(path, method, json))
    fun array(path: String) = JSONArray(text(path))

    fun bytes(path: String): ByteArray {
        val c = open(path)
        if (c.responseCode !in 200..299) throw fail(c)
        return c.inputStream.use { it.readBytes() }.also { c.disconnect() }
    }

    fun upload(path: String, data: ByteArray): JSONObject {
        val c = open(path, "POST", data, "application/octet-stream")
        if (c.responseCode !in 200..299) throw fail(c)
        return JSONObject(c.inputStream.bufferedReader().use { it.readText() }).also { c.disconnect() }
    }

    /** Install, uninstall and play time, for the family board and stats. Never throws. */
    fun activity(gameId: String, device: String, event: String, seconds: Long? = null) {
        runCatching {
            val body = JSONObject().put("gameId", gameId).put("device", device).put("event", event)
            if (seconds != null) body.put("seconds", seconds).put("endedAt", Iso.now())
            text("/api/me/activity", "POST", body)
        }
    }

    companion object {
        fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
    }
}

object Iso {
    fun format(ms: Long): String = java.time.Instant.ofEpochMilli(ms).toString()
    fun now(): String = format(System.currentTimeMillis())
    fun parse(s: String): Long = runCatching { java.time.Instant.parse(s).toEpochMilli() }.getOrDefault(0L)
}
