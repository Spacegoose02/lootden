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

    /** The save backup last brought onto this device for each game, so it's restored once. */
    fun restoredSave(gameId: String): Long = JSONObject(sp.getString("restored", "{}") ?: "{}").optLong(gameId, -1)
    fun setRestoredSave(gameId: String, id: Long) {
        val all = JSONObject(sp.getString("restored", "{}") ?: "{}")
        all.put(gameId, id)
        sp.edit().putString("restored", all.toString()).apply()
    }

    /** The name this device shows under on the PCs page and Now Playing. */
    val deviceName: String
        get() = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
            ?: listOf(Build.MANUFACTURER, Build.MODEL).filter { it.isNotBlank() }.distinct().joinToString(" ").ifBlank { "Android" }
}
