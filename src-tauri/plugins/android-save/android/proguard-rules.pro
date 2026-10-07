-keep class app.tauri.androidsave.** { *; }

# androidx.security:security-crypto pulls in Google Tink, which references
# compile-time-only annotation classes that are not shipped in the APK. R8
# (release minification) aborts with "Missing classes detected" unless told
# these are safe to ignore. They are annotations only; no runtime behavior.
-dontwarn javax.annotation.**
-dontwarn javax.annotation.concurrent.**
-dontwarn com.google.errorprone.annotations.**
-dontwarn org.checkerframework.**
-dontwarn com.google.crypto.tink.annotations.**
-dontwarn com.google.api.client.http.**
-dontwarn com.google.api.client.util.**
-dontwarn org.joda.time.**

# Keep Tink's key-manager reflection targets (EncryptedSharedPreferences).
-keep class com.google.crypto.tink.** { *; }
