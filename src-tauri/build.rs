fn main() {
    // Re-embed the Windows exe icon whenever the icon files change, so a cached
    // build can never keep shipping an older (or Tauri's default) icon.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
