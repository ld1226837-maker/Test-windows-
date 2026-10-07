const COMMANDS: &[&str] = &[
    "save_to_downloads",
    "open_private_file",
    "copy_uri_to_private_file",
    "delete_private_file",
    "cleanup_pending_exports",
    "secure_set",
    "secure_get",
    "secure_delete",
    "print_pdf",
    "start_stream_save",
    "append_stream_save",
    "finish_stream_save",
    "abort_stream_save",
    "request_camera_permission",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
