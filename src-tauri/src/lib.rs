// Plugin registration for the desktop shell.
//
// - tauri-plugin-opener: backs `openExternal()` in `src/lib/desktop.ts`
//   (hands wa.me / external links to the OS default browser instead of
//   opening a second chrome-less webview), and `revealInFolder()`
//   (highlights a just-saved PDF/Excel file in Explorer).
// - tauri-plugin-fs: backs `saveToAppDocuments()` / `saveToInvoicesFolder()`,
//   which write straight to `Documents/TurfApp/...` with no Save dialog.
// - tauri-plugin-dialog: available for any native file/save dialogs used
//   elsewhere in the app.
// - tauri-plugin-android-save: backs `saveExportFile()` in
//   `src/lib/desktop.ts` — writes generated PDFs/Excel/backup files into the
//   public Downloads folder via MediaStore on Android, since the desktop
//   fs-scope writes and the dialog-plugin Save-As flow above both fail
//   there (see the plugin's own doc comment in
//   `plugins/android-save/src/lib.rs`). No-ops with an error on non-Android
//   targets, which the TS caller already treats as "fall back to the
//   desktop/browser path".
//
// Permissions for all three built-in plugins are scoped in
// `capabilities/default.json`; android-save's is scoped in
// `capabilities/mobile.json` (Android-only — it does nothing on desktop).

/// Backs `readTelegramConfig`/`writeTelegramConfig`'s token storage in
/// `src/lib/telegram-backup.ts`, and the passphrase storage in
/// `src/lib/backup-passphrase.ts`. Real desktop targets only (the `keyring`
/// crate has no Android backend — see its Cargo dependency's `target_os`
/// guard in `Cargo.toml`) — stores each secret in the OS credential store
/// (Windows Credential Manager / macOS Keychain / Secret Service via
/// libsecret on Linux) instead of plain localStorage. `telegram-backup.ts`
/// and `backup-passphrase.ts` already route Android and the browser build
/// around these three commands entirely, using their own localStorage
/// fallback, so they're only ever invoked on real desktop.
///
/// SECURITY: `service` is hardcoded, never accepted from the JS caller, and
/// `account` is checked against a fixed allowlist below rather than passed
/// straight into `keyring::Entry::new`. Earlier versions of these commands
/// took `service`/`account` straight from `invoke()` unchecked, which meant
/// *any* script running in the webview — not just this app's own code —
/// could read, overwrite, or delete an arbitrary named entry in the OS
/// credential store, not just this app's own secrets. Fixing that at the
/// CSP layer (see `tauri.conf.json`) closes the main way a malicious script
/// would get into the webview in the first place, but this command
/// shouldn't be a general credential-store read/write primitive even in
/// principle, so the target and the set of valid slots are both fixed here
/// too — defense in depth. Add a new slot by adding its name to
/// `ALLOWED_ACCOUNTS` below, not by accepting an arbitrary caller-supplied
/// name.
#[cfg(not(target_os = "android"))]
const KEYRING_SERVICE: &str = "turf-snack-ledger";
#[cfg(not(target_os = "android"))]
const ALLOWED_ACCOUNTS: &[&str] = &[
    "telegram-backup-token",
    "telegram-backup-extra-tokens",
    "backup-passphrase",
];

#[cfg(not(target_os = "android"))]
fn check_account(account: &str) -> Result<(), String> {
    if ALLOWED_ACCOUNTS.contains(&account) {
        Ok(())
    } else {
        Err("unknown credential slot".to_string())
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn keyring_get_token(account: String) -> Result<Option<String>, String> {
    use keyring::Entry;
    check_account(&account)?;
    let entry = Entry::new(KEYRING_SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn keyring_set_token(account: String, token: String) -> Result<(), String> {
    use keyring::Entry;
    check_account(&account)?;
    let entry = Entry::new(KEYRING_SERVICE, &account).map_err(|e| e.to_string())?;
    entry.set_password(&token).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn keyring_delete_token(account: String) -> Result<(), String> {
    use keyring::Entry;
    check_account(&account)?;
    let entry = Entry::new(KEYRING_SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.delete_password() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_android_save::init());

    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        keyring_get_token,
        keyring_set_token,
        keyring_delete_token
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
