package app.lootden.android

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * The systems LootDen plays on Android: the same ids and file types as
 * packages/shared/src/platforms.ts (keep them in step; a test checks the ids).
 * PS3, Xbox and Xbox 360 aren't here: nothing plays them on an Android handheld yet.
 */
data class Platform(val id: String, val name: String, val extensions: List<String>)

val PLATFORMS = listOf(
    Platform("ps1", "PlayStation", listOf("m3u", "cue", "chd", "pbp", "iso", "bin", "img", "ecm")),
    Platform("ps2", "PlayStation 2", listOf("chd", "iso", "cso", "zso", "cue", "bin", "gz")),
    Platform("psp", "PlayStation Portable", listOf("chd", "cso", "iso", "pbp")),
    Platform("nes", "NES", listOf("nes", "fds", "unf", "zip", "7z")),
    Platform("snes", "Super Nintendo", listOf("sfc", "smc", "zip", "7z")),
    Platform("n64", "Nintendo 64", listOf("z64", "n64", "v64", "zip", "7z")),
    Platform("gb", "Game Boy", listOf("gb", "zip", "7z")),
    Platform("gbc", "Game Boy Color", listOf("gbc", "gb", "zip", "7z")),
    Platform("gba", "Game Boy Advance", listOf("gba", "zip", "7z")),
    Platform("nds", "Nintendo DS", listOf("nds", "zip", "7z")),
    Platform("gamecube", "GameCube", listOf("rvz", "iso", "gcm", "ciso")),
    Platform("wii", "Wii", listOf("rvz", "wbfs", "iso")),
    Platform("genesis", "Sega Genesis", listOf("md", "gen", "smd", "bin", "zip", "7z")),
    Platform("saturn", "Sega Saturn", listOf("m3u", "cue", "chd")),
    Platform("dreamcast", "Dreamcast", listOf("m3u", "gdi", "chd", "cdi")),
)

fun platformById(id: String): Platform? = PLATFORMS.firstOrNull { it.id == id }

/** The file an emulator should open: playlists and cue sheets before their tracks, then the platform's types in order (pickRomFile). */
fun pickRom(files: List<String>, platform: Platform): String? {
    for (ext in platform.extensions) {
        val hits = files.filter { it.lowercase().endsWith(".$ext") }
        if (hits.isNotEmpty()) return hits.sortedWith(compareBy<String>({ it.count { c -> c == '/' } }, { it })).first()
    }
    return null
}

/** How a game is handed to an emulator. */
enum class Handoff {
    /** RetroArch's own launch extras with a file path and a core. */
    RETROARCH,
    /** A content:// link in an extra, to a named activity. */
    EXTRA,
    /** ACTION_VIEW with a content:// link, to the app's own handler. */
    VIEW,
}

data class Emulator(
    val id: String,
    val name: String,
    val packages: List<String>,
    val handoff: Handoff,
    val platforms: List<String>,
    /** The activity that starts a game, when the app needs one named. */
    val activity: String? = null,
    /** The extra the game goes in (Handoff.EXTRA). */
    val extra: String? = null,
    /** Its Google Play listing, when it has one. */
    val store: String? = packages.first(),
)

/** RetroArch cores per platform, by their Android file name (<core>_libretro_android.so). */
val RETROARCH_CORES = mapOf(
    "ps1" to "pcsx_rearmed",
    "ps2" to "play",
    "psp" to "ppsspp",
    "nes" to "fceumm",
    "snes" to "snes9x",
    "n64" to "mupen64plus_next_gles3",
    "gb" to "gambatte",
    "gbc" to "gambatte",
    "gba" to "mgba",
    "nds" to "melonds",
    "gamecube" to "dolphin",
    "wii" to "dolphin",
    "genesis" to "genesis_plus_gx",
    "saturn" to "yabasanshiro",
    "dreamcast" to "flycast",
)

/**
 * Emulators LootDen knows how to start, best first for each platform. The launch details are the
 * ones Android frontends (ES-DE, Daijisho) use. "ask" opens Android's Open with… instead.
 */
val EMULATORS = listOf(
    Emulator("duckstation", "DuckStation", listOf("com.github.stenzek.duckstation"), Handoff.EXTRA, listOf("ps1"), "com.github.stenzek.duckstation.EmulationActivity", "bootPath"),
    Emulator("aethersx2", "NetherSX2 / AetherSX2", listOf("xyz.aethersx2.android"), Handoff.EXTRA, listOf("ps2"), "xyz.aethersx2.android.EmulationActivity", "bootPath", store = null),
    Emulator("ppsspp", "PPSSPP", listOf("org.ppsspp.ppssppgold", "org.ppsspp.ppsspp"), Handoff.VIEW, listOf("psp"), "org.ppsspp.ppsspp.PpssppActivity", store = "org.ppsspp.ppsspp"),
    Emulator("dolphin", "Dolphin", listOf("org.dolphinemu.dolphinemu", "org.dolphinemu.mmjr"), Handoff.EXTRA, listOf("gamecube", "wii"), "org.dolphinemu.dolphinemu.ui.main.MainActivity", "AutoStartFile"),
    Emulator("melonds", "melonDS", listOf("me.magnum.melonds"), Handoff.EXTRA, listOf("nds"), "me.magnum.melonds.ui.emulator.EmulatorActivity", "uri"),
    Emulator("flycast", "Flycast", listOf("com.flycast.emulator"), Handoff.VIEW, listOf("dreamcast")),
    Emulator("redream", "Redream", listOf("io.recompiled.redream"), Handoff.VIEW, listOf("dreamcast")),
    Emulator("mupen64plus", "Mupen64Plus FZ", listOf("org.mupen64plusae.v3.fzurita"), Handoff.VIEW, listOf("n64")),
    Emulator("retroarch", "RetroArch", listOf("com.retroarch.aarch64", "com.retroarch", "com.retroarch.ra32"), Handoff.RETROARCH, RETROARCH_CORES.keys.toList(), "com.retroarch.browser.retroactivity.RetroActivityFuture"),
)

/** The best order for each platform: standalone emulators first where they play better. */
private val PREFERRED = mapOf(
    "ps1" to listOf("duckstation", "retroarch"),
    "ps2" to listOf("aethersx2", "retroarch"),
    "psp" to listOf("ppsspp", "retroarch"),
    "gamecube" to listOf("dolphin", "retroarch"),
    "wii" to listOf("dolphin", "retroarch"),
    "nds" to listOf("melonds", "retroarch"),
    "dreamcast" to listOf("flycast", "redream", "retroarch"),
    "n64" to listOf("retroarch", "mupen64plus"),
)

class Emulators(private val context: Context, private val prefs: Prefs) {
    private val pm: PackageManager = context.packageManager

    /** The emulator's package that's on this device, if any. */
    fun installedPackage(e: Emulator): String? = e.packages.firstOrNull { isInstalled(it) }

    fun isInstalled(pkg: String): Boolean = runCatching { pm.getPackageInfo(pkg, 0); true }.getOrDefault(false)

    fun optionsFor(platform: String): List<Emulator> {
        val order = PREFERRED[platform] ?: listOf("retroarch")
        return order.mapNotNull { id -> EMULATORS.firstOrNull { it.id == id } }.filter { platform in it.platforms }
    }

    /** What plays a platform here: the pick under Settings, else the best one installed, else Open with… ("ask"). */
    fun choiceFor(platform: String): Emulator? {
        val picked = prefs.emulatorFor(platform)
        if (picked == "ask") return null
        val options = optionsFor(platform)
        options.firstOrNull { it.id == picked && installedPackage(it) != null }?.let { return it }
        return options.firstOrNull { installedPackage(it) != null }
    }

    /** For the web page's Emulators on this handheld panel. */
    fun overview(): JSONArray = JSONArray(PLATFORMS.map { p ->
        val choice = choiceFor(p.id)
        JSONObject()
            .put("platform", p.id)
            .put("name", p.name)
            .put("picked", prefs.emulatorFor(p.id) ?: JSONObject.NULL)
            .put("using", choice?.name ?: JSONObject.NULL)
            .put("core", if (choice?.id == "retroarch") RETROARCH_CORES[p.id] else JSONObject.NULL)
            .put("options", JSONArray(optionsFor(p.id).map { e ->
                JSONObject().put("id", e.id).put("name", e.name).put("installed", installedPackage(e) != null).put("store", e.store ?: JSONObject.NULL)
            }))
    })

    /** A content:// link to a file, readable by the app it's handed to. */
    fun uriFor(file: File) = FileProvider.getUriForFile(context, "${context.packageName}.files", file)

    /** Starts the game; returns the emulator's name, or null when Android's Open with… was shown. */
    fun launch(platformId: String, rom: File): Emulator? {
        if (!rom.exists()) throw IllegalStateException("The game's file is missing: ${rom.path}. Uninstall and install it again.")
        val emu = choiceFor(platformId)
        val intent = if (emu == null) chooser(rom) else intentFor(emu, platformId, rom)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (err: ActivityNotFoundException) {
            // The emulator moved its game screen in an update: let it open the file its own way.
            if (emu == null || emu.handoff == Handoff.RETROARCH) throw IllegalStateException("Couldn't start ${emu?.name ?: "an emulator"}: ${err.message}")
            context.startActivity(view(rom).setPackage(installedPackage(emu)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        return emu
    }

    private fun view(rom: File): Intent {
        val uri = uriFor(rom)
        return Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/octet-stream")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    }

    private fun chooser(rom: File): Intent = Intent.createChooser(view(rom), "Play ${rom.nameWithoutExtension} with")

    private fun intentFor(emu: Emulator, platformId: String, rom: File): Intent {
        val pkg = installedPackage(emu)!!
        return when (emu.handoff) {
            Handoff.RETROARCH -> {
                val core = RETROARCH_CORES[platformId] ?: throw IllegalStateException("RetroArch has no core set for this system")
                val external = File(Environment.getExternalStorageDirectory(), "Android/data/$pkg/files").path
                Intent(Intent.ACTION_MAIN)
                    .setComponent(ComponentName(pkg, emu.activity!!))
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK)
                    .putExtra("ROM", rom.path)
                    .putExtra("LIBRETRO", "/data/data/$pkg/cores/${core}_libretro_android.so")
                    .putExtra("CONFIGFILE", "$external/retroarch.cfg")
                    .putExtra("IME", Settings.Secure.getString(context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD))
                    .putExtra("DATADIR", "/data/data/$pkg")
                    .putExtra("APK", runCatching { pm.getApplicationInfo(pkg, 0).sourceDir }.getOrDefault(""))
                    .putExtra("SDCARD", Environment.getExternalStorageDirectory().path)
                    .putExtra("EXTERNAL", external)
            }
            Handoff.EXTRA -> {
                val uri = uriFor(rom)
                Intent(Intent.ACTION_MAIN)
                    .setComponent(ComponentName(pkg, emu.activity!!))
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    .putExtra(emu.extra!!, uri.toString())
                    .apply { clipData = ClipData.newRawUri(rom.name, uri) }
            }
            Handoff.VIEW -> view(rom).apply {
                if (emu.activity != null) setComponent(ComponentName(pkg, emu.activity)) else setPackage(pkg)
            }
        }
    }

    /** Moonlight (or a fork of it), for streaming PC games from a PC with Sunshine. */
    fun moonlightPackage(): String? = MOONLIGHT.firstOrNull { isInstalled(it) }

    companion object {
        val MOONLIGHT = listOf("com.limelight", "com.limelight.root", "com.limelight.unofficial", "com.alkaidlab.sdream")
    }
}
