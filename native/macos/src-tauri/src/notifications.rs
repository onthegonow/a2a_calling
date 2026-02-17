use futures_util::StreamExt;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

static LAST_EVENT_ID: AtomicU64 = AtomicU64::new(0);
static UNREAD_COUNT: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, serde::Deserialize)]
struct DashboardEvent {
    id: Option<u64>,
    #[serde(rename = "type")]
    event_type: Option<String>,
    payload: Option<serde_json::Value>,
}

fn maybe_set_dock_badge(app: &tauri::AppHandle, count: usize) {
    // Best effort: use the main window badge API. On macOS this maps to Dock badge label/count.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_count(if count == 0 { None } else { Some(count as i64) });
    }
}

fn show_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

fn process_dashboard_event(app: &tauri::AppHandle, raw: &str) {
    let parsed: DashboardEvent = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => return,
    };

    if let Some(id) = parsed.id {
        let current = LAST_EVENT_ID.load(Ordering::Relaxed);
        if id > current {
            LAST_EVENT_ID.store(id, Ordering::Relaxed);
        }
    }

    let event_type = parsed.event_type.unwrap_or_default();
    let payload = parsed.payload.unwrap_or_else(|| serde_json::json!({}));

    if event_type == "call.inbound" {
        let caller = payload
            .get("caller_name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown agent");
        show_notification(
            app,
            &format!("Inbound call from {}", caller),
            "Open A2A Callbook to respond.",
        );
        let unread = UNREAD_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
        maybe_set_dock_badge(app, unread);
        return;
    }

    if event_type == "summary.completed" {
        let contact = payload
            .get("contact_name")
            .and_then(|v| v.as_str())
            .unwrap_or("conversation");
        show_notification(
            app,
            "Summary complete",
            &format!("Conversation with {} has a summary.", contact),
        );
        let unread = UNREAD_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
        maybe_set_dock_badge(app, unread);
        return;
    }
}

/// Connect to server-driven dashboard SSE and map events to native notifications.
pub fn start_event_stream_listener(app: tauri::AppHandle) {
    tokio::spawn(async move {
        // Wait for initial discovery attempt.
        tokio::time::sleep(Duration::from_secs(2)).await;

        loop {
            if !crate::health::is_connected() {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            let port = crate::health::current_port();
            if port == 0 {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }

            let url = format!("http://127.0.0.1:{}/api/a2a/dashboard/events?replay=50", port);
            let client = match reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
            {
                Ok(c) => c,
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };

            let mut req = client
                .get(&url)
                .header("Accept", "text/event-stream");
            let last_id = LAST_EVENT_ID.load(Ordering::Relaxed);
            if last_id > 0 {
                req = req.header("Last-Event-ID", last_id.to_string());
            }

            let response = match req.send().await {
                Ok(resp) => resp,
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };
            if !response.status().is_success() {
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }

            // On first connect we intentionally suppress replay notifications.
            // IDs are still tracked so reconnects can resume reliably.
            let mut suppress_replay_notifications = LAST_EVENT_ID.load(Ordering::Relaxed) == 0;
            let mut stream = response.bytes_stream();
            let mut buffer = String::new();
            let mut data_lines: Vec<String> = Vec::new();

            while let Some(chunk) = stream.next().await {
                let bytes = match chunk {
                    Ok(value) => value,
                    Err(_) => break,
                };
                let piece = String::from_utf8_lossy(&bytes);
                buffer.push_str(&piece);

                while let Some(pos) = buffer.find('\n') {
                    let mut line: String = buffer.drain(..=pos).collect();
                    line = line.trim_end_matches('\n').trim_end_matches('\r').to_string();

                    if line.is_empty() {
                        if !data_lines.is_empty() {
                            let data = data_lines.join("\n");
                            if !suppress_replay_notifications {
                                process_dashboard_event(&app, &data);
                            }
                            data_lines.clear();
                        }
                        continue;
                    }
                    if line.starts_with(':') {
                        if line.starts_with(": connected") {
                            suppress_replay_notifications = false;
                        }
                        continue;
                    }
                    if let Some(rest) = line.strip_prefix("id:") {
                        let value = rest.trim();
                        if let Ok(parsed) = value.parse::<u64>() {
                            let current = LAST_EVENT_ID.load(Ordering::Relaxed);
                            if parsed > current {
                                LAST_EVENT_ID.store(parsed, Ordering::Relaxed);
                            }
                        }
                        continue;
                    }
                    if let Some(rest) = line.strip_prefix("data:") {
                        data_lines.push(rest.trim().to_string());
                    }
                }
            }

            // Connection dropped: reconnect with jitter.
            tokio::time::sleep(Duration::from_millis(900)).await;
        }
    });
}
