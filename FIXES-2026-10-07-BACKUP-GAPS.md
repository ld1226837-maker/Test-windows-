# Backup status / progress / camera: gap fixes (2026-10-07)

Applied identically to the Android and Windows trees.

1. Camera: `request_camera_permission` command in the android-save plugin (Rust, Kotlin `@Permission` flow, permissions toml); `ensureCameraPermission()` is called before `getUserMedia` on Android.
2. QrScannerDialog: ticket-based start (Retry camera and fast Switch camera now work), relaxed-constraint fallback for OverconstrainedError/NotFoundError, scan failures logged by code only.
3. OperationProgressBar: View log, Retry, Dismiss; warning/error banners persist; live 429 countdown (uploads and downloads); app-wide sticky bar in AppStatusStrip (hidden when an inline bar is on screen); "Backing up 3/7".
4. operation-progress: wake lock re-acquire/leak fixed; beforeunload desktop-only; Android back button guarded; guard released as soon as the result is set; late progress callbacks ignored.
5. backup-log: storage oldest-first (ring buffer drops the oldest), pure getSnapshot, heartbeat-based interrupted detection safe for a second window.
6. Parser accepts `bot<TOKEN>?query` URLs (and an explicit chat_id parameter).
7. Status chip colors + icons; log sheet shows retryAfter and animates the running spinner.
8. Tests: backup-log-integrity, operation-progress lifecycle, telegram-scan additions.

Not run here (no node_modules / network): typecheck:all, lint, vitest, build, cargo check, Gradle. Run the full gate before release.

9. Follow-up: restore-by-message fetch is now cancellable and reports 429 waits; the Android back guard removes its extra history entry when the run ends.
