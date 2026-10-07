package app.tauri.androidsave

import androidx.core.content.FileProvider

/**
 * Trivial subclass of [FileProvider] whose only purpose is to give this
 * plugin's <provider> manifest entry a class name distinct from
 * `androidx.core.content.FileProvider`.
 *
 * Why this exists: the app's own auto-generated manifest already declares a
 * <provider android:name="androidx.core.content.FileProvider"> (for its own
 * `${applicationId}.fileprovider` authority). Android's manifest merger
 * identifies <provider> entries by android:name, not by authority — so if
 * this plugin's manifest also names the raw `androidx.core.content.FileProvider`
 * class (even with a different authority), the merger sees two conflicting
 * declarations of "the same" component and the build fails. Subclassing
 * gives this entry its own class identity, so it merges cleanly alongside
 * the app's provider instead of colliding with it.
 *
 * This class intentionally adds no behavior — FileProvider's own logic
 * (driven entirely by the authority string and the `android_save_file_paths.xml`
 * meta-data) is all that's needed. Do not remove this class or point the
 * manifest back at the raw FileProvider class; see
 * docs/android-port-notes.md for the crash this file also fixes.
 */
class AndroidSaveFileProvider : FileProvider()
