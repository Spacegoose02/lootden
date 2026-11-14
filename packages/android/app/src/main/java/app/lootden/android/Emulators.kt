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
 * Xbox and Xbox 360 aren't here: nothing plays them on an Android handheld yet. PS3 plays in ARMSX3.
 */
data class Platform(val id: String, val name: String, val extensions: List<String>)

val PLATFORMS = listOf(
    Platform("ps1", "PlayStation", listOf("m3u", "cue", "chd", "pbp", "iso", "bin", "img", "ecm")),
    Platform("ps2", "PlayStation 2", listOf("chd", "iso", "cso", "zso", "cue", "bin", "gz")),
    Platform("ps3", "PlayStation 3", listOf("bin", "iso", "pkg")),
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

/**
 * The file an emulator should open: playlists and cue sheets before their tracks, then the platform's types in order (pickRomFile).
 * PS3 folder games open through their EBOOT.BIN.
 */
fun pickRom(files: List<String>, platform: Platform): String? {
    if (platform.id == "ps3") {
        files.firstOrNull { PS3_EBOOT.containsMatchIn(it.lowercase()) }?.let { return it }
    }
    for (ext in platform.extensions) {
        val hits = files.filter { it.lowercase().endsWith(".$ext") }
        if (hits.isNotEmpty()) return hits.sortedWith(compareBy<String>({ it.count { c -> c == '/' } }, { it })).first()
    }
    return null
}

/** A PS3 folder game's start file, as pickRomFile in packages/shared finds it. */
private val PS3_EBOOT = Regex("(^|/)ps3_game/usrdir/eboot\\.bin$")

/** How a game is handed to an emulator. */
enum class Handoff {
    /** RetroArch's own launch extras with a file path and a core. */
    RETROARCH,
    /** A content:// link in an extra, to a named activity. */
    EXTRA,
    /** ACTION_VIEW with a content:// link, to the app's own handler. */
    VIEW,
    /**
     * ARMSX3 (PS3): a disc image goes as a content:// link like VIEW, but a folder game goes by its
     * EBOOT.BIN's path, since the emulator boots the whole folder and a link to one file can't
     * reach the rest of it. A PKG goes to ARMSX3's package installer first, then starts by title id.
     */
    ARMSX3,
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
    /** Other names the game screen has had in other builds of the app, tried after [activity]. */
    val otherActivities: List<String> = emptyList(),
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
    // ARMSX2 (PCSX2 for ARM): Google Play's build is come.nanodata.armsx2, GitHub's com.armsx2. Its game
    // screen opens a disc from ACTION_VIEW on MainActivity, which older builds kept in kr.co.iefriends.pcsx2.
    Emulator(
        "armsx2", "ARMSX2", listOf("come.nanodata.armsx2", "com.armsx2", "com.armsx2.debug"), Handoff.VIEW, listOf("ps2"), "com.armsx2.MainActivity",
        otherActivities = listOf("kr.co.iefriends.pcsx2.MainActivity"),
    ),
    Emulator("aethersx2", "NetherSX2 / AetherSX2", listOf("xyz.aethersx2.android"), Handoff.EXTRA, listOf("ps2"), "xyz.aethersx2.android.EmulationActivity", "bootPath", store = null),
    // ARMSX3 (RPCS3 for ARM): GitHub's build is com.armsx3, Google Play's com.armsx3.play. Both take
    // a game from ACTION_VIEW or a "path"/"title_id" extra on Main (MainActivity is its alias).
    Emulator(
        "armsx3", "ARMSX3", listOf("com.armsx3", "com.armsx3.play"), Handoff.ARMSX3, listOf("ps3"), "com.armsx2.Main",
        store = "com.armsx3.play", otherActivities = listOf("com.armsx2.MainActivity"),
    ),
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
    "ps2" to listOf("armsx2", "aethersx2", "retroarch"),
    "ps3" to listOf("armsx3"),
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

    /** The installed version's name ("2.7.5"), for the Emulators on this handheld panel. */
    private fun versionOf(pkg: String): String? = runCatching { pm.getPackageInfo(pkg, 0).versionName }.getOrNull()

    /** The game screen this build of the emulator has: the first of its known names that exists. */
    private fun activityIn(e: Emulator, pkg: String): String? {
        val names = listOfNotNull(e.activity) + e.otherActivities
        return names.firstOrNull { runCatching { pm.getActivityInfo(ComponentName(pkg, it), 0); true }.getOrDefault(false) } ?: e.activity
    }

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
                val pkg = installedPackage(e)
                JSONObject().put("id", e.id).put("name", e.name).put("installed", pkg != null).put("store", e.store ?: JSONObject.NULL)
                    .put("package", pkg ?: JSONObject.NULL)
                    .put("version", pkg?.let { versionOf(it) } ?: JSONObject.NULL)
            }))
    })

    /** A content:// link to a file, readable by the app it's handed to. */
    fun uriFor(file: File) = FileProvider.getUriForFile(context, "${context.packageName}.files", file)

    /**
     * Starts the game; returns the emulator's name, or null when Android's Open with… was shown.
     * [gameDir] is the game's install folder, where its PS3 licences are.
     */
    fun launch(platformId: String, rom: File, gameDir: File? = null): Emulator? {
        if (!rom.exists()) throw IllegalStateException("The game's file is missing: ${rom.path}. Uninstall and install it again.")
        val emu = choiceFor(platformId)
        val intent = if (emu == null) chooser(rom) else intentFor(emu, platformId, rom, gameDir)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (err: ActivityNotFoundException) {
            // An ARMSX3 from before it took packages from other apps: try again once it's updated.
            if (intent.action == ARMSX3_INSTALL) {
                prefs.setPs3PackageSent(rom.path, false)
                prefs.setPs3LicencesSent(licencesOf(rom, gameDir).map(Ps3Licences::key), false)
                throw IllegalStateException("This ARMSX3 can't install PS3 packages from LootDen. Update ARMSX3, or install ${rom.name} from ARMSX3's own menu.")
            }
            // The emulator moved its game screen in an update: let it open the file its own way.
            if (emu == null || emu.handoff == Handoff.RETROARCH) throw IllegalStateException("Couldn't start ${emu?.name ?: "an emulator"}: ${err.message}")
            try {
                context.startActivity(view(rom).setPackage(installedPackage(emu)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (again: ActivityNotFoundException) {
                throw IllegalStateException("${emu.name} wouldn't open the game. Update ${emu.name}, or pick another emulator under Profile, This handheld.")
            }
        }
        return emu
    }

    private fun view(rom: File): Intent {
        val uri = uriFor(rom)
        return Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/octet-stream")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    }

    private fun chooser(rom: File): Intent = Intent.createChooser(view(rom), "Play ${rom.nameWithoutExtension} with")

    private fun intentFor(emu: Emulator, platformId: String, rom: File, gameDir: File?): Intent {
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
                    .setComponent(ComponentName(pkg, activityIn(emu, pkg)!!))
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    .putExtra(emu.extra!!, uri.toString())
                    .apply { clipData = ClipData.newRawUri(rom.name, uri) }
            }
            Handoff.ARMSX3 -> armsx3(emu, pkg, rom, gameDir)
            Handoff.VIEW -> view(rom).apply {
                val activity = activityIn(emu, pkg)
                // A named game screen starts fresh, so a game already open there doesn't keep running instead.
                if (activity != null) setComponent(ComponentName(pkg, activity)).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP) else setPackage(pkg)
            }
        }
    }

    /**
     * How ARMSX3 gets a PS3 game. Its game screen is singleTop and takes a new game in onNewIntent,
     * so it isn't started fresh: tearing it down ends its whole process, the new game's too.
     */
    private fun armsx3(emu: Emulator, pkg: String, rom: File, gameDir: File?): Intent {
        val screen = ComponentName(pkg, activityIn(emu, pkg)!!)
        val flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        val name = rom.name.lowercase()
        val licences = licencesOf(rom, gameDir)
        if (name.endsWith(".pkg")) {
            val titleId = Ps3Pkg.titleId(rom)
            // The first time, the package (with its updates, DLC and licences beside it) goes to
            // ARMSX3's installer, which asks the player first. After that it starts by its title id.
            if (titleId == null || !prefs.ps3PackageSent(rom.path)) {
                prefs.setPs3PackageSent(rom.path, true)
                prefs.setPs3LicencesSent(licences.map(Ps3Licences::key), true)
                return armsx3Install(pkg, rom, licences)
            }
        }
        // A licence that hasn't been to ARMSX3 yet (one the admin added since, or a disc or folder
        // game's): its installer copies it into exdata, after the player says yes. Play again after.
        val pending = licences.filter { !prefs.ps3LicenceSent(Ps3Licences.key(it)) }
        if (pending.isNotEmpty()) {
            prefs.setPs3LicencesSent(pending.map(Ps3Licences::key), true)
            return armsx3InstallFiles(pkg, pending)
        }
        if (name.endsWith(".pkg")) {
            return Intent(Intent.ACTION_MAIN).setComponent(screen).addFlags(flags).putExtra("title_id", Ps3Pkg.titleId(rom)!!)
        }
        // A folder game: ARMSX3 boots the folder its EBOOT.BIN is in, so it needs the path, not a
        // link to one file. A bare path in "path" (not a file:// link, which Android refuses to hand
        // to another app) is read with ARMSX3's All files access.
        if (name == "eboot.bin") return Intent(Intent.ACTION_MAIN).setComponent(screen).addFlags(flags).putExtra("path", rom.path)
        // A disc image: a content:// link, which ARMSX3 opens itself, so it works without All files access too.
        return view(rom).setComponent(screen).addFlags(flags)
    }

    /** The game's .rap licences: the ones the server sent into its folder and any that came with it. */
    private fun licencesOf(rom: File, gameDir: File?): List<File> =
        Ps3Licences.inFolder(gameDir ?: rom.parentFile ?: return emptyList())

    /** ARMSX3's package installer (its com.armsx3.action.INSTALL): the PKGs first, then .rap and .edat licences. */
    private fun armsx3Install(pkg: String, rom: File, extraLicences: List<File>): Intent {
        val dir = rom.parentFile ?: throw IllegalStateException("The game's folder is missing")
        val all = dir.walkTopDown().filter { it.isFile }.toList()
        val packages = listOf(rom) + all.filter { it != rom && it.name.lowercase().endsWith(".pkg") }.sortedBy { it.path.lowercase() }
        val licences = (all.filter { f -> listOf(".rap", ".edat").any { f.name.lowercase().endsWith(it) } } + extraLicences)
            .distinctBy { it.canonicalPath }.sortedBy { it.path.lowercase() }
        return armsx3InstallFiles(pkg, packages + licences)
    }

    /** Hands files to ARMSX3's installer, which asks the player first. Licences alone are fine: it copies them into exdata. */
    private fun armsx3InstallFiles(pkg: String, files: List<File>): Intent {
        val uris = files.map { uriFor(it) }
        return Intent(ARMSX3_INSTALL)
            .setComponent(ComponentName(pkg, "com.armsx2.packages.ExternalInstallActivity"))
            .setDataAndType(uris.first(), "application/octet-stream")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .apply {
                clipData = ClipData.newRawUri(files.first().name, uris.first()).also { clip -> uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) } }
            }
    }

    /** Moonlight (or a fork of it), for streaming PC games from a PC with Sunshine. */
    fun moonlightPackage(): String? = MOONLIGHT.firstOrNull { isInstalled(it) }

    companion object {
        const val ARMSX3_INSTALL = "com.armsx3.action.INSTALL"
        val MOONLIGHT = listOf("com.limelight", "com.limelight.root", "com.limelight.unofficial", "com.alkaidlab.sdream")
    }
}

/** PS3 packages: the title id in a PKG's header, the one name ARMSX3 can start an installed package game by. */
object Ps3Pkg {
    private const val CONTENT_ID_AT = 0x30
    private const val CONTENT_ID_LENGTH = 36

    /** "BLUS30001" from a PKG whose content id is "UP0001-BLUS30001_00-…", or null for anything else. */
    fun titleId(file: File): String? = runCatching {
        file.inputStream().use { input ->
            val head = ByteArray(CONTENT_ID_AT + CONTENT_ID_LENGTH)
            var n = 0
            while (n < head.size) {
                val r = input.read(head, n, head.size - n)
                if (r <= 0) break
                n += r
            }
            if (n < head.size) return null
            titleIdIn(head)
        }
    }.getOrNull()

    fun titleIdIn(head: ByteArray): String? {
        if (head.size < CONTENT_ID_AT + CONTENT_ID_LENGTH) return null
        if (head[0] != 0x7f.toByte() || head[1] != 'P'.code.toByte() || head[2] != 'K'.code.toByte() || head[3] != 'G'.code.toByte()) return null
        val contentId = String(head, CONTENT_ID_AT, CONTENT_ID_LENGTH, Charsets.US_ASCII)
        return Regex("^[A-Z]{2}[0-9]{4}-([A-Z]{4}[0-9]{5})_").find(contentId)?.groupValues?.get(1)
    }
}
