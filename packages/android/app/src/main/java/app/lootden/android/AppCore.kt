package app.lootden.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/** A game started from LootDen: play time runs until the player comes back to LootDen. */
data class Session(
    val gameId: String,
    val title: String,
    val platform: String,
    val rom: File,
    val emulatorId: String?,
    val startedAt: Long,
    val savesBefore: Map<String, Long>,
)

/**
 * Everything behind the web page's window.lootden on Android. One per process, so a download or
 * a game session carries on when the activity is recreated.
 */
class AppCore private constructor(val context: Context) {
    val prefs = Prefs(context)
    val server = Server(prefs)
    val library = Library(context)
    val emulators = Emulators(context, prefs)
    val installer = Installer(this)
    val saves = Saves(this)
    val presence = Presence(this)
    val updater = Updater(this)
    val io = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())

    /** Sends an event to the page (download progress, play sessions, app updates). Set by the activity. */
    @Volatile var sink: ((String) -> Unit)? = null
    @Volatile var activity: MainActivity? = null
    @Volatile var session: Session? = null
    private var beating = false

    fun ui(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
    }

    fun emit(event: JSONObject) {
        val text = JSONObject().put("event", event).toString()
        ui { sink?.invoke(text) }
    }

    /** A heads-up on screen: a toast, and the page's own banner (FunLayer shows "limit" events). */
    fun notice(title: String, text: String) {
        ui { Toast.makeText(context, if (text.isBlank()) title else "$title\n$text", Toast.LENGTH_LONG).show() }
        emit(JSONObject().put("gameId", "").put("type", "limit").put("title", title).put("message", text))
    }

    /** Games go to shared storage, which needs All files access on Android 11 and later. */
    fun requireStorage() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (Environment.isExternalStorageManager()) return
            ui {
                val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                runCatching { context.startActivity(intent) }.onFailure {
                    context.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            }
            throw IllegalStateException("Turn on \"Allow access to manage all files\" for LootDen, so your emulators can open the games it downloads. Then press Install again.")
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) return
        ui { activity?.requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE, Manifest.permission.READ_EXTERNAL_STORAGE), 7) }
        throw IllegalStateException("Allow LootDen to use storage, then press Install again.")
    }

    /** Internal storage and SD cards, as the desktop app's drives. */
    fun drives(): List<JSONObject> = context.getExternalFilesDirs(null).filterNotNull().mapNotNull { dir ->
        val root = dir.path.substringBefore("/Android/data")
        if (root.isEmpty()) return@mapNotNull null
        val (free, total) = Presence.stat(root)
        val removable = runCatching { Environment.isExternalStorageRemovable(dir) }.getOrDefault(false)
        JSONObject().put("path", root).put("label", if (removable) "SD card" else "Internal storage").put("freeBytes", free).put("totalBytes", total)
    }

    // ---- The page's calls -------------------------------------------------------------------

    /** Runs one window.lootden call off the main thread and answers on it. */
    fun call(id: Long, method: String, args: JSONArray, reply: (String) -> Unit) {
        io.execute {
            val answer = JSONObject().put("id", id)
            try {
                answer.put("ok", true).put("result", dispatch(method, args) ?: JSONObject.NULL)
            } catch (err: Throwable) {
                answer.put("ok", false).put("error", err.message ?: err.toString())
            }
            val text = answer.toString()
            ui { reply(text) }
        }
    }

    private fun JSONArray.str(i: Int): String? = if (isNull(i)) null else optString(i)

    @SuppressLint("QueryPermissionsNeeded")
    private fun dispatch(method: String, a: JSONArray): Any? = when (method) {
        "info" -> JSONObject()
            .put("platform", "android")
            .put("version", BuildConfig.VERSION_NAME)
            .put("installDir", prefs.installDir)
            .put("libraryDirs", JSONArray(listOf(prefs.installDir)))
            .put("hostname", prefs.deviceName)
            .put("installing", JSONArray(installer.installing()))
        "drives" -> JSONArray(drives())
        "chooseFolder" -> activity?.pickFolder()
        "setInstallDir" -> a.str(0)!!.also { prefs.installDir = it }
        "installed" -> library.forPage()
        "install" -> installer.install(a.str(0)!!, a.str(1))
        "cancel" -> installer.cancel(a.str(0)!!).let { null }
        "play" -> play(a.str(0)!!)
        "uninstall" -> uninstall(a.str(0)!!)
        "openFolder" -> library.get(a.str(0)!!)?.let { notice("Files are in", it.optString("dir")) }.let { null }
        "changeServer" -> { ui { activity?.changeServer() }; null }
        "toggleFullscreen" -> true
        "appSettings" -> appSettings(a.optJSONObject(0))
        "appUpdate" -> updater.handle(a.str(0))
        "quit" -> { ui { activity?.finishAndRemoveTask() }; null }
        "streaming" -> JSONObject().put("hostname", prefs.deviceName).put("sunshine", false).put("moonlight", emulators.moonlightPackage() != null).put("linked", false).put("streamGames", 0)
        "streamGame" -> streamGame()
        "androidEmulators" -> emulators.overview()
        "setAndroidEmulator" -> { prefs.setEmulator(a.str(0)!!, a.str(1)); emulators.overview() }
        "openStore" -> { openStore(a.str(0)!!); null }
        else -> throw IllegalArgumentException("The Android app doesn't do $method yet")
    }

    private fun appSettings(patch: JSONObject?): JSONObject {
        if (patch != null && patch.has("autoUpdate")) prefs.autoUpdate = patch.getBoolean("autoUpdate")
        return JSONObject()
            .put("closeToTray", false)
            .put("autoUpdate", prefs.autoUpdate)
            .put("openAtLogin", false)
            .put("trayAvailable", false)
            .put("loginItemSupported", false)
            .put("handheldActive", true)
    }

    private fun play(gameId: String): JSONObject {
        val g = library.get(gameId) ?: throw IllegalStateException("Install the game on this handheld first")
        session?.let { if (it.gameId != gameId) endSession() else throw IllegalStateException("${it.title} is already running") }
        val platform = g.optString("platform")
        val rom = File(g.getString("rom"))
        val emu = emulators.choiceFor(platform)
        val retro = emu?.id == "retroarch"
        if (retro) runCatching { saves.restore(gameId, rom) }
        val before = if (retro) saves.snapshot(rom) else emptyMap()
        val started = emulators.launch(platform, rom)
        session = Session(gameId, g.optString("title", gameId), platform, rom, started?.id, System.currentTimeMillis(), before)
        emit(JSONObject().put("gameId", gameId).put("type", "playing"))
        io.execute { runCatching { presence.beat() } }
        return JSONObject().put("executable", started?.name ?: "Open with")
    }

    /** The player came back to LootDen: the game's session is over. */
    fun endSession() {
        val s = session ?: return
        session = null
        val seconds = (System.currentTimeMillis() - s.startedAt) / 1000
        emit(JSONObject().put("gameId", s.gameId).put("type", "stopped").put("seconds", seconds))
        // A start that bounced straight back (no emulator, a missing core) isn't play time.
        if (seconds < 5) return
        io.execute {
            server.activity(s.gameId, prefs.deviceName, "played", seconds)
            if (s.emulatorId == "retroarch") {
                runCatching { saves.backup(s.gameId, s.rom, s.savesBefore) }
                    .onSuccess { b -> if (b != null) emit(JSONObject().put("gameId", s.gameId).put("type", "saves").put("backupId", b.optLong("id")).put("size", b.optLong("size"))) }
                    .onFailure { emit(JSONObject().put("gameId", s.gameId).put("type", "saves").put("error", it.message ?: "Couldn't back up the save")) }
            }
            runCatching { presence.beat() }
        }
    }

    private fun uninstall(gameId: String): Boolean {
        val g = library.get(gameId) ?: return false
        val dir = File(g.optString("dir"))
        // Only the game's own folder, never a ROMs folder someone pointed the record at.
        if (dir.isDirectory && dir.parentFile?.name == g.optString("platform")) dir.deleteRecursively()
        library.remove(gameId)
        server.activity(gameId, prefs.deviceName, "uninstalled")
        return true
    }

    private fun streamGame(): JSONObject {
        val pkg = emulators.moonlightPackage()
        if (pkg == null) {
            openStore("com.limelight")
            throw IllegalStateException("Install Moonlight first, then pair it with your PC's Sunshine")
        }
        val launch = context.packageManager.getLaunchIntentForPackage(pkg) ?: throw IllegalStateException("Couldn't open Moonlight")
        ui { context.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        return JSONObject().put("opened", "moonlight")
    }

    /** The emulator's (or Moonlight's) store page: Google Play when there is one, else the web. */
    fun openStore(pkg: String) = ui {
        val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(market) }.onFailure {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$pkg")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    /** The heartbeat, every half minute (or what the server asks for) while the app runs. */
    fun startHeartbeat() {
        if (beating) return
        beating = true
        fun next(delay: Long) {
            main.postDelayed({
                io.execute {
                    val wait = if (prefs.serverUrl.isEmpty()) 30L else runCatching { presence.beat() }.getOrDefault(30L)
                    ui { next(wait * 1000) }
                }
            }, delay)
        }
        next(2_000)
        if (prefs.autoUpdate) main.postDelayed({ io.execute { updater.check() } }, 20_000)
    }

    companion object {
        @Volatile private var instance: AppCore? = null
        fun get(context: Context): AppCore = instance ?: synchronized(this) {
            instance ?: AppCore(context.applicationContext).also { instance = it }
        }
    }
}
