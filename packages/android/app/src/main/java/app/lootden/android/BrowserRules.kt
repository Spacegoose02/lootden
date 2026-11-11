package app.lootden.android

import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/**
 * The built-in browser's rules, ported from the desktop app's (packages/shared/src/browser.ts,
 * packages/client/src/browser.ts, packages/shared/src/downloadlinks.ts) so a profile's browser
 * settings mean the same on a handheld. Keep them in step.
 */
data class BrowserPolicy(val mode: String, val allowed: List<String>, val blocked: List<String>) {
    val kids get() = mode == "kids"

    companion object {
        fun from(json: JSONObject?): BrowserPolicy? {
            if (json == null) return null
            fun list(key: String) = json.optJSONArray(key)?.let { a -> (0 until a.length()).mapNotNull { BrowserRules.cleanSite(a.optString(it)) } } ?: emptyList()
            return BrowserPolicy(if (json.optString("mode") == "kids") "kids" else "open", list("allowed"), list("blocked"))
        }
    }
}

data class Bookmark(val title: String, val url: String) {
    fun json(): JSONObject = JSONObject().put("title", title).put("url", url)
}

object BrowserRules {
    val KID_SITES = listOf(
        "kiddle.co", "pbskids.org", "kids.nationalgeographic.com", "kids.britannica.com", "scratch.mit.edu", "code.org",
        "khanacademy.org", "starfall.com", "abcya.com", "funbrain.com", "lego.com", "nasa.gov", "duolingo.com",
    )
    const val KID_SEARCH = "https://www.kiddle.co/s.php?q="

    val SEARCH_ENGINES = linkedMapOf(
        "google" to ("Google" to "https://www.google.com/search?q="),
        "bing" to ("Bing" to "https://www.bing.com/search?q="),
        "duckduckgo" to ("DuckDuckGo" to "https://duckduckgo.com/?q="),
    )

    /** The desktop app's start page, with Android's own picks for a handheld in place of the PC stores. */
    val DEFAULT_BOOKMARKS = listOf(
        Bookmark("YouTube", "https://www.youtube.com/"),
        Bookmark("Twitch", "https://www.twitch.tv/"),
        Bookmark("Discord", "https://discord.com/app"),
        Bookmark("Xbox Cloud Gaming", "https://www.xbox.com/play"),
        Bookmark("GeForce NOW", "https://play.geforcenow.com/"),
        Bookmark("Steam Store", "https://store.steampowered.com/"),
        Bookmark("GOG", "https://www.gog.com/"),
        Bookmark("Epic Games Store", "https://store.epicgames.com/"),
        Bookmark("PCGamingWiki", "https://www.pcgamingwiki.com/"),
        Bookmark("Reddit", "https://www.reddit.com/"),
    )
    val KID_BOOKMARKS = listOf(
        Bookmark("Kiddle", "https://www.kiddle.co/"),
        Bookmark("PBS Kids", "https://pbskids.org/"),
        Bookmark("Nat Geo Kids", "https://kids.nationalgeographic.com/"),
        Bookmark("Scratch", "https://scratch.mit.edu/"),
        Bookmark("Code.org", "https://code.org/"),
        Bookmark("Khan Academy", "https://www.khanacademy.org/"),
        Bookmark("ABCya", "https://www.abcya.com/"),
        Bookmark("Starfall", "https://www.starfall.com/"),
        Bookmark("LEGO", "https://www.lego.com/kids"),
        Bookmark("NASA", "https://www.nasa.gov/"),
    )
    const val MAX_BOOKMARKS = 60

    private val SITE = Regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z][a-z0-9-]*[a-z0-9]$|^localhost$|^\\d{1,3}(\\.\\d{1,3}){3}$")

    fun cleanSite(input: String?): String? {
        var text = (input ?: "").trim().lowercase()
        if (text.isEmpty()) return null
        text = text.replace(Regex("^[a-z][a-z0-9+.-]*://"), "").replace(Regex("^\\*\\."), "")
        val host = text.split(Regex("[/?#]"))[0].split("@").last().replace(Regex(":\\d+$"), "").replace(Regex("^www\\."), "").removeSuffix(".")
        return if (host.length <= 253 && SITE.matches(host)) host else null
    }

    fun onSite(host: String, site: String): Boolean {
        val h = host.lowercase().removeSuffix(".")
        return h == site || h.endsWith(".$site")
    }

    fun isBrowsable(url: String): Boolean {
        val u = runCatching { Uri.parse(url) }.getOrNull() ?: return false
        return (u.scheme == "http" || u.scheme == "https") && !u.host.isNullOrEmpty() && u.userInfo == null
    }

    fun siteAllowed(url: String, policy: BrowserPolicy?, framesOnly: Boolean = false): Boolean {
        val u = runCatching { Uri.parse(url) }.getOrNull() ?: return false
        if (u.scheme != "http" && u.scheme != "https") return false
        val host = u.host ?: return false
        if (policy == null) return true
        if (policy.blocked.any { onSite(host, it) }) return false
        if (policy.mode == "open" || framesOnly) return true
        return (KID_SITES + policy.allowed).any { onSite(host, it) }
    }

    /** The same search with safe search on (Google, Bing, DuckDuckGo), or null. */
    fun safeSearchUrl(url: String): String? {
        val u = runCatching { Uri.parse(url) }.getOrNull() ?: return null
        val host = (u.host ?: return null).removePrefix("www.")
        val path = u.path ?: ""
        val want = when {
            Regex("^google\\.[a-z.]+$").matches(host) && (path == "/search" || path.startsWith("/search/")) -> "safe" to "active"
            host == "bing.com" && path.startsWith("/search") -> "adlt" to "strict"
            host == "duckduckgo.com" && u.getQueryParameter("q") != null -> "kp" to "1"
            else -> return null
        }
        if (u.getQueryParameter(want.first) == want.second) return null
        val b = u.buildUpon().clearQuery()
        for (name in u.queryParameterNames) if (name != want.first) for (v in u.getQueryParameters(name)) b.appendQueryParameter(name, v)
        b.appendQueryParameter(want.first, want.second)
        return b.build().toString()
    }

    /** What the address bar opens for typed text (addressToUrl). */
    fun addressToUrl(input: String, engine: String, searchBase: String? = null): String {
        val text = input.trim()
        if (text.isEmpty()) return ""
        val search = (searchBase ?: SEARCH_ENGINES[engine]?.second ?: SEARCH_ENGINES.getValue("google").second) + Uri.encode(text)
        if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(text)) return if (isBrowsable(text)) text else search
        if (Regex("^[a-z][a-z0-9+.-]*:(?!\\d)", RegexOption.IGNORE_CASE).containsMatchIn(text) && !Regex("^[\\w-]+(\\.[\\w-]+)*:\\d+").containsMatchIn(text)) return search
        if (Regex("\\s").containsMatchIn(text)) return search
        val host = text.split(Regex("[/?#]"))[0]
        val local = Regex("^(localhost|\\d{1,3}(\\.\\d{1,3}){3})(:\\d+)?$", RegexOption.IGNORE_CASE).matches(host) ||
            Regex("^[\\w-]+\\.(local|lan|home|internal)(:\\d+)?$", RegexOption.IGNORE_CASE).matches(host)
        val site = Regex("^([a-z0-9-]+\\.)+[a-z][a-z0-9-]{1,62}(:\\d+)?$", RegexOption.IGNORE_CASE).matches(host)
        if (!local && !site) return search
        val url = "${if (local) "http" else "https"}://$text"
        return if (isBrowsable(url)) url else search
    }

    fun siteName(url: String): String = runCatching { Uri.parse(url).host?.removePrefix("www.") }.getOrNull() ?: url

    fun cleanBookmarks(list: JSONArray?): List<Bookmark> {
        if (list == null) return emptyList()
        val seen = mutableSetOf<String>()
        val out = mutableListOf<Bookmark>()
        for (i in 0 until list.length()) {
            val item = list.optJSONObject(i) ?: continue
            val url = item.optString("url").trim()
            if (!isBrowsable(url) || !seen.add(url)) continue
            out += Bookmark(item.optString("title").trim().take(80).ifEmpty { siteName(url) }, url)
            if (out.size >= MAX_BOOKMARKS) break
        }
        return out
    }

    /** Which downloader takes a link: "torrent", "usenet", "direct", or null. */
    fun downloadLinkKind(url: String): String? {
        val u = url.trim()
        if (Regex("^magnet:\\?", RegexOption.IGNORE_CASE).containsMatchIn(u)) return if (Regex("[?&]xt=urn:bt[im]h:", RegexOption.IGNORE_CASE).containsMatchIn(u)) "torrent" else null
        val p = runCatching { Uri.parse(u) }.getOrNull() ?: return null
        if (p.scheme != "http" && p.scheme != "https") return null
        val path = (p.path ?: "").lowercase()
        return when {
            path.endsWith(".torrent") -> "torrent"
            path.endsWith(".nzb") -> "usenet"
            else -> "direct"
        }
    }

    fun downloadLinkTitle(url: String): String {
        val u = url.trim()
        if (u.startsWith("magnet:?", true)) {
            val dn = Uri.parse("http://x/?" + u.substringAfter('?')).getQueryParameter("dn")
            if (!dn.isNullOrBlank()) return dn.trim().take(200)
            val hash = Regex("xt=urn:bt[im]h:([a-z0-9]+)", RegexOption.IGNORE_CASE).find(u)?.groupValues?.get(1)
            return if (hash != null) "Magnet ${hash.take(12)}" else "Magnet link"
        }
        return runCatching {
            val p = Uri.parse(u)
            val last = p.pathSegments.lastOrNull()?.replace(Regex("\\.(torrent|nzb)$", RegexOption.IGNORE_CASE), "") ?: ""
            last.ifEmpty { p.host ?: "Download" }.take(200)
        }.getOrDefault("Download")
    }
}
