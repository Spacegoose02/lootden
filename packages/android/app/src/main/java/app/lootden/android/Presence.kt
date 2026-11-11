package app.lootden.android

import android.os.Build
import android.os.StatFs
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * The heartbeat the desktop app sends too (POST /api/me/presence): what's playing here for Now
 * Playing and parents' limits, this handheld on the PCs page, and what the server sends back
 * (a parent's message, a game sent to this handheld).
 */
class Presence(private val app: AppCore) {
    private val handled = mutableSetOf<String>()

    fun beat(): Long {
        val playing = JSONArray()
        app.session?.let { s ->
            playing.put(JSONObject().put("gameId", s.gameId).put("title", s.title).put("source", "emulated").put("startedAt", Iso.format(s.startedAt)))
        }
        val pc = JSONObject()
            .put("platform", "android")
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("addresses", JSONArray(addresses()))
            .put("disks", JSONArray(app.drives().map { d -> JSONObject().put("path", d.getString("path")).put("freeBytes", d.getLong("freeBytes")).put("totalBytes", d.getLong("totalBytes")) }))
            .put("moonlight", app.emulators.moonlightPackage() != null)
            .put("sunshine", false)
        val answer = app.server.obj("/api/me/presence", "POST", JSONObject().put("device", app.prefs.deviceName).put("playing", playing).put("pc", pc))
        val commands = answer.optJSONArray("commands") ?: JSONArray()
        for (i in 0 until commands.length()) run(commands.getJSONObject(i))
        return answer.optLong("nextInSeconds", 30).coerceIn(10, 300)
    }

    private fun run(cmd: JSONObject) {
        val id = cmd.optString("id")
        if (!handled.add(id)) return
        val from = cmd.optString("from", "Someone")
        when (cmd.optString("kind")) {
            "message" -> app.notice("Message from $from", cmd.optString("text"))
            "close" -> app.notice("$from asks you to stop playing", "${cmd.optString("text")} Save your game and close the emulator.".trim())
            "install" -> {
                val gameId = cmd.optString("gameId")
                val title = cmd.optString("title", "A game")
                if (app.library.get(gameId) != null) return
                app.notice("$from sent you $title", "It's downloading now.")
                app.io.execute {
                    runCatching { app.installer.install(gameId, null) }
                        .onSuccess { app.notice("$title is ready", "$from sent it to this handheld. Have fun!") }
                        .onFailure { if (it.message?.contains("Already install") != true) app.notice("Couldn't install $title", it.message ?: "") }
                }
            }
        }
    }

    private fun addresses(): List<String> = runCatching {
        NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }.filterIsInstance<Inet4Address>().map { it.hostAddress ?: "" }.filter { it.isNotEmpty() }
    }.getOrDefault(emptyList())

    companion object {
        fun stat(path: String): Pair<Long, Long> = runCatching { StatFs(path).let { it.availableBytes to it.totalBytes } }.getOrDefault(0L to 0L)
        @Suppress("unused") val model: String = "${Build.MANUFACTURER} ${Build.MODEL}"
    }
}
