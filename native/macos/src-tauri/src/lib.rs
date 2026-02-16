use tauri::Manager;

mod discovery;
mod server;

#[tauri::command]
async fn discover_server() -> Result<discovery::DiscoveryResult, String> {
    Ok(discovery::discover_server().await)
}

#[tauri::command]
fn start_server() -> Result<server::StartResult, String> {
    Ok(server::start_server())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![discover_server, start_server])
        .run(tauri::generate_context!())
        .expect("error while running A2A Callbook");
}
