package com.igng.tokenmonitor.android.widget

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json

/**
 * App-private JSON document shared by the refresh worker and every widget host
 * process (the launcher renders RemoteViews, but the RemoteViews themselves are
 * built in our process).
 *
 * Reads are cached: a widget update asks for the snapshot once per widget, and a
 * launcher can ask for several widgets in the same frame. Writes are atomic
 * (same-directory temp + replace) so a killed process cannot leave half a JSON
 * document behind and make every widget disappear.
 */
@Singleton
class WidgetSnapshotStore @Inject constructor(
  @ApplicationContext context: Context,
  private val json: Json
) {
  private val file = File(context.filesDir, WidgetSnapshot.FILE_NAME)
  private val lock = Any()
  private var loaded = false
  private var cached: WidgetSnapshot? = null

  fun read(): WidgetSnapshot? = synchronized(lock) {
    if (!loaded) {
      cached = runCatching {
        if (file.exists()) json.decodeFromString(WidgetSnapshot.serializer(), file.readText()) else null
      }.getOrNull()
      loaded = true
    }
    cached
  }

  suspend fun write(snapshot: WidgetSnapshot) = withContext(Dispatchers.IO) {
    val encoded = json.encodeToString(WidgetSnapshot.serializer(), snapshot)
    val temp = File(file.parentFile, "${file.name}.tmp")
    try {
      temp.writeText(encoded)
      runCatching {
        Files.move(
          temp.toPath(),
          file.toPath(),
          StandardCopyOption.REPLACE_EXISTING,
          StandardCopyOption.ATOMIC_MOVE
        )
      }.getOrElse {
        // Internal storage supports ATOMIC_MOVE on every device we target, but a
        // provider-hosted or migrated data dir may not. The copy is still safer
        // than truncating the live document in place.
        temp.copyTo(file, overwrite = true)
      }
      synchronized(lock) {
        cached = snapshot
        loaded = true
      }
    } finally {
      if (temp.exists()) temp.delete()
    }
    Unit
  }

  fun clear() = synchronized(lock) {
    runCatching { file.delete() }
    runCatching { File(file.parentFile, "${file.name}.tmp").delete() }
    cached = null
    loaded = true
  }
}
