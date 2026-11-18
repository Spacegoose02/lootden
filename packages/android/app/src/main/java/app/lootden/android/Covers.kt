package app.lootden.android

import android.content.Context
import android.util.Base64
import java.io.File

/**
 * A copy of each installed game's cover, refreshed weekly while the server answers, so the
 * offline library has artwork (packages/desktop/src/main.ts keeps its own the same way).
 */
class Covers(context: Context, private val server: Server) {
    private val dir = File(context.filesDir, "covers")

    private fun safe(gameId: String) = gameId.replace(Regex("[^\\w.-]"), "_").take(120)

    private fun fileFor(gameId: String): File? = dir.listFiles()?.firstOrNull { it.name.substringBeforeLast('.') == safe(gameId) }

    /** Fetches the covers that are missing or older than a week. Never throws. */
    fun refresh(gameIds: List<String>) {
        dir.mkdirs()
        for (id in gameIds) {
            val have = fileFor(id)
            if (have != null && System.currentTimeMillis() - have.lastModified() < WEEK) continue
            runCatching {
                val c = server.open("/api/games/${Server.enc(id)}/cover")
                try {
                    val ext = c.contentType?.substringBefore(';')?.trim()?.lowercase()?.let { TYPES[it] }
                    if (c.responseCode !in 200..299 || ext == null) return@runCatching
                    val bytes = c.inputStream.use { it.readBytes() }
                    if (bytes.isEmpty() || bytes.size > MAX_BYTES) return@runCatching
                    have?.delete()
                    val tmp = File(dir, "${safe(id)}.tmp")
                    tmp.writeBytes(bytes)
                    tmp.renameTo(File(dir, "${safe(id)}.$ext"))
                } finally {
                    c.disconnect()
                }
            }
        }
    }

    /** The kept cover as a data: URL for the offline page, or null. */
    fun dataUrl(gameId: String): String? {
        val f = fileFor(gameId) ?: return null
        val mime = TYPES.entries.firstOrNull { it.value == f.extension }?.key ?: return null
        return runCatching { "data:$mime;base64," + Base64.encodeToString(f.readBytes(), Base64.NO_WRAP) }.getOrNull()
    }

    fun forget(gameId: String) {
        fileFor(gameId)?.delete()
    }

    companion object {
        private const val WEEK = 7 * 86_400_000L
        private const val MAX_BYTES = 4 * 1024 * 1024
        private val TYPES = mapOf("image/jpeg" to "jpg", "image/png" to "png", "image/webp" to "webp", "image/gif" to "gif")
    }
}
