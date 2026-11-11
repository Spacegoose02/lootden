package app.lootden.android

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Message
import android.provider.DocumentsContract
import android.view.KeyEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The LootDen web UI full screen, with window.lootden for installing and playing games. Built
 * for handhelds such as the Retroid Pocket: landscape, no system bars, and the web UI's own
 * controller navigation (the Gamepad API works in the WebView as it does in Chrome).
 */
class MainActivity : Activity() {
    private lateinit var core: AppCore
    private lateinit var web: WebView
    private val bridgeJs by lazy { assets.open("bridge.js").bufferedReader().use { it.readText() } }
    private var scriptHandler: ScriptHandler? = null
    private var listening = false
    @Volatile private var currentUrl = ""
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var folderLatch: CountDownLatch? = null
    @Volatile private var folderResult: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        core = AppCore.get(this)
        core.activity = this
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#120C24"))
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            userAgentString = "$userAgentString LootDenAndroid/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.addJavascriptInterface(SetupBridge(), "LootDenSetup")
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        web.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ -> download(url, userAgent, contentDisposition, mimeType) }
        setContentView(web)
        immersive()

        core.sink = { text -> if (listening) proxy?.postMessage(text) }
        core.startHeartbeat()
        start(intent?.data)
    }

    override fun onDestroy() {
        if (core.activity === this) {
            core.activity = null
            core.sink = null
        }
        web.destroy()
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        immersive()
        core.endSession()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        intent?.data?.let { start(it) }
    }

    private fun immersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // ---- Server and bridge ------------------------------------------------------------------

    private val origin: String
        get() = core.prefs.serverUrl.let { runCatching { Uri.parse(it).let { u -> "${u.scheme}://${u.authority}" } }.getOrDefault("") }

    /** Opens the server (or the connect page), and a lootden://install/<id> link's game. */
    private fun start(link: Uri?) {
        if (core.prefs.serverUrl.isEmpty()) {
            web.loadUrl("file:///android_asset/connect.html")
            return
        }
        bridgeFor(origin)
        val game = link?.takeIf { it.scheme == "lootden" && it.host == "install" }?.lastPathSegment
        web.loadUrl(if (game != null) "$origin/games/${Uri.encode(game)}?install=1" else "$origin/")
    }

    private var proxy: androidx.webkit.JavaScriptReplyProxy? = null

    /** window.lootden on the server's pages only: the script and the message channel are tied to its origin. */
    private fun bridgeFor(origin: String) {
        scriptHandler?.remove()
        scriptHandler = null
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            if (listening) WebViewCompat.removeWebMessageListener(web, "LootDenNative")
            WebViewCompat.addWebMessageListener(web, "LootDenNative", setOf(origin)) { _, message, _, isMainFrame, reply ->
                if (!isMainFrame) return@addWebMessageListener
                val m = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return@addWebMessageListener
                val method = m.optString("method")
                if (method == "hello") {
                    proxy = reply
                    return@addWebMessageListener
                }
                core.call(m.optLong("id"), method, m.optJSONArray("args") ?: JSONArray()) { text -> reply.postMessage(text) }
            }
            listening = true
        } else {
            Toast.makeText(this, "Update Android System WebView to install and play games from LootDen", Toast.LENGTH_LONG).show()
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            scriptHandler = WebViewCompat.addDocumentStartJavaScript(web, bridgeJs, setOf(origin))
        }
    }

    /** A page of the server's, from the browser (its Downloads button). */
    fun openPath(path: String) {
        if (origin.isNotEmpty()) web.loadUrl(origin + path)
    }

    fun changeServer() {
        core.prefs.serverUrl = ""
        web.loadUrl("file:///android_asset/connect.html")
    }

    /** The connect page's one call: check the address answers like a LootDen server, then open it. */
    inner class SetupBridge {
        @JavascriptInterface
        fun connect(input: String) {
            if (!currentUrl.startsWith("file:///android_asset/")) return
            core.io.execute {
                val error = try {
                    val raw = input.trim().let { if (it.contains("://")) it else "http://$it" }
                    val u = Uri.parse(raw)
                    require(u.scheme == "http" || u.scheme == "https") { "Use an http:// or https:// address" }
                    val base = "${u.scheme}://${u.authority}"
                    val c = URL("$base/api/health").openConnection() as HttpURLConnection
                    c.connectTimeout = 8_000
                    c.readTimeout = 8_000
                    val ok = c.responseCode == 200 && runCatching { JSONObject(c.inputStream.bufferedReader().readText()).has("version") }.getOrDefault(false)
                    c.disconnect()
                    require(ok) { "That address answers, but it isn't a LootDen server" }
                    core.prefs.serverUrl = base
                    null
                } catch (err: Exception) {
                    err.message ?: "Couldn't reach that address"
                }
                core.ui {
                    if (error == null) start(null)
                    else web.evaluateJavascript("window.lootdenConnected && window.lootdenConnected(${JSONObject.quote(error)})", null)
                }
            }
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            return when (url.scheme) {
                "http", "https", "file", "about", "data", "blob" -> false
                "lootden" -> { start(url); true }
                "intent" -> {
                    runCatching { startActivity(Intent.parseUri(url.toString(), Intent.URI_INTENT_SCHEME).addCategory(Intent.CATEGORY_BROWSABLE)) }
                    true
                }
                else -> {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                    true
                }
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            currentUrl = url
            // Old WebViews without document-start scripts: early enough for the page's module scripts.
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) && origin.isNotEmpty() && url.startsWith(origin)) {
                view.evaluateJavascript(bridgeJs, null)
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame || origin.isEmpty() || !request.url.toString().startsWith(origin)) return
            val q = "error=${Uri.encode("${error.description}. Check the handheld is on the same network as the server.")}&server=${Uri.encode(origin)}"
            view.loadUrl("file:///android_asset/connect.html?$q")
        }
    }

    private inner class Chrome : WebChromeClient() {
        /** Links that open a new window (news, trailers, store pages) go to LootDen's browser, or Android's when chosen. */
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            val catcher = WebView(this@MainActivity)
            catcher.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    if (core.prefs.browserLinks != "off" && BrowserRules.isBrowsable(url)) core.openBrowser(url)
                    else runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                    return true
                }
            }
            (resultMsg.obj as WebView.WebViewTransport).webView = catcher
            resultMsg.sendToTarget()
            return true
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                startActivityForResult(params.createIntent(), PICK_FILE)
                true
            } catch (err: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }
    }

    /** Files the page offers to download (exports, screenshots) go to Downloads, signed in. */
    private fun download(url: String, userAgent: String, contentDisposition: String?, mimeType: String?) {
        runCatching {
            val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val req = DownloadManager.Request(Uri.parse(url))
                .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                .addRequestHeader("User-Agent", userAgent)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            Toast.makeText(this, "Downloading $name", Toast.LENGTH_SHORT).show()
        }.onFailure { Toast.makeText(this, "Couldn't download: ${it.message}", Toast.LENGTH_LONG).show() }
    }

    /** The folder picker, turned into a path emulators can open. Called off the main thread; waits for the answer. */
    fun pickFolder(): String? {
        val latch = CountDownLatch(1)
        folderLatch = latch
        folderResult = null
        core.ui {
            runCatching { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), PICK_FOLDER) }.onFailure { latch.countDown() }
        }
        latch.await(10, TimeUnit.MINUTES)
        return folderResult
    }

    @Deprecated("Activity results without androidx.activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            PICK_FILE -> {
                fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
                fileCallback = null
            }
            PICK_FOLDER -> {
                folderResult = data?.data?.takeIf { resultCode == RESULT_OK }?.let { treePath(it) }
                if (resultCode == RESULT_OK && folderResult == null) Toast.makeText(this, "Pick a folder on internal storage or the SD card", Toast.LENGTH_LONG).show()
                folderLatch?.countDown()
            }
        }
    }

    @Deprecated("Back handling without androidx.activity")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // Keep the web page focused, so the d-pad and buttons reach its controller navigation.
        if (!web.hasFocus()) web.requestFocus(View.FOCUS_DOWN)
        return super.dispatchKeyEvent(event)
    }

    companion object {
        private const val PICK_FILE = 1
        private const val PICK_FOLDER = 2

        /** content://…/tree/primary:ROMs → /storage/emulated/0/ROMs; 1234-ABCD:Games → /storage/1234-ABCD/Games. */
        fun treePath(tree: Uri): String? {
            val id = runCatching { DocumentsContract.getTreeDocumentId(tree) }.getOrNull() ?: return null
            val volume = id.substringBefore(':')
            val rel = id.substringAfter(':', "")
            val root = if (volume.equals("primary", true)) Environment.getExternalStorageDirectory().path else if (Regex("[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}").matches(volume)) "/storage/$volume" else return null
            return if (rel.isEmpty()) root else "$root/$rel"
        }
    }
}
