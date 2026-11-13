package app.lootden.android

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Message
import android.os.SystemClock
import android.util.Base64
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.ceil

/**
 * LootDen's built-in web browser on Android: the desktop app's toolbar and start page
 * (browser.html, with the same controller layout) over tabs of their own. Under the signed-in
 * person's browser rules from the server: blocked sites, kid-safe mode with safe search, and its
 * own sign-ins, kept apart from LootDen's (on WebViews that have profiles).
 */
class BrowserActivity : Activity() {
    private class Tab(val id: Int) {
        var view: WebView? = null
        var title = "New tab"
        var url = ""
        var favicon = ""
        var loading = false
        /** The site the rules kept this tab from opening, while it shows why. */
        var blocked: String? = null
        /** The controller's pointer, in the page's CSS pixels. */
        var px = 200f
        var py = 200f
    }

    private data class Offer(val url: String, val title: String, val kind: String)

    private lateinit var core: AppCore
    private lateinit var root: FrameLayout
    private lateinit var shell: WebView
    private lateinit var pages: FrameLayout
    private val tabs = mutableListOf<Tab>()
    private var active = 0
    private var nextId = 1
    private var toolbarPx = 0
    private var policy: BrowserPolicy? = null
    private var ready = false
    private var offered: Offer? = null
    private val sent = mutableListOf<JSONObject>()
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val density get() = resources.displayMetrics.density

    private val kids get() = policy?.kids == true
    private val profileName get() = if (kids) "lootden-browser-kids" else "lootden-browser"
    private val tab get() = tabs.getOrNull(active)

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        core = AppCore.get(this)
        root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#0D0820")) }
        pages = FrameLayout(this)
        shell = WebView(this)
        shell.setBackgroundColor(Color.parseColor("#0D0820"))
        shell.defaultFocusHighlightEnabled = false // see createView
        shell.settings.javaScriptEnabled = true
        shell.settings.domStorageEnabled = true
        shell.addJavascriptInterface(ShellBridge(), "LootDenBrowserNative")
        shell.webViewClient = object : WebViewClient() {
            // The toolbar never goes anywhere else.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
        }
        root.addView(pages, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(shell, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        immersive()

        val first = intent?.getStringExtra(EXTRA_URL)
        // The rules come first, so a kid-safe browser never shows an unchecked page.
        core.io.execute {
            val p = fetchPolicy()
            core.ui {
                if (isFinishing || isDestroyed) return@ui
                policy = p
                ready = true
                newTab(first?.takeIf { BrowserRules.isBrowsable(it) } ?: "")
                // The desktop page, with window.lootdenBrowser first in its head (its rules allow inline scripts only).
                val shim = assets.open("browser-android.js").bufferedReader().use { it.readText() }
                val page = assets.open("browser.html").bufferedReader().use { it.readText() }.replaceFirst("<head>", "<head><script>$shim</script>")
                shell.loadDataWithBaseURL("file:///android_asset/browser.html", page, "text/html", "utf-8", null)
            }
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        val url = intent?.getStringExtra(EXTRA_URL)
        if (ready && url != null && BrowserRules.isBrowsable(url)) newTab(url)
    }

    override fun onDestroy() {
        for (t in tabs) t.view?.destroy()
        shell.destroy()
        super.onDestroy()
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

    // The toolbar reads the controller through the Gamepad API, which any focused WebView feeds,
    // so a controller press with nothing focused goes to the toolbar.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (currentFocus !is WebView && fullscreenView == null) shell.requestFocus()
        return super.dispatchKeyEvent(event)
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        if (currentFocus !is WebView && fullscreenView == null) shell.requestFocus()
        return super.dispatchGenericMotionEvent(event)
    }

    @Deprecated("Back handling without androidx.activity")
    override fun onBackPressed() {
        when {
            fullscreenView != null -> fullscreenCallback?.onCustomViewHidden()
            tab?.view?.canGoBack() == true -> tab?.view?.goBack()
            else -> finish()
        }
    }

    private fun fetchPolicy(): BrowserPolicy? {
        val kept = core.prefs.browserPolicy?.let { BrowserPolicy.from(JSONObject(it)) }
        return try {
            val p = BrowserPolicy.from(core.server.obj("/api/me/browser"))
            core.prefs.browserPolicy = p?.let { JSONObject().put("mode", it.mode).put("allowed", JSONArray(it.allowed)).put("blocked", JSONArray(it.blocked)).toString() }
            p
        } catch (err: ApiException) {
            // A server from before browser rules has none to give.
            if (err.status == 404) null.also { core.prefs.browserPolicy = null } else kept
        } catch (err: Exception) {
            kept
        }
    }

    // ---- Tabs -----------------------------------------------------------------------------

    private fun newTab(url: String = "") {
        val t = Tab(nextId++)
        tabs += t
        select(t.id)
        if (url.isNotEmpty()) load(t, url)
    }

    private fun closeTab(id: Int) {
        val at = tabs.indexOfFirst { it.id == id }
        if (at < 0) return
        val t = tabs.removeAt(at)
        t.view?.let { pages.removeView(it); it.destroy() }
        if (tabs.isEmpty()) return finish()
        active = minOf(if (active > at) active - 1 else active, tabs.size - 1)
        select(tabs[active].id)
    }

    private fun select(id: Int) {
        val at = tabs.indexOfFirst { it.id == id }
        if (at < 0) return
        active = at
        for (t in tabs) t.view?.visibility = if (t.id == id) View.VISIBLE else View.GONE
        layoutViews()
        push()
    }

    private fun step(by: Int) {
        if (tabs.size < 2) return
        select(tabs[(active + by + tabs.size) % tabs.size].id)
    }

    private fun home() {
        val t = tab ?: return
        t.view?.let { pages.removeView(it); it.destroy() }
        t.view = null
        t.title = "New tab"
        t.url = ""
        t.favicon = ""
        t.blocked = null
        layoutViews()
        push()
    }

    private fun load(t: Tab, url: String) {
        if (!BrowserRules.isBrowsable(url)) return
        val view = t.view ?: createView(t).also {
            t.view = it
            pages.addView(it, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            it.visibility = if (tab === t) View.VISIBLE else View.GONE
            layoutViews()
        }
        if (!BrowserRules.siteAllowed(url, policy)) return showBlocked(t, url)
        val target = if (kids) BrowserRules.safeSearchUrl(url) ?: url else url
        t.blocked = null
        t.url = target
        t.title = BrowserRules.siteName(target)
        view.loadUrl(target)
        if (tab === t) view.requestFocus()
        push()
    }

    private fun showBlocked(t: Tab, url: String) {
        val view = t.view ?: return
        val site = BrowserRules.siteName(url)
        view.stopLoading()
        t.blocked = site
        t.url = url
        t.title = "$site is blocked"
        t.favicon = ""
        view.loadUrl("file:///android_asset/blocked.html?site=${Uri.encode(site)}&kids=${if (kids) "1" else ""}")
        push()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createView(t: Tab): WebView {
        val view = WebView(this)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            ProfileStore.getInstance().getOrCreateProfile(profileName)
            WebViewCompat.setProfile(view, profileName)
        }
        view.setBackgroundColor(Color.WHITE)
        view.isFocusable = true
        view.isFocusableInTouchMode = true
        // Android 8+ tints a focused view with no focus drawable in translucent white whenever a d-pad or
        // controller (not touch) moved focus: over a full-screen WebView that washes out the whole app.
        view.defaultFocusHighlightEnabled = false
        with(view.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            builtInZoomControls = true
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                return when (request.url.scheme) {
                    "http", "https" -> {
                        if (!BrowserRules.siteAllowed(url, policy, framesOnly = !request.isForMainFrame)) {
                            if (request.isForMainFrame) showBlocked(t, url)
                            true
                        } else if (kids && request.isForMainFrame) {
                            BrowserRules.safeSearchUrl(url)?.let { v.loadUrl(it); true } ?: false
                        } else false
                    }
                    "about", "data", "blob" -> false
                    else -> {
                        external(url)
                        true
                    }
                }
            }

            override fun onPageStarted(v: WebView, url: String, favicon: Bitmap?) {
                // A redirect the check above didn't see.
                if (url.startsWith("http") && !BrowserRules.siteAllowed(url, policy)) return showBlocked(t, url)
                if (!url.startsWith("file:")) t.blocked = null
                t.loading = true
                if (!url.startsWith("file:")) t.url = url
                push()
            }

            override fun onPageFinished(v: WebView, url: String) {
                t.loading = false
                if (t.blocked == null && !url.startsWith("file:")) {
                    t.url = url
                    t.title = v.title?.takeIf { it.isNotBlank() } ?: BrowserRules.siteName(url)
                }
                push()
            }

            override fun doUpdateVisitedHistory(v: WebView, url: String, isReload: Boolean) {
                if (t.blocked == null && !url.startsWith("file:")) t.url = url
                push()
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(v: WebView, title: String?) {
                if (t.blocked == null && !title.isNullOrBlank()) t.title = title
                push()
            }

            override fun onReceivedIcon(v: WebView, icon: Bitmap?) {
                t.favicon = icon?.let { dataUrl(it) } ?: ""
                push()
            }

            override fun onCreateWindow(v: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                // Links that open a new window become a new tab.
                val catcher = WebView(this@BrowserActivity)
                if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) WebViewCompat.setProfile(catcher, profileName)
                catcher.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(c: WebView, request: WebResourceRequest): Boolean {
                        val url = request.url.toString()
                        if (BrowserRules.isBrowsable(url)) newTab(url) else external(url)
                        return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = catcher
                resultMsg.sendToTarget()
                return true
            }

            override fun onShowCustomView(v: View, callback: CustomViewCallback) {
                fullscreenCallback?.onCustomViewHidden()
                fullscreenView = v
                fullscreenCallback = callback
                root.addView(v, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }

            override fun onHideCustomView() {
                fullscreenView?.let { root.removeView(it) }
                fullscreenView = null
                fullscreenCallback = null
            }

            override fun onShowFileChooser(v: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
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
        view.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
            // Torrents and NZBs go to the server's downloaders, after a yes in the toolbar.
            if (canSend && url.startsWith("http") && (name.endsWith(".torrent", true) || name.endsWith(".nzb", true) || mimeType?.contains("bittorrent") == true || mimeType?.contains("nzb") == true)) {
                val kind = if (name.endsWith(".nzb", true) || mimeType?.contains("nzb") == true) "usenet" else "torrent"
                offer(url, name.replace(Regex("\\.(torrent|nzb)$", RegexOption.IGNORE_CASE), ""), kind)
            } else download(url, userAgent, contentDisposition, mimeType)
        }
        return view
    }

    /** A link out of the web: a magnet to the downloads (after a yes), an app link opened by Android. Kid-safe browsing stays put. */
    private fun external(url: String) {
        if (kids) return
        if (url.startsWith("magnet:", true)) {
            offer(url)
            return
        }
        runCatching {
            val intent = if (url.startsWith("intent:", true)) Intent.parseUri(url, Intent.URI_INTENT_SCHEME).addCategory(Intent.CATEGORY_BROWSABLE) else Intent(Intent.ACTION_VIEW, Uri.parse(url))
            startActivity(intent)
        }
    }

    private fun download(url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
        runCatching {
            val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val req = DownloadManager.Request(Uri.parse(url))
                .addRequestHeader("Cookie", cookies().getCookie(url) ?: "")
                .addRequestHeader("User-Agent", userAgent ?: "")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            Toast.makeText(this, "Downloading $name", Toast.LENGTH_SHORT).show()
        }.onFailure { Toast.makeText(this, "Couldn't download: ${it.message}", Toast.LENGTH_LONG).show() }
    }

    private fun cookies(): CookieManager =
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) ProfileStore.getInstance().getOrCreateProfile(profileName).cookieManager else CookieManager.getInstance()

    private fun dataUrl(icon: Bitmap): String {
        val out = ByteArrayOutputStream()
        Bitmap.createScaledBitmap(icon, 32, 32, true).compress(Bitmap.CompressFormat.PNG, 100, out)
        return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    // ---- Sending links to LootDen's downloads --------------------------------------------

    private val canSend get() = !kids

    private fun offer(url: String, text: String? = null, kindIn: String? = null) {
        val kind = kindIn ?: BrowserRules.downloadLinkKind(url) ?: return
        if (!canSend) return
        val named = text?.trim()?.takeIf { it.isNotEmpty() && !Regex("^(https?:|magnet:)", RegexOption.IGNORE_CASE).containsMatchIn(it) }?.take(200)
        val title = if (kind == "torrent" && url.startsWith("magnet:", true)) BrowserRules.downloadLinkTitle(url) else named ?: BrowserRules.downloadLinkTitle(url)
        offered = Offer(url, title, kind)
        shell.requestFocus()
        push()
        shell.evaluateJavascript("window.__lootdenBrowser && window.__lootdenBrowser.event('offer')", null)
    }

    /** Sends a link (the one offered when none is given) to the server; answers how it went. */
    private fun sendDownload(urlArg: String?, reply: (Boolean, Any?) -> Unit) {
        val offer = if (urlArg == null) offered else null
        val link = (urlArg ?: offer?.url ?: "").trim()
        if (!canSend) return reply(false, "Sending links to downloads isn't available here")
        if (BrowserRules.downloadLinkKind(link) == null) return reply(false, "That isn't a magnet link or a web address")
        if (offer != null) offered = null
        core.io.execute {
            val result = try {
                val body = JSONObject().put("url", link)
                offer?.let { body.put("title", it.title).put("kind", it.kind) }
                val r = core.server.obj("/api/downloads/link", "POST", body)
                JSONObject().put("title", r.optString("title", offer?.title ?: link)).put("ok", true).put("message", "Sent to ${r.optString("to", "downloads")}")
            } catch (err: ApiException) {
                val why = when (err.status) {
                    404 -> "The server is too old for this; update it to send links from the browser"
                    403 -> "Only admins can send downloads"
                    else -> err.message ?: "Couldn't send it"
                }
                JSONObject().put("title", offer?.title ?: BrowserRules.downloadLinkTitle(link)).put("ok", false).put("message", why)
            } catch (err: Exception) {
                JSONObject().put("title", offer?.title ?: BrowserRules.downloadLinkTitle(link)).put("ok", false).put("message", err.message ?: "Can't reach the LootDen server")
            }
            core.ui {
                sent.add(0, result)
                while (sent.size > 5) sent.removeAt(sent.size - 1)
                push()
                reply(true, result)
            }
        }
    }

    // ---- Layout and state -----------------------------------------------------------------

    private fun layoutViews() {
        val onPage = tab?.view != null
        val lp = shell.layoutParams as FrameLayout.LayoutParams
        lp.height = if (onPage && toolbarPx > 0) toolbarPx else ViewGroup.LayoutParams.MATCH_PARENT
        shell.layoutParams = lp
        val pl = pages.layoutParams as FrameLayout.LayoutParams
        pl.topMargin = if (onPage) toolbarPx else 0
        pages.layoutParams = pl
        pages.visibility = if (onPage) View.VISIBLE else View.GONE
    }

    private fun bookmarks(): List<Bookmark> {
        if (kids) return BrowserRules.KID_BOOKMARKS.filter { BrowserRules.siteAllowed(it.url, policy) }
        return core.prefs.browserBookmarks?.let { BrowserRules.cleanBookmarks(JSONArray(it)) } ?: BrowserRules.DEFAULT_BOOKMARKS
    }

    private fun saveBookmarks(list: List<Bookmark>?) {
        core.prefs.browserBookmarks = list?.let { l -> JSONArray(l.map { it.json() }).toString() }
        push()
    }

    private fun state(): JSONObject {
        val t = tab
        val onPage = t?.view != null && t.blocked == null && t.url.startsWith("http")
        return JSONObject()
            .put("tabs", JSONArray(tabs.map { x ->
                JSONObject().put("id", x.id).put("title", x.title).put("url", x.url).put("favicon", x.favicon)
                    .put("start", x.view == null).put("loading", x.view != null && x.loading).put("blocked", x.blocked != null)
            }))
            .put("active", t?.id ?: 0)
            .put("canGoBack", t?.view?.canGoBack() == true)
            .put("canGoForward", t?.view?.canGoForward() == true)
            .put("bookmarks", JSONArray(bookmarks().map { it.json() }))
            .put("launchers", JSONArray())
            .put("search", if (kids) "kiddle" else core.prefs.browserSearch)
            .put("engines", if (kids) JSONArray().put(JSONObject().put("id", "kiddle").put("name", "Kiddle"))
                else JSONArray(BrowserRules.SEARCH_ENGINES.map { (id, e) -> JSONObject().put("id", id).put("name", e.first) }))
            .put("kids", kids)
            .put("theme", core.prefs.theme?.let { JSONObject(it) } ?: JSONObject.NULL)
            .put("downloads", JSONObject()
                .put("available", canSend)
                .put("offer", offered?.let { JSONObject().put("url", it.url).put("title", it.title).put("kind", it.kind) } ?: JSONObject.NULL)
                .put("sent", JSONArray(sent))
                .put("page", onPage))
            .put("frame", JSONObject().put("custom", false).put("fullscreen", true).put("height", 44).put("handheld", true))
    }

    private fun push() {
        if (!ready) return
        shell.evaluateJavascript("window.__lootdenBrowser && window.__lootdenBrowser.event('state', ${state()})", null)
    }

    // ---- The controller pointer -----------------------------------------------------------

    private fun pointer(dx: Float, dy: Float) {
        val t = tab ?: return
        val v = t.view ?: return
        t.px = (t.px + dx).coerceIn(0f, v.width / density - 1)
        t.py = (t.py + dy).coerceIn(0f, v.height / density - 1)
        v.evaluateJavascript(pointerScript(t.px, t.py), null)
    }

    private fun click(right: Boolean) {
        val t = tab ?: return
        val v = t.view ?: return
        if (right) {
            // X on a link offers it to LootDen's downloads.
            v.evaluateJavascript("(() => { const a = document.elementFromPoint(${t.px}, ${t.py})?.closest('a[href]'); return a ? [a.href, (a.textContent || '').trim()] : null })()") { r ->
                val arr = runCatching { JSONArray(r) }.getOrNull() ?: return@evaluateJavascript
                if (!offerIfLink(arr.optString(0), arr.optString(1))) Toast.makeText(this, "That link can't go to LootDen's downloads", Toast.LENGTH_SHORT).show()
            }
            return
        }
        v.requestFocus()
        val x = t.px * density
        val y = t.py * density
        val down = SystemClock.uptimeMillis()
        val e1 = MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0)
        val e2 = MotionEvent.obtain(down, down + 40, MotionEvent.ACTION_UP, x, y, 0)
        v.dispatchTouchEvent(e1)
        v.dispatchTouchEvent(e2)
        e1.recycle()
        e2.recycle()
    }

    private fun offerIfLink(url: String, text: String): Boolean {
        if (!canSend || BrowserRules.downloadLinkKind(url) == null) return false
        offer(url, text)
        return true
    }

    private fun scroll(dx: Float, dy: Float) {
        val t = tab ?: return
        // The nearest scrolling box under the pointer, or the page.
        t.view?.evaluateJavascript(
            "(() => { let el = document.elementFromPoint(${t.px}, ${t.py}); while (el && el !== document.body && !(el.scrollHeight > el.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement; (el && el !== document.body ? el : window).scrollBy(${dx}, ${dy}); })()",
            null,
        )
    }

    private fun key(name: String) {
        val v = tab?.view ?: return
        val code = when (name) {
            "Up" -> KeyEvent.KEYCODE_DPAD_UP
            "Down" -> KeyEvent.KEYCODE_DPAD_DOWN
            "Left" -> KeyEvent.KEYCODE_DPAD_LEFT
            "Right" -> KeyEvent.KEYCODE_DPAD_RIGHT
            "Enter" -> KeyEvent.KEYCODE_ENTER
            "Escape" -> KeyEvent.KEYCODE_ESCAPE
            "Space" -> KeyEvent.KEYCODE_SPACE
            else -> return
        }
        v.requestFocus()
        v.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
        v.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
    }

    @Deprecated("Activity results without androidx.activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == PICK_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        }
    }

    // ---- The toolbar's calls --------------------------------------------------------------

    /** window.lootdenBrowser on the toolbar page; nothing else ever loads in that WebView. */
    inner class ShellBridge {
        @JavascriptInterface
        fun call(id: Int, name: String, argsJson: String) {
            val args = runCatching { JSONArray(argsJson) }.getOrDefault(JSONArray())
            core.ui {
                if (isDestroyed) return@ui
                val reply = { ok: Boolean, value: Any? ->
                    val v = if (ok) (value ?: JSONObject.NULL).let { if (it is String) JSONObject.quote(it) else it.toString() } else JSONObject.quote(value?.toString() ?: "")
                    shell.evaluateJavascript("window.__lootdenBrowser.reply($id, $ok, $v)", null)
                }
                try {
                    if (name == "sendDownload") return@ui sendDownload(args.optString(0).takeIf { !args.isNull(0) && it.isNotBlank() }?.take(8192), reply)
                    if (name == "sendPage") {
                        val t = tab
                        return@ui if (t?.view != null && t.url.startsWith("http")) sendDownload(t.url, reply) else reply(true, null)
                    }
                    reply(true, handle(name, args))
                } catch (err: Exception) {
                    reply(false, err.message ?: err.toString())
                }
            }
        }
    }

    private fun handle(name: String, a: JSONArray): Any? {
        val t = tab
        when (name) {
            "state" -> return state()
            "layout" -> {
                val css = a.optDouble(0, Double.NaN)
                if (!css.isNaN()) {
                    toolbarPx = ceil(css * density).toInt().coerceIn((40 * density).toInt(), (400 * density).toInt())
                    layoutViews()
                }
            }
            "navigate" -> {
                val url = BrowserRules.addressToUrl(a.optString(0).take(4096), core.prefs.browserSearch, if (kids) BrowserRules.KID_SEARCH else null)
                if (t != null && url.isNotEmpty()) load(t, url)
            }
            "back" -> t?.view?.goBack()
            "forward" -> t?.view?.goForward()
            "reload" -> t?.view?.reload()
            "stop" -> t?.view?.stopLoading()
            "home" -> home()
            "newTab" -> newTab()
            "closeTab" -> closeTab(a.optInt(0))
            "selectTab" -> select(a.optInt(0))
            "stepTab" -> a.optInt(0).let { if (it == 1 || it == -1) step(it) }
            "open" -> a.optString(0).let { if (t != null && BrowserRules.isBrowsable(it)) load(t, it) }
            "bookmarks" -> if (!kids) saveBookmarks(BrowserRules.cleanBookmarks(a.optJSONArray(0)))
            "resetBookmarks" -> if (!kids) saveBookmarks(null)
            "toggleBookmark" -> if (!kids && t?.view != null && t.blocked == null && BrowserRules.isBrowsable(t.url)) {
                val list = bookmarks()
                saveBookmarks(if (list.any { it.url == t.url }) list.filter { it.url != t.url } else list + Bookmark(t.title.ifBlank { BrowserRules.siteName(t.url) }, t.url))
            }
            "search" -> {
                a.optString(0).let { if (it in BrowserRules.SEARCH_ENGINES) core.prefs.browserSearch = it }
                push()
            }
            "launch" -> {}
            "close" -> finish()
            "fullscreen" -> immersive()
            "focusPage" -> t?.view?.requestFocus()
            "focusShell" -> shell.requestFocus()
            "pointer" -> pointer(a.optDouble(0, 0.0).toFloat().coerceIn(-80f, 80f), a.optDouble(1, 0.0).toFloat().coerceIn(-80f, 80f))
            "click" -> click(a.optString(0) == "right")
            "scroll" -> scroll(a.optDouble(0, 0.0).toFloat().coerceIn(-400f, 400f), a.optDouble(1, 0.0).toFloat().coerceIn(-400f, 400f))
            "key" -> key(a.optString(0))
            "dismissOffer" -> {
                offered = null
                push()
            }
            "openDownloads" -> {
                core.activity?.openPath("/downloads")
                finish()
            }
            else -> throw IllegalArgumentException("Unknown call $name")
        }
        return null
    }

    companion object {
        const val EXTRA_URL = "url"
        private const val PICK_FILE = 1

        /** The controller pointer, drawn over the page (the desktop app's look). */
        fun pointerScript(x: Float, y: Float) = """(() => {
  let c = document.getElementById("__lootden_pointer");
  if (!c) {
    c = document.createElement("div");
    c.id = "__lootden_pointer";
    c.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;border:3px solid #fff;background:rgba(46,242,255,.35);box-shadow:0 0 0 2px rgba(0,0,0,.6),0 0 14px #2ef2ff;transition:opacity .4s";
    document.documentElement.appendChild(c);
  }
  c.style.transform = "translate(${x}px, ${y}px)";
  c.style.opacity = "1";
  clearTimeout(window.__lootdenPointerTimer);
  window.__lootdenPointerTimer = setTimeout(() => (c.style.opacity = "0"), 4000);
})()"""
    }
}
