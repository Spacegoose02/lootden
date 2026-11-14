package app.lootden.android

import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.Settings
import org.json.JSONObject
import java.io.File

/** What the app keeps on this device: the server, where games go and which emulator plays what. */
class Prefs(private val context: Context) {
    private val sp = context.getSharedPreferences("lootden", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("serverUrl", "") ?: ""
        set(v) = sp.edit().putString("serverUrl", v).apply()

    /** Games go to <installDir>/<platform>/<game>, so a frontend's ROMs folder layout works too. */
    var installDir: String
        get() = sp.getString("installDir", null) ?: File(Environment.getExternalStorageDirectory(), "ROMs").path
        set(v) = sp.edit().putString("installDir", v).apply()

    var autoUpdate: Boolean
        get() = sp.getBoolean("autoUpdate", true)
        set(v) = sp.edit().putBoolean("autoUpdate", v).apply()

    /** The emulator picked for a platform, or null to use the best one installed. */
    fun emulatorFor(platform: String): String? = sp.getString("emulator.$platform", null)
    fun setEmulator(platform: String, id: String?) {
        sp.edit().apply { if (id == null) remove("emulator.$platform") else putString("emulator.$platform", id) }.apply()
    }

    /** PS3 packages already handed to ARMSX3's installer, by file, so later plays start the installed game instead. */
    fun ps3PackageSent(path: String): Boolean = sp.getStringSet("ps3PackagesSent", emptySet())!!.contains(path)
    fun setPs3PackageSent(path: String, sent: Boolean) {
        val all = sp.getStringSet("ps3PackagesSent", emptySet())!!.toMutableSet()
        if (sent) all += path else all -= path
        sp.edit().putStringSet("ps3PackagesSent", all).apply()
    }

    /** The save backup last brought onto this device for each game, so it's restored once. */
    fun restoredSave(gameId: String): Long = JSONObject(sp.getString("restored", "{}") ?: "{}").optLong(gameId, -1)
    fun setRestoredSave(gameId: String, id: Long) {
        val all = JSONObject(sp.getString("restored", "{}") ?: "{}")
        all.put(gameId, id)
        sp.edit().putString("restored", all.toString()).apply()
    }

    private fun str(key: String) = sp.getString(key, null)
    private fun putStr(key: String, v: String?) = sp.edit().apply { if (v == null) remove(key) else putString(key, v) }.apply()

    /** The browser's own bookmarks as JSON, or null for the starting set. */
    var browserBookmarks: String?
        get() = str("browserBookmarks")
        set(v) = putStr("browserBookmarks", v)

    var browserSearch: String
        get() = str("browserSearch")?.takeIf { it in BrowserRules.SEARCH_ENGINES } ?: "google"
        set(v) = putStr("browserSearch", v)

    /** Where links from LootDen's pages open: "auto" or "on" (the built-in browser) or "off" (Android's). */
    var browserLinks: String
        get() = str("browserLinks")?.takeIf { it in setOf("auto", "on", "off") } ?: "auto"
        set(v) = putStr("browserLinks", v)

    /** The last browser rules from the server, for when it can't be reached. */
    var browserPolicy: String?
        get() = str("browserPolicy")
        set(v) = putStr("browserPolicy", v)

    /** The web UI's colours, so the browser's toolbar matches the theme. */
    var theme: String?
        get() = str("theme")
        set(v) = putStr("theme", v)

    /** The name this device shows under on the PCs page and Now Playing. */
    val deviceName: String
        get() = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
            ?: listOf(Build.MANUFACTURER, Build.MODEL).filter { it.isNotBlank() }.distinct().joinToString(" ").ifBlank { "Android" }
}
