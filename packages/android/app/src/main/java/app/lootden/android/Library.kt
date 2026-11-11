package app.lootden.android

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Games installed on this device, kept as the desktop app's InstalledGame objects
 * (packages/web/src/desktop.ts) plus the ROM to open.
 */
class Library(context: Context) {
    private val file = File(context.filesDir, "installed.json")

    @Synchronized
    fun all(): List<JSONObject> {
        val arr = runCatching { JSONArray(file.readText()) }.getOrElse { JSONArray() }
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    fun get(gameId: String): JSONObject? = all().firstOrNull { it.optString("gameId") == gameId }

    @Synchronized
    fun put(game: JSONObject) {
        save(all().filter { it.optString("gameId") != game.optString("gameId") } + game)
    }

    @Synchronized
    fun remove(gameId: String) {
        save(all().filter { it.optString("gameId") != gameId })
    }

    private fun save(list: List<JSONObject>) {
        val tmp = File(file.path + ".tmp")
        tmp.writeText(JSONArray(list).toString())
        tmp.renameTo(file)
    }

    /** What the web page gets: the manifest without the app's own fields. */
    fun forPage(): JSONArray = JSONArray(all().map { g -> JSONObject(g.toString()).apply { remove("rom") } })
}
