use tauri::{Manager, RunEvent, WindowEvent};
use tauri::menu::{Menu, MenuItem, Submenu, PredefinedMenuItem, AboutMetadata};
use tauri_plugin_deep_link::DeepLinkExt;

mod discovery;
mod health;
mod notifications;
mod server;

#[tauri::command]
async fn discover_server() -> Result<discovery::DiscoveryResult, String> {
    let result = discovery::discover_server().await;
    if let Some(port) = result.port {
        health::set_connected(port);
    }
    Ok(result)
}

#[tauri::command]
fn start_server() -> Result<server::StartResult, String> {
    Ok(server::start_server())
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let about = PredefinedMenuItem::about(app, Some("About A2A Callbook"), Some(AboutMetadata {
        name: Some("A2A Callbook".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        ..Default::default()
    }))?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit A2A Callbook"))?;
    let hide = PredefinedMenuItem::hide(app, Some("Hide A2A Callbook"))?;
    let preferences = MenuItem::with_id(app, "preferences", "Preferences\u{2026}", true, Some("CmdOrCtrl+,"))?;
    let separator = PredefinedMenuItem::separator(app)?;

    let app_menu = Submenu::with_items(app, "A2A Callbook", true, &[
        &about, &separator, &preferences, &separator, &hide, &separator, &quit,
    ])?;

    // View menu with tab shortcuts
    let contacts = MenuItem::with_id(app, "tab-contacts", "Contacts", true, Some("CmdOrCtrl+1"))?;
    let calls = MenuItem::with_id(app, "tab-calls", "Calls", true, Some("CmdOrCtrl+2"))?;
    let logs = MenuItem::with_id(app, "tab-logs", "Logs", true, Some("CmdOrCtrl+3"))?;
    let settings = MenuItem::with_id(app, "tab-settings", "Settings", true, Some("CmdOrCtrl+4"))?;
    let invites = MenuItem::with_id(app, "tab-invites", "Invites", true, Some("CmdOrCtrl+5"))?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, Some("CmdOrCtrl+R"))?;

    let view_menu = Submenu::with_items(app, "View", true, &[
        &contacts, &calls, &logs, &settings, &invites, &sep2, &refresh,
    ])?;

    // Edit menu (standard macOS)
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit_menu = Submenu::with_items(app, "Edit", true, &[
        &cut, &copy, &paste, &select_all,
    ])?;

    let window_menu = Submenu::with_items(app, "Window", true, &[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::close_window(app, Some("Hide Window"))?,
    ])?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![discover_server, start_server])
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            // Handle menu events
            let app_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().0.as_str();
                let tab = match id {
                    "tab-contacts" => Some("contacts"),
                    "tab-calls" => Some("calls"),
                    "tab-logs" => Some("logs"),
                    "tab-settings" => Some("settings"),
                    "tab-invites" => Some("invites"),
                    "preferences" => Some("settings"),
                    "refresh" => {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.eval("window.location.reload()");
                        }
                        None
                    }
                    _ => None,
                };

                if let Some(tab_name) = tab {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let js = format!("window.location.hash = '{}'", tab_name);
                        let _ = window.eval(&js);
                    }
                }
            });

            // Start background health monitor
            health::start_health_monitor(app.handle().clone());

            // Start notification poller
            notifications::start_notification_poller(app.handle().clone());

            // Handle a2a:// deep links
            let deep_link_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                for url in urls {
                    let url_str = url.to_string();
                    // a2a://host/callbook/CODE or a2a://host/fed_TOKEN
                    if let Some(window) = deep_link_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                        // Pass URL to the SPA via JS
                        let js = format!(
                            "window.__A2A_DEEP_LINK = '{}'; \
                             window.dispatchEvent(new CustomEvent('a2a-deep-link', {{ detail: '{}' }}))",
                            url_str.replace('\\', "\\\\").replace('\'', "\\'"),
                            url_str.replace('\\', "\\\\").replace('\'', "\\'")
                        );
                        let _ = window.eval(&js);
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building A2A Callbook");

    // Cmd+W hides window instead of quitting
    app.run(|app_handle, event| {
        if let RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } = &event {
            api.prevent_close();
            if let Some(window) = app_handle.get_webview_window(label) {
                let _ = window.hide();
            }
        }
    });
}
