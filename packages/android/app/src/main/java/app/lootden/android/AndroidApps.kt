package app.lootden.android

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.util.Base64
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Android games and apps: the ones already on this device (the On this handheld page, and the
 * library's store games as "Android"), and Android games from the LootDen server (APKs in
 * Emulation/android), which install through Android's own package installer.
 */
class AndroidApps(private val app: AppCore) {
    private val context = app.context
    private val pm: PackageManager = context.packageManager
    private val sp = context.getSharedPreferences("lootden.apps", Context.MODE_PRIVATE)
    /** Icons as data: URLs, by package and the time it was last updated. */
    private val icons = ConcurrentHashMap<String, String>()
    private val waiting = ConcurrentHashMap<Int, Pending>()

    private class Pending(val latch: CountDownLatch = CountDownLatch(1)) {
        @Volatile var status = PackageInstaller.STATUS_FAILURE
        @Volatile var message: String? = null
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            val id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
            val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                // Android asks the player to confirm the install (or to allow LootDen to install apps).
                @Suppress("DEPRECATION")
                val confirm = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT))
                // From LootDen's own screen when it's open: Android may not let a background app start one.
                confirm?.let { c ->
                    app.ui {
                        runCatching { app.activity?.startActivity(c) ?: ctx.startActivity(c.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                            .onFailure { app.notice("Open LootDen to finish installing", "Android needs you to confirm the install.") }
                    }
                }
                return
            }
            val p = waiting.remove(id) ?: return
            p.status = status
            p.message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
            p.latch.countDown()
        }
    }

    init {
        ContextCompat.registerReceiver(context, receiver, IntentFilter(ACTION_INSTALLED), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    // ---- Apps on this device ----------------------------------------------------------------

    /** Every app with a home screen (or Android TV) icon, except LootDen itself. */
    @SuppressLint("QueryPermissionsNeeded")
    private fun launchable(): List<ApplicationInfo> {
        val seen = LinkedHashMap<String, ApplicationInfo>()
        for (category in listOf(Intent.CATEGORY_LAUNCHER, Intent.CATEGORY_LEANBACK_LAUNCHER)) {
            val found = runCatching { pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(category), 0) }.getOrDefault(emptyList())
            for (r in found) {
                val info = r.activityInfo?.applicationInfo ?: continue
                if (info.packageName != context.packageName) seen.putIfAbsent(info.packageName, info)
            }
        }
        return seen.values.toList()
    }

    /** What Android says: the app is in the Games category, or marked as a game. */
    @Suppress("DEPRECATION")
    private fun detectedGame(info: ApplicationInfo): Boolean =
        info.category == ApplicationInfo.CATEGORY_GAME || (info.flags and ApplicationInfo.FLAG_IS_GAME) != 0

    /** The player's own choice wins over Android's: some games don't say they're games. */
    private fun isGame(info: ApplicationInfo): Boolean = when (sp.getString("kind.${info.packageName}", null)) {
        "game" -> true
        "app" -> false
        else -> detectedGame(info)
    }

    private fun iconFor(info: ApplicationInfo, updated: Long): String? {
        val key = "${info.packageName}@$updated"
        icons[key]?.let { return it }
        return runCatching {
            val d = pm.getApplicationIcon(info)
            val size = 128
            val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            d.setBounds(0, 0, size, size)
            d.draw(Canvas(bmp))
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
            bmp.recycle()
            "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }.getOrNull()?.also { icons[key] = it }
    }

    /** The LootDen library games this device installed from APKs, by package. */
    private fun fromLootDen(): Map<String, JSONObject> =
        app.library.all().filter { it.optString("platform") == PLATFORM && it.optString("package").isNotEmpty() }.associateBy { it.getString("package") }

    /** For the On this handheld page: games first, then apps, each by name. */
    fun list(): JSONArray {
        val ours = fromLootDen()
        val rows = launchable().map { info ->
            val pkgInfo = runCatching { pm.getPackageInfo(info.packageName, 0) }.getOrNull()
            val updated = pkgInfo?.lastUpdateTime ?: 0L
            JSONObject()
                .put("package", info.packageName)
                .put("label", pm.getApplicationLabel(info).toString())
                .put("game", isGame(info))
                .put("detectedGame", detectedGame(info))
                .put("system", (info.flags and ApplicationInfo.FLAG_SYSTEM) != 0 && (info.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0)
                .put("version", pkgInfo?.versionName ?: JSONObject.NULL)
                .put("installedAt", pkgInfo?.firstInstallTime?.let { Iso.format(it) } ?: JSONObject.NULL)
                .put("updatedAt", if (updated > 0) Iso.format(updated) else JSONObject.NULL)
                .put("sizeBytes", runCatching { File(info.sourceDir).length() + (info.splitSourceDirs?.sumOf { File(it).length() } ?: 0L) }.getOrDefault(0L))
                .put("gameId", ours[info.packageName]?.optString("gameId") ?: JSONObject.NULL)
                .put("icon", iconFor(info, updated) ?: JSONObject.NULL)
        }
        return JSONArray(rows.sortedWith(compareBy<JSONObject>({ !it.getBoolean("game") }, { it.getString("label").lowercase() })))
    }

    /** Moves an app to Games or Apps, or back to what Android says (null). */
    fun setKind(pkg: String, kind: String?): JSONArray {
        sp.edit().apply { if (kind == "game" || kind == "app") putString("kind.$pkg", kind) else remove("kind.$pkg") }.apply()
        return list()
    }

    /** The library's store games: this device's Android games, shown as the "Android" store. */
    fun storeGames(): JSONArray = JSONArray(launchable().filter { isGame(it) }.filter { it.packageName !in fromLootDen() }.map { info ->
        JSONObject()
            .put("addon", PLATFORM)
            .put("externalId", info.packageName)
            .put("title", pm.getApplicationLabel(info).toString())
            .put("installDir", info.sourceDir?.let { File(it).parent } ?: "")
            .put("launchUrl", "$SCHEME${info.packageName}")
            .put("store", "Android")
    })

    /** Opens an app; android-app://<package> links from store game cards come here too. */
    fun launch(pkgOrUrl: String) {
        val pkg = pkgOrUrl.removePrefix(SCHEME).substringBefore('/').trim()
        if (pkg.isEmpty()) throw IllegalArgumentException("Which app?")
        val intent = pm.getLaunchIntentForPackage(pkg) ?: pm.getLeanbackLaunchIntentForPackage(pkg)
            ?: throw IllegalStateException("That app isn't installed on this handheld any more")
        app.ui { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    /** Android's own page for the app (storage, permissions, uninstall). */
    fun openSettings(pkg: String) = app.ui {
        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Asks Android to uninstall the app (the player confirms). */
    fun uninstallPackage(pkg: String) = app.ui {
        @Suppress("DEPRECATION")
        context.startActivity(Intent(Intent.ACTION_UNINSTALL_PACKAGE, Uri.parse("package:$pkg")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Android games LootDen installed that were uninstalled outside LootDen: no longer installed here. */
    fun forgetRemoved() {
        for (g in app.library.all()) {
            val pkg = g.optString("package")
            if (g.optString("platform") != PLATFORM || pkg.isEmpty() || isInstalled(pkg)) continue
            val gameId = g.optString("gameId")
            app.library.remove(gameId)
            File(g.optString("dir")).takeIf { it.isDirectory && it.parentFile?.name == PLATFORM }?.deleteRecursively()
            runCatching { app.server.activity(gameId, app.prefs.deviceName, "uninstalled") }
        }
    }

    fun isInstalled(pkg: String): Boolean = runCatching { pm.getPackageInfo(pkg, 0); true }.getOrDefault(false)

    // ---- Android games from the server ---------------------------------------------------------

    /**
     * The game's files are downloaded into its folder: unpacks .xapk and .apks bundles, puts .obb
     * data where the game looks for it, installs the APKs (split APKs together) through Android's
     * package installer and waits for the player to confirm. Returns the library record.
     */
    fun finishInstall(gameId: String, game: JSONObject, gameDir: File): JSONObject {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !pm.canRequestPackageInstalls()) {
            app.ui {
                context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            throw IllegalStateException("Allow LootDen to install apps (\"Install unknown apps\"), then press Install again. The download is kept.")
        }
        // XAPK and APKS bundles are zips of the APKs (and the XAPK's Android/obb data).
        for (bundle in gameDir.walkTopDown().filter { it.isFile && it.extension.lowercase() in BUNDLES }.toList()) {
            app.emit(JSONObject().put("gameId", gameId).put("type", "extract").put("archive", bundle.name))
            val into = File(bundle.parentFile, bundle.nameWithoutExtension)
            into.mkdirs()
            Installer.unzip(bundle, into)
            bundle.delete()
        }
        val apks = gameDir.walkTopDown().filter { it.isFile && it.extension.equals("apk", true) }.toList()
        if (apks.isEmpty()) throw IOException("The download has no .apk in it")
        // Every part of a split APK names the same package; a folder of several different apps isn't one game.
        val parsed = apks.mapNotNull { f -> pm.getPackageArchiveInfo(f.path, 0)?.let { f to it } }
        if (parsed.isEmpty()) throw IOException("Android can't read ${apks.first().name}. Is it a complete APK?")
        val packages = parsed.map { it.second.packageName }.distinct()
        if (packages.size > 1) throw IOException("The folder has APKs for different apps (${packages.joinToString()}). Put one game per folder.")
        val pkg = packages.single()
        val base = parsed.firstOrNull { it.first.name.equals("base.apk", true) }?.first
            ?: parsed.filterNot { it.first.name.startsWith("split_") || it.first.name.startsWith("config.") }.maxByOrNull { it.first.length() }?.first
            ?: parsed.maxBy { it.first.length() }.first

        copyObbs(gameId, gameDir, pkg)

        app.emit(JSONObject().put("gameId", gameId).put("type", "prepare").put("message", "Installing on this handheld: confirm in Android's installer"))
        install(pkg, apks)

        return JSONObject()
            .put("gameId", gameId)
            .put("title", game.optString("title", gameId))
            .put("dir", gameDir.path)
            .put("installedAt", Iso.now())
            .put("platform", PLATFORM)
            .put("needsSetup", JSONObject.NULL)
            .put("version", game.opt("version") ?: JSONObject.NULL)
            .put("rom", base.path)
            .put("package", pkg)
    }

    /** .obb files go to Android/obb/<package>, where the game reads its data from. */
    private fun copyObbs(gameId: String, gameDir: File, pkg: String) {
        val obbs = gameDir.walkTopDown().filter { it.isFile && it.extension.equals("obb", true) }.toList()
        if (obbs.isEmpty()) return
        val dest = File(Environment.getExternalStorageDirectory(), "Android/obb/$pkg")
        try {
            dest.mkdirs()
            for (f in obbs) {
                val to = File(dest, f.name)
                if (to.isFile && to.length() == f.length()) continue
                f.copyTo(to, overwrite = true)
            }
        } catch (err: Exception) {
            app.emit(JSONObject().put("gameId", gameId).put("type", "warning").put("message", "Couldn't copy the game's data to $dest (${err.message}). Copy the .obb files there with a file manager."))
        }
    }

    private fun install(pkg: String, apks: List<File>) {
        val installer = pm.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(pkg) }
        val id = installer.createSession(params)
        val pending = Pending()
        waiting[id] = pending
        try {
            installer.openSession(id).use { session ->
                for (f in apks) {
                    f.inputStream().use { input ->
                        session.openWrite(f.name, 0, f.length()).use { out ->
                            input.copyTo(out, 256 * 1024)
                            session.fsync(out)
                        }
                    }
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                val intent = PendingIntent.getBroadcast(context, id, Intent(ACTION_INSTALLED).setPackage(context.packageName), flags)
                session.commit(intent.intentSender)
            }
        } catch (err: Exception) {
            waiting.remove(id)
            runCatching { installer.abandonSession(id) }
            throw IOException("Couldn't hand the game to Android's installer: ${err.message}")
        }
        if (!pending.latch.await(15, TimeUnit.MINUTES)) {
            waiting.remove(id)
            throw IOException("Android's installer didn't answer. Press Install again.")
        }
        when (pending.status) {
            PackageInstaller.STATUS_SUCCESS -> return
            PackageInstaller.STATUS_FAILURE_ABORTED -> throw Cancelled()
            PackageInstaller.STATUS_FAILURE_CONFLICT -> throw IOException("A different copy of this game is already installed (signed by someone else). Uninstall it first.")
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> throw IOException("This game doesn't run on this handheld: ${pending.message ?: "it's built for another kind of device"}")
            PackageInstaller.STATUS_FAILURE_STORAGE -> throw IOException("Not enough space to install it")
            else -> throw IOException("Android couldn't install it: ${pending.message ?: "unknown error"}")
        }
    }

    companion object {
        const val PLATFORM = "android"
        /** Links that open an app on this device, from store game cards. */
        const val SCHEME = "android-app://"
        /** The Android platform as the installer sees it (no emulator: the files are APKs). */
        val APK_PLATFORM = Platform(PLATFORM, "Android", listOf("apk", "xapk", "apks"))
        private val BUNDLES = setOf("xapk", "apks")
        private const val ACTION_INSTALLED = "app.lootden.android.APK_INSTALLED"
    }
}
