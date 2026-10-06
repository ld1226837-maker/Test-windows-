package app.tauri.androidsave

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.graphics.pdf.PdfRenderer
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.FileProvider
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.io.IOException

@InvokeArg
class SaveArgs {
    lateinit var fileName: String
    lateinit var mimeType: String
    lateinit var base64: String
    /** Open the saved file in a viewer afterwards (used by Print). */
    var openAfterSave: Boolean = false
}


@InvokeArg
class StreamStartArgs { lateinit var sessionId: String; lateinit var fileName: String; lateinit var mimeType: String }
@InvokeArg
class StreamChunkArgs { lateinit var sessionId: String; lateinit var base64: String }
@InvokeArg
class StreamSessionArgs { lateinit var sessionId: String }

@InvokeArg
class PrintArgs {
    lateinit var fileName: String
    lateinit var base64: String
}

@InvokeArg
class CopyUriArgs {
    lateinit var uri: String
    lateinit var fileName: String
}

@InvokeArg
class DeletePrivateFileArgs {
    lateinit var path: String
}

@InvokeArg
class SecureSetArgs {
    lateinit var key: String
    lateinit var value: String
}

@InvokeArg
class SecureKeyArgs {
    lateinit var key: String
}

@TauriPlugin
class AndroidSavePlugin(private val activity: Activity) : Plugin(activity) {

    /**
     * Writes the bytes into the device's public Downloads folder.
     *
     * API 29+ : MediaStore.Downloads insert + OutputStream (no permission needed,
     *           and unlike direct filesystem writes it is not silently blocked,
     *           which is what left 0-byte files behind).
     * API 24-28: legacy direct write to the public Downloads directory.
     */
    /** Removes MediaStore exports left pending by a process death. Only rows owned by this package are touched. */
    @Command
    fun cleanupPendingExports(invoke: Invoke) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val resolver = activity.contentResolver
                val uri = MediaStore.Downloads.EXTERNAL_CONTENT_URI
                val projection = arrayOf(MediaStore.MediaColumns._ID)
                val selection = "${MediaStore.MediaColumns.IS_PENDING}=1 AND ${MediaStore.MediaColumns.OWNER_PACKAGE_NAME}=?"
                resolver.query(uri, projection, selection, arrayOf(activity.packageName), null)?.use { c ->
                    val id = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                    while (c.moveToNext()) {
                        val item = Uri.withAppendedPath(uri, c.getLong(id).toString())
                        resolver.delete(item, null, null)
                    }
                }
            }
            invoke.resolve()
        } catch (e: Exception) {
            // Cleanup is best-effort; never prevent the app from starting.
            invoke.resolve()
        }
    }

    @Command
    fun openPrivateFile(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SaveArgs::class.java)
            val bytes = Base64.decode(args.base64, Base64.DEFAULT)
            if (bytes.isEmpty()) {
                invoke.reject("refusing to open an empty file")
                return
            }
            val dir = File(activity.cacheDir, "receipt-view").apply { mkdirs() }
            val safeName = args.fileName.replace(Regex("[^A-Za-z0-9._-]"), "_")
            val target = File(dir, "${System.currentTimeMillis()}-$safeName")
            target.outputStream().use { it.write(bytes) }
            val authority = "${activity.packageName}.fileprovider"
            val uri = FileProvider.getUriForFile(activity, authority, target)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, args.mimeType)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            Handler(Looper.getMainLooper()).postDelayed({
                try { target.delete() } catch (ignored: Exception) {}
            }, 60_000L)
            val result = JSObject()
            result.put("uri", uri.toString())
            result.put("bytesWritten", bytes.size.toLong())
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun saveToDownloads(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SaveArgs::class.java)
            val bytes = Base64.decode(args.base64, Base64.DEFAULT)
            if (bytes.isEmpty()) {
                invoke.reject("refusing to save an empty file")
                return
            }

            val uriString: String
            var written = 0L

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val resolver = activity.contentResolver
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, args.fileName)
                    put(MediaStore.MediaColumns.MIME_TYPE, args.mimeType)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: run {
                        invoke.reject("MediaStore refused to create the file")
                        return
                    }
                resolver.openOutputStream(uri)?.use { out ->
                    out.write(bytes)
                    out.flush()
                    written = bytes.size.toLong()
                } ?: run {
                    resolver.delete(uri, null, null)
                    invoke.reject("could not open an output stream for the new file")
                    return
                }
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                uriString = uri.toString()

                // grantPermission = true: this is a content:// MediaStore URI
                // owned by our own package, and most PDF viewers on API 29+
                // don't hold broad storage permissions of their own — without
                // FLAG_GRANT_READ_URI_PERMISSION here, ACTION_VIEW resolves to
                // an app that then fails (often silently) to read the file, so
                // "Preview" looked like it did nothing even though the save
                // itself succeeded. The legacy branch below already grants
                // permission via FileProvider for the same reason.
                if (args.openAfterSave) openUri(uri.toString(), args.mimeType, true)
            } else {
                val dir = Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOWNLOADS
                )
                if (!dir.exists()) {
                    dir.mkdirs()
                }
                val file = File(dir, args.fileName)
                file.outputStream().use { out ->
                    out.write(bytes)
                    out.flush()
                }
                written = bytes.size.toLong()
                uriString = Uri.fromFile(file).toString()

                if (args.openAfterSave) openFile(file, args.mimeType)
            }

            val result = JSObject()
            result.put("uri", uriString)
            result.put("bytesWritten", written)
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("failed to save file: ${e.message}")
        }
    }

    /**
     * Hands the already-rendered PDF to Android's own print framework, which
     * opens the system print dialog (printer picker, copies, page range,
     * "Save as PDF", plus any installed Wi-Fi/Bluetooth/cloud print service).
     *
     * The PDF is already fully rendered on the JS side (jsPDF) — this adapter
     * doesn't lay anything out itself, it just hands the fixed byte content to
     * whatever destination the user picks in `onWrite`, which is the standard
     * way to print a pre-built PDF via `PrintManager`.
     */
    private val streamUris = ConcurrentHashMap<String, Uri>()
    private val streamFiles = ConcurrentHashMap<String, File>()
    // One stream is kept open for the whole session instead of re-opening the
    // MediaStore item with "wa" for every chunk (some Android versions
    // truncate or reject append-mode reopens).
    private val streamOuts = ConcurrentHashMap<String, OutputStream>()
    private val streamBytes = ConcurrentHashMap<String, Long>()

    @Command
    fun startStreamSave(invoke: Invoke) {
        try {
            // Process death can leave a previous MediaStore export pending.
            // Cleanup is best-effort and scoped to this package, so a skipped
            // WebView startup hook can never make pending rows accumulate.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val resolver = activity.contentResolver
                val uri = MediaStore.Downloads.EXTERNAL_CONTENT_URI
                val projection = arrayOf(MediaStore.MediaColumns._ID)
                val selection = "${MediaStore.MediaColumns.IS_PENDING}=1 AND ${MediaStore.MediaColumns.OWNER_PACKAGE_NAME}=?"
                resolver.query(uri, projection, selection, arrayOf(activity.packageName), null)?.use { c ->
                    val id = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                    while (c.moveToNext()) resolver.delete(Uri.withAppendedPath(uri, c.getLong(id).toString()), null, null)
                }
            }
            val args = invoke.parseArgs(StreamStartArgs::class.java)
            if (args.sessionId.isBlank()) { invoke.reject("missing stream session id"); return }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, args.fileName)
                    put(MediaStore.MediaColumns.MIME_TYPE, args.mimeType)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: run { invoke.reject("MediaStore refused to create the file"); return }
                val out = activity.contentResolver.openOutputStream(uri, "w")
                if (out == null) {
                    activity.contentResolver.delete(uri, null, null)
                    invoke.reject("could not open MediaStore file for writing"); return
                }
                streamUris[args.sessionId] = uri
                streamOuts[args.sessionId] = out
                streamBytes[args.sessionId] = 0L
            } else {
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                if (!dir.exists()) dir.mkdirs()
                val file = File(dir, args.fileName)
                if (file.exists()) file.delete()
                streamFiles[args.sessionId] = file
                streamOuts[args.sessionId] = FileOutputStream(file, false)
                streamBytes[args.sessionId] = 0L
            }
            invoke.resolve()
        } catch (e: Exception) { invoke.reject("failed to start stream: ${e.message}") }
    }

    @Command
    fun appendStreamSave(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(StreamChunkArgs::class.java)
            val bytes = Base64.decode(args.base64, Base64.DEFAULT)
            if (bytes.isEmpty()) { invoke.resolve(); return }
            val out = streamOuts[args.sessionId] ?: run { invoke.reject("unknown stream session"); return }
            out.write(bytes)
            streamBytes[args.sessionId] = (streamBytes[args.sessionId] ?: 0L) + bytes.size
            invoke.resolve()
        } catch (e: Exception) { invoke.reject("failed to append stream: ${e.message}") }
    }

    @Command
    fun finishStreamSave(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(StreamSessionArgs::class.java)
            val uri = streamUris.remove(args.sessionId)
            val file = streamFiles.remove(args.sessionId)
            val out = streamOuts.remove(args.sessionId)
            val written = streamBytes.remove(args.sessionId) ?: 0L
            try { out?.flush() } finally { out?.close() }
            if (written <= 0L) {
                // Nothing was written: never publish an empty export.
                uri?.let { activity.contentResolver.delete(it, null, null) }
                file?.let { if (it.exists()) it.delete() }
                invoke.reject("stream finished with no data written"); return
            }
            if (uri != null) {
                val values = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
                activity.contentResolver.update(uri, values, null, null)
                val result = JSObject(); result.put("saved", true); result.put("path", uri.toString()); result.put("error", null); invoke.resolve(result)
            } else if (file != null && file.exists() && file.length() > 0) {
                val result = JSObject(); result.put("saved", true); result.put("path", Uri.fromFile(file).toString()); result.put("error", null); invoke.resolve(result)
            } else invoke.reject("unknown or empty stream session")
        } catch (e: Exception) { invoke.reject("failed to finish stream: ${e.message}") }
    }

    @Command
    fun abortStreamSave(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(StreamSessionArgs::class.java)
            try { streamOuts.remove(args.sessionId)?.close() } catch (ignored: Exception) {}
            streamBytes.remove(args.sessionId)
            streamUris.remove(args.sessionId)?.let { activity.contentResolver.delete(it, null, null) }
            streamFiles.remove(args.sessionId)?.let { if (it.exists()) it.delete() }
            invoke.resolve()
        } catch (e: Exception) { invoke.reject("failed to abort stream: ${e.message}") }
    }

    @Command
    fun printPdf(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(PrintArgs::class.java)
            val bytes = Base64.decode(args.base64, Base64.DEFAULT)
            if (bytes.isEmpty()) {
                invoke.reject("refusing to print an empty file")
                return
            }
            // Fail here, with a readable reason, rather than letting the
            // system dialog open on a blank/"preview unavailable" page: a
            // receipt that isn't a real PDF can never print.
            if (bytes.size < 5 || bytes[0] != '%'.code.toByte() || bytes[1] != 'P'.code.toByte() ||
                bytes[2] != 'D'.code.toByte() || bytes[3] != 'F'.code.toByte()
            ) {
                invoke.reject("the receipt is not a valid PDF")
                return
            }

            val printManager = activity.getSystemService(Activity.PRINT_SERVICE) as? PrintManager
            if (printManager == null) {
                invoke.reject("no printing support: PRINT_SERVICE unavailable")
                return
            }

            // Real page count. The receipt can now be several pages (the
            // attached expense/investment photo is its last page); reporting
            // PAGE_COUNT_UNKNOWN makes some print services show a blank
            // preview or ask for page ranges we then ignore.
            val pageCount = countPdfPages(bytes)

            val jobName = args.fileName.removeSuffix(".pdf").ifBlank { "Receipt" }

            // PrintManager.print() creates a Handler bound to the *calling*
            // thread's Looper and shows the print dialog, so it must run on
            // the UI thread. Tauri dispatches plugin commands on the WebView
            // bridge thread, which has no Looper prepared — calling print()
            // straight from here throws ("Can't create handler inside thread
            // ... that has not called Looper.prepare()"), the catch below
            // rejects, and the app falls back to save-and-open, so the print
            // dialog never appears. Hopping to the UI thread is what actually
            // makes the printer picker open.
            activity.runOnUiThread {
                try {
                    // The receipt PDF carries its own page size (a thermal
                    // roll is e.g. 80 mm wide); ask for no extra minimum
                    // margins so the print service doesn't shrink it further.
                    val attributes = PrintAttributes.Builder()
                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                        .build()
                    printManager.print(jobName, PdfPrintAdapter(jobName, bytes, pageCount), attributes)

                    // `print()` only opens the system dialog — it doesn't block
                    // until the user finishes picking a printer/copies, so
                    // "resolved" here means "the dialog was shown", matching how
                    // the TS caller reads a resolved invoke as `{ printed: true }`.
                    val result = JSObject()
                    result.put("printed", true)
                    invoke.resolve(result)
                } catch (e: Exception) {
                    invoke.reject("failed to print file: ${e.message}")
                }
            }
        } catch (e: Exception) {
            invoke.reject("failed to print file: ${e.message}")
        }
    }

    /**
     * Page count of an in-memory PDF via the OS PdfRenderer (needs a seekable
     * file descriptor, hence the short-lived cache file). Returns
     * PAGE_COUNT_UNKNOWN if the renderer can't open it, so a quirk of the
     * renderer never blocks a print job the print service might still handle.
     */
    private fun countPdfPages(bytes: ByteArray): Int {
        val tmp = File(activity.cacheDir, "print-count-${System.nanoTime()}.pdf")
        return try {
            tmp.writeBytes(bytes)
            val fd = ParcelFileDescriptor.open(tmp, ParcelFileDescriptor.MODE_READ_ONLY)
            try {
                val renderer = PdfRenderer(fd)
                try {
                    renderer.pageCount
                } finally {
                    renderer.close()
                }
            } finally {
                fd.close()
            }
        } catch (e: Exception) {
            PrintDocumentInfo.PAGE_COUNT_UNKNOWN
        } finally {
            try { tmp.delete() } catch (ignored: Exception) {}
        }
    }

    /**
     * Serves a fixed, already-rendered PDF to whatever destination
     * `PrintManager` hands it (the physical printer, "Save as PDF", etc).
     * No layout work happens here — the byte content never changes per
     * print attributes, so `onLayout` always reports one document and
     * `onWrite` just copies the bytes to the given fd.
     *
     * `onWrite` is called on the main thread; copying a multi-megabyte PDF
     * (receipt + attached photo) there can stall the print dialog, so the
     * copy runs on a worker thread and reports back through the callback,
     * as the PrintDocumentAdapter contract allows.
     */
    private class PdfPrintAdapter(
        private val jobName: String,
        private val bytes: ByteArray,
        private val pageCount: Int,
    ) : PrintDocumentAdapter() {
        override fun onLayout(
            oldAttributes: PrintAttributes?,
            newAttributes: PrintAttributes?,
            cancellationSignal: CancellationSignal?,
            callback: LayoutResultCallback?,
            extras: Bundle?,
        ) {
            if (cancellationSignal?.isCanceled == true) {
                callback?.onLayoutCancelled()
                return
            }
            val info = PrintDocumentInfo.Builder(jobName)
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .setPageCount(pageCount)
                .build()
            // `changed` must be true on the first layout (no earlier
            // attributes) so the framework actually asks for the content;
            // afterwards the bytes never depend on the attributes.
            callback?.onLayoutFinished(info, oldAttributes != newAttributes)
        }

        override fun onWrite(
            pages: Array<out PageRange>?,
            destination: ParcelFileDescriptor?,
            cancellationSignal: CancellationSignal?,
            callback: WriteResultCallback?,
        ) {
            if (destination == null) {
                callback?.onWriteFailed("no destination for the print job")
                return
            }
            val cancelled = AtomicBoolean(false)
            cancellationSignal?.setOnCancelListener { cancelled.set(true) }
            Thread {
                try {
                    FileOutputStream(destination.fileDescriptor).use { out ->
                        var offset = 0
                        val chunk = 64 * 1024
                        while (offset < bytes.size) {
                            if (cancelled.get()) {
                                callback?.onWriteCancelled()
                                return@Thread
                            }
                            val n = minOf(chunk, bytes.size - offset)
                            out.write(bytes, offset, n)
                            offset += n
                        }
                        out.flush()
                    }
                    // The whole PDF is always written, so every page range the
                    // dialog asked for is covered.
                    callback?.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
                } catch (e: Exception) {
                    callback?.onWriteFailed(e.message ?: "could not write the print data")
                }
            }.start()
        }
    }

    @Command
    fun copyUriToPrivateFile(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CopyUriArgs::class.java)
            val source = Uri.parse(args.uri)
            val safeName = args.fileName.replace(Regex("[^A-Za-z0-9._-]"), "_")
            val dir = File(activity.filesDir, "TurfApp/imports").apply { mkdirs() }
            val target = File(dir, safeName)
            activity.contentResolver.openInputStream(source)?.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(1024 * 1024)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        if (n > 0) output.write(buffer, 0, n)
                    }
                    output.flush()
                }
            } ?: throw IllegalStateException("could not open the selected document")
            if (!target.exists() || target.length() == 0L) { target.delete(); throw IllegalStateException("selected document is empty") }
            invoke.resolve(JSObject().put("path", target.absolutePath))
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun deletePrivateFile(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(DeletePrivateFileArgs::class.java)
            val root = File(activity.filesDir, "TurfApp/imports").canonicalFile
            val target = File(args.path).canonicalFile
            if (!target.path.startsWith(root.path + File.separator)) throw IllegalArgumentException("invalid private import path")
            target.delete()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun secureSet(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecureSetArgs::class.java)
            if (!isAllowedSecureKey(args.key)) {
                invoke.reject("unknown secure store key: ${args.key}")
                return
            }
            if (!securePrefs.edit().putString(args.key, args.value).commit()) {
                invoke.reject("secure store write was not committed")
                return
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("failed to store secure value: ${e.message}")
        }
    }

    @Command
    fun secureGet(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecureKeyArgs::class.java)
            if (!isAllowedSecureKey(args.key)) {
                invoke.reject("unknown secure store key: ${args.key}")
                return
            }
            val result = JSObject()
            result.put("value", securePrefs.getString(args.key, null))
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("failed to read secure value: ${e.message}")
        }
    }

    @Command
    fun secureDelete(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecureKeyArgs::class.java)
            if (!isAllowedSecureKey(args.key)) {
                invoke.reject("unknown secure store key: ${args.key}")
                return
            }
            securePrefs.edit().remove(args.key).commit()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("failed to delete secure value: ${e.message}")
        }
    }

    /**
     * Fixed allowlist of keys the secure store will read/write, rather than
     * trusting an arbitrary caller-supplied name (see `android-secure-store.ts`).
     */
    private fun isAllowedSecureKey(key: String): Boolean =
        key == "telegram-backup-token" ||
            key == "telegram-backup-extra-tokens" ||
            key == "backup-passphrase"

    private val securePrefs: SharedPreferences by lazy { openSecurePrefs() }

    private fun createSecurePrefs(): SharedPreferences {
        val masterKey = MasterKey.Builder(activity)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            activity,
            SECURE_PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    /**
     * EncryptedSharedPreferences can fail to open (AEADBadTag / KeyStore
     * errors) when the prefs file survives but its Keystore master key does
     * not — e.g. after an app restore, data transfer or a Keystore reset. The
     * stored values are unreadable in that state anyway, so reset the file and
     * the master key once and recreate, instead of failing every save forever.
     */
    private fun openSecurePrefs(): SharedPreferences {
        try {
            return createSecurePrefs()
        } catch (first: Exception) {
            try {
                activity.deleteSharedPreferences(SECURE_PREFS_NAME)
            } catch (ignored: Exception) {
            }
            try {
                val ks = java.security.KeyStore.getInstance("AndroidKeyStore")
                ks.load(null)
                ks.deleteEntry("_androidx_security_master_key_")
            } catch (ignored: Exception) {
            }
            return createSecurePrefs()
        }
    }

    private val SECURE_PREFS_NAME = "android_save_secure_prefs"

    /**
     * Opens a URI directly. Used for the MediaStore `content://` URI on
     * API 29+, which already grants the receiving app read access without
     * needing a FileProvider.
     */
    private fun openUri(uriString: String, mimeType: String, grantPermission: Boolean) {
        try {
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(Uri.parse(uriString), mimeType)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (grantPermission) {
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
            }
            if (intent.resolveActivity(activity.packageManager) != null) {
                activity.startActivity(intent)
            }
        } catch (e: Exception) {
            // Opening is best-effort — the save itself already succeeded.
        }
    }

    /**
     * Opens a file saved via the legacy (API <= 28) path. Wraps it in a
     * FileProvider `content://` URI so the receiving app can read it without
     * sharing storage permissions; falls back to a bare `file://` URI if the
     * provider isn't set up correctly.
     */
    private fun openFile(file: File, mimeType: String) {
        try {
            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.androidsave.fileprovider",
                file
            )
            openUri(uri.toString(), mimeType, true)
        } catch (e: Exception) {
            openUri(Uri.fromFile(file).toString(), mimeType, false)
        }
    }
}
