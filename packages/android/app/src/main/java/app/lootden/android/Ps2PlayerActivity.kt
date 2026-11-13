package app.lootden.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * PS2 games in the browser player (TabStationToo, PCSX2 compiled to WebAssembly) on the handheld.
 *
 * The emulator's threads share memory, which a browser allows only on a cross-origin isolated
 * page, and only in a secure context: https, or localhost. A LootDen server at home is usually
 * plain http://192.168.x.x, so in the app's WebView (and in Chrome) the emulator stops with "this
 * site needs a service worker" whatever headers the server sends.
 *
 * This screen gets around that the way Android's WebViewAssetLoader does: it loads the player from
 * https://appassets.androidplatform.net, a name reserved for apps that never reaches the network,
 * and answers every request for it itself, fetching the same path from the LootDen server with the
 * person's sign-in and adding the isolation headers. To the WebView that's a secure, isolated
 * page. Memory cards and save states stay in this screen's storage on the handheld.
 */
class Ps2PlayerActivity : Activity() {
    private lateinit var core: AppCore
    private lateinit var web: WebView
    private var gameId = ""
    private var startedAt = 0L
    private var backAt = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        core = AppCore.get(this)
        gameId = intent.getStringExtra(EXTRA_GAME).orEmpty()
        val path = intent.getStringExtra(EXTRA_PATH)
        if (gameId.isEmpty() || path == null || !path.startsWith("/")) {
            finish()
            return
        }
        web = WebView(this)
        web.setBackgroundColor(Color.BLACK)
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        // Android 8+ tints a focused view with no focus drawable in translucent white whenever a d-pad or
        // controller (not touch) moved focus: over a full-screen WebView that washes out the whole app.
        web.defaultFocusHighlightEnabled = false
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString LootDenAndroid/${BuildConfig.VERSION_NAME}"
        }
        web.webViewClient = Proxy(core.server.base)
        web.webChromeClient = WebChromeClient()
        setContentView(web)
        immersive()
        startedAt = SystemClock.elapsedRealtime()
        web.loadUrl(ORIGIN + path)
        web.requestFocus()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    private fun immersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    /** Back twice to quit: one stray press (the controller's B can send it) shouldn't end the game. */
    @Deprecated("Back handling without androidx.activity")
    override fun onBackPressed() {
        val now = SystemClock.elapsedRealtime()
        if (now - backAt < 2_000) {
            finish()
            return
        }
        backAt = now
        Toast.makeText(this, "Press back again to quit the game. Save first: memory cards stay on this handheld.", Toast.LENGTH_SHORT).show()
    }

    override fun onDestroy() {
        if (::web.isInitialized) {
            // Play time, as the browser player and the emulators count it.
            val seconds = (SystemClock.elapsedRealtime() - startedAt) / 1000
            if (seconds >= 5) {
                val id = gameId
                core.io.execute { core.server.activity(id, core.prefs.deviceName, "played", seconds) }
            }
            web.destroy()
        }
        super.onDestroy()
    }

    /** Answers the player's requests from the LootDen server, as a cross-origin isolated https page. */
    private class Proxy(private val server: String) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // Links out of the player (its About box) open outside this screen.
            if (request.url.host == HOST) return false
            runCatching { view.context.startActivity(Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url
            if (url.host != HOST) return null
            // Only reads: WebView doesn't hand over a request's body, and the player only reads.
            if (request.method != "GET" && request.method != "HEAD") return text(405, "Method Not Allowed", "Only GET here")
            return try {
                fetch(url, request)
            } catch (err: IOException) {
                text(502, "Bad Gateway", "Couldn't reach the LootDen server: ${err.message}")
            }
        }

        private fun fetch(url: Uri, request: WebResourceRequest): WebResourceResponse {
            val path = (url.encodedPath ?: "/") + (url.encodedQuery?.let { "?$it" } ?: "")
            val c = URL(server + path).openConnection() as HttpURLConnection
            c.requestMethod = request.method
            c.connectTimeout = 15_000
            c.readTimeout = 60_000
            c.instanceFollowRedirects = true
            // The disc streams in byte ranges. No conditional headers: a 304 can't be handed to WebView.
            for ((k, v) in request.requestHeaders) {
                if (k.lowercase() in FORWARD) c.setRequestProperty(k, v)
            }
            CookieManager.getInstance().getCookie(server)?.let { c.setRequestProperty("Cookie", it) }
            c.setRequestProperty("User-Agent", "LootDen-Android/${BuildConfig.VERSION_NAME}")
            val status = c.responseCode
            // A redirect HttpURLConnection won't follow (http to https): WebView can't take a 3xx from here.
            if (status in 300..399) {
                c.disconnect()
                return text(502, "Bad Gateway", "The LootDen server redirected to ${c.getHeaderField("Location")}. Connect the app to that address instead.")
            }
            val headers = LinkedHashMap<String, String>()
            for ((k, v) in c.headerFields) {
                if (k == null || v.isNullOrEmpty() || k.lowercase() in DROP) continue
                headers[k] = v.joinToString(", ")
            }
            headers.putAll(ISOLATION)
            val type = c.contentType ?: "application/octet-stream"
            val mime = type.substringBefore(';').trim()
            val charset = Regex("charset=([^;]+)", RegexOption.IGNORE_CASE).find(type)?.groupValues?.get(1)?.trim()?.trim('"')
            val body = if (status >= 400) c.errorStream else c.inputStream
            val reason = c.responseMessage?.takeIf { it.isNotBlank() } ?: if (status < 400) "OK" else "Error"
            return WebResourceResponse(mime, charset, status, reason, headers, body ?: "".byteInputStream())
        }

        private fun text(status: Int, reason: String, message: String) =
            WebResourceResponse("text/plain", "utf-8", status, reason, ISOLATION, message.byteInputStream())
    }

    companion object {
        /** Reserved for apps by Android's WebViewAssetLoader: never a real site. */
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
        const val EXTRA_GAME = "game"
        const val EXTRA_PATH = "path"

        /** What a cross-origin isolated page needs (the server's ISOLATION_HEADERS). */
        val ISOLATION = mapOf(
            "Cross-Origin-Opener-Policy" to "same-origin",
            "Cross-Origin-Embedder-Policy" to "require-corp",
            "Cross-Origin-Resource-Policy" to "same-origin",
        )
        private val FORWARD = setOf("range", "if-range", "accept", "accept-language")
        // Hop-by-hop and length headers: WebView sizes the stream itself, and the isolation headers are set above.
        private val DROP = setOf("connection", "keep-alive", "transfer-encoding", "content-encoding", "content-type", "set-cookie") + ISOLATION.keys.map { it.lowercase() }

        /**
         * Opens a PS2 game in the player: asks the server for the game's player page first, so
         * play time limits, bedtime and the admin's switch apply as they do in a browser.
         */
        fun open(context: Context, core: AppCore, gameId: String) {
            val c = core.server.open("/api/games/${Server.enc(gameId)}/play")
            c.instanceFollowRedirects = false
            val status = c.responseCode
            if (status !in 300..399) {
                if (status >= 400) throw core.server.fail(c)
                c.disconnect()
                throw IllegalStateException("This game doesn't play in the browser player")
            }
            val location = c.getHeaderField("Location").orEmpty()
            c.disconnect()
            val path = Uri.parse(location).let { u -> (u.encodedPath ?: "") + (u.encodedQuery?.let { "?$it" } ?: "") }
            if (!path.startsWith("/")) throw IllegalStateException("The server sent the player somewhere unexpected")
            core.ui {
                context.startActivity(
                    Intent(context, Ps2PlayerActivity::class.java)
                        .putExtra(EXTRA_GAME, gameId)
                        .putExtra(EXTRA_PATH, path)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }
    }
}
