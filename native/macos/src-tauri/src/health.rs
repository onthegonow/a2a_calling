use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager};

static CONNECTED: AtomicBool = AtomicBool::new(false);
static CURRENT_PORT: AtomicU16 = AtomicU16::new(0);

pub fn is_connected() -> bool {
    CONNECTED.load(Ordering::Relaxed)
}

pub fn current_port() -> u16 {
    CURRENT_PORT.load(Ordering::Relaxed)
}

pub fn set_connected(port: u16) {
    CURRENT_PORT.store(port, Ordering::Relaxed);
    CONNECTED.store(true, Ordering::Relaxed);
}

pub fn set_disconnected() {
    CONNECTED.store(false, Ordering::Relaxed);
}

/// Start background health check loop — emits "server-status" events
pub fn start_health_monitor(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let handle = app;
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;

            let port = CURRENT_PORT.load(Ordering::Relaxed);
            if port == 0 {
                continue;
            }

            let url = format!("http://127.0.0.1:{}/api/a2a/ping", port);
            let client = match reqwest::Client::builder()
                .timeout(Duration::from_millis(1500))
                .build() {
                Ok(c) => c,
                Err(_) => continue,
            };

            let ok = match client.get(&url).send().await {
                Ok(resp) => resp.status().is_success(),
                Err(_) => false,
            };

            let was_connected = CONNECTED.swap(ok, Ordering::Relaxed);

            // Only emit on state change
            if ok != was_connected {
                let _ = handle.emit("server-status", serde_json::json!({
                    "connected": ok,
                    "port": port
                }));
                // Navigate back to loader page on disconnect so reconnection UI is shown
                if !ok {
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.navigate("tauri://localhost".parse().unwrap());
                    }
                }
            }
        }
    });
}
